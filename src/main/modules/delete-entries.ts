import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeleteEntriesResult } from '@shared/types'
import type { BeforeExecuteHook, TrashFn } from './file-op-common'
import { MAX_BATCH_ITEMS, messageForRejection, operationItem, reasonForRejection, summarize } from './file-op-common'
import { classifyError, discriminateTrashFailure, rawMessageOf } from './file-op-errors'
import {
  captureFileIdentity,
  fileFingerprintUnchanged,
  fileIdentityUnchanged,
  resolveForWrite,
  type WriteGuardWording
} from './write-guard'

/**
 * 删除入口 —— 把项目内若干路径发送到系统回收站（设计稿第 7 章）。
 *
 * 从 `file-access.ts` 拆出（重构，行为不变）。三条不可协商的规则：
 * 1. **删除一律进系统回收站。** 回收站不可用时**停止并说明**，绝不降级为永久删除
 *    （风险 R6）。
 * 2. **逐项报告。** 批量操作按项记录成功、失败与未执行，不给出统一成功提示。
 * 3. **源文件优先。** 任何失败都保留源文件，不请求管理员权限，不做无法真正完成的
 *    撤销承诺。
 *
 * 回收站能力通过参数注入（`TrashFn`），因此本模块不导入 Electron，可在纯 Node 下
 * 测试；主进程注入 `shell.trashItem`。
 */

export interface DeleteEntriesRequest {
  projectRoot: string
  /** 待删除的项目内相对路径（文件或文件夹） */
  relativePaths: string[]
  /** 项目是否已被用户信任；不可信项目默认只读浏览（设计稿第 7 章） */
  trusted: boolean
  trash: TrashFn
  /** 执行前钩子；仅验证脚本注入（见 BeforeExecuteHook） */
  beforeExecute?: BeforeExecuteHook
}

/** 删除入口的守卫文案。 */
const DELETE_WORDING: WriteGuardWording = {
  viaReparsePoint: '写操作不支持经过符号链接或目录联接的路径，未执行删除。',
  protectedEntry: (normalized) =>
    normalized.trim().length === 0 ? '项目根目录不允许删除。' : '项目根目录与 Git 元数据不提供删除操作。',
  unresolvable: (input, rejection) => ({
    reason: reasonForRejection(rejection),
    message: messageForRejection(rejection, input)
  })
}

/**
 * 把项目内若干路径发送到系统回收站。
 *
 * 返回值按项列出结果。整批中止时（`aborted` 为真）未执行的项标记为 `skipped`，
 * 已成功的项保持成功，界面据此说明「哪些做了、哪些没做」。
 */
export async function deleteEntries(request: DeleteEntriesRequest): Promise<DeleteEntriesResult> {
  const items: DeleteEntriesResult['items'] = []

  if (!request.trusted) {
    return {
      items: [],
      ok: 0,
      failed: 0,
      skipped: 0,
      aborted: true,
      abortReason: 'untrusted-project',
      abortMessage: '该项目尚未被信任，当前为只读浏览状态，未执行任何删除操作。'
    }
  }

  // 去重但保留顺序，避免同一路径被处理两次
  const uniquePaths = [...new Set(request.relativePaths.map((item) => String(item)))]
  if (uniquePaths.length === 0) {
    return {
      items: [],
      ok: 0,
      failed: 0,
      skipped: 0,
      aborted: true,
      abortReason: 'invalid-path',
      abortMessage: '没有需要删除的项。'
    }
  }
  if (uniquePaths.length > MAX_BATCH_ITEMS) {
    return {
      items: [],
      ok: 0,
      failed: 0,
      skipped: 0,
      aborted: true,
      abortReason: 'invalid-path',
      abortMessage: `单次操作最多处理 ${MAX_BATCH_ITEMS} 项，当前为 ${uniquePaths.length} 项。请分批执行。`
    }
  }

  for (let index = 0; index < uniquePaths.length; index += 1) {
    const relativePath = uniquePaths[index] as string

    // 项目根与 .git 元数据不提供删除；判定含归一化后的复查，见 resolveForWrite
    const target = resolveForWrite(request.projectRoot, relativePath, {
      mustExist: true,
      wording: DELETE_WORDING
    })
    if (!target.ok) {
      items.push(operationItem(relativePath, target.status, target.reason, target.message))
      continue
    }

    // 复核目标类型：目录联接本身也是目录，但仍按项处理
    try {
      lstatSync(target.absolutePath)
    } catch (error) {
      const classified = classifyError(error)
      items.push({
        relativePath,
        status: 'failed',
        reason: classified.reason,
        message: classified.message
      })
      continue
    }

    // 身份快照：送进回收站的必须是解析时那一个物理文件（A1／R9）。
    // realpath 等价复核看不出「删除后建同名文件」，dev+ino 可以。
    const targetIdentity = captureFileIdentity(target.absolutePath)
    request.beforeExecute?.({ operation: 'delete', targetAbsolutePath: target.absolutePath })
    if (
      !fileIdentityUnchanged(targetIdentity, target.absolutePath) ||
      !fileFingerprintUnchanged(targetIdentity, target.absolutePath)
    ) {
      items.push({
        relativePath,
        status: 'failed',
        reason: 'path-changed',
        message: '目标在执行前发生变化，未执行删除。'
      })
      continue
    }

    try {
      await request.trash(target.absolutePath)
    } catch (error) {
      const decision = discriminateTrashFailure(target.absolutePath, error)

      if (decision.abort) {
        // 回收站不可用：停止整批操作，不降级为永久删除
        items.push({
          relativePath,
          status: 'failed',
          reason: 'trash-unavailable',
          message: decision.message
        })
        for (let rest = index + 1; rest < uniquePaths.length; rest += 1) {
          items.push({
            relativePath: uniquePaths[rest] as string,
            status: 'skipped',
            reason: 'trash-unavailable',
            message: '因回收站不可用，该项未执行。'
          })
        }
        const summary = summarize(items)
        return {
          ...summary,
          aborted: true,
          abortReason: 'trash-unavailable',
          abortMessage:
            '系统回收站当前不可用，删除已停止。应用不会改用永久删除；请在系统设置中检查回收站后重试，或改用资源管理器手动删除。'
        }
      }

      items.push({
        relativePath,
        status: 'failed',
        reason: decision.reason,
        message: decision.message
      })
      continue
    }

    // 磁盘确认：只有目标确实不存在了才报告成功（设计稿第 7 章）
    if (existsSync(target.absolutePath)) {
      items.push({
        relativePath,
        status: 'failed',
        reason: 'io-error',
        message: '回收站操作已返回，但目标仍然存在，未确认删除成功。'
      })
      continue
    }

    items.push({
      relativePath: target.relativePath,
      status: 'ok',
      reason: null,
      message: '已发送到系统回收站。'
    })
  }

  return summarize(items)
}

export interface TrashProbeResult {
  available: boolean
  message: string
}

/**
 * 回收站可用性探测（诊断用，不参与删除主流程）。
 *
 * 在系统临时目录创建探针文件并尝试送入回收站。主流程不做预检，
 * 因为预检本身会在回收站留下一个文件；不可用的情况由首次失败触发中止。
 */
export async function probeTrashAvailability(trash: TrashFn): Promise<TrashProbeResult> {
  let directory: string | null = null
  try {
    directory = mkdtempSync(join(tmpdir(), 'workbench-trash-probe-'))
    const probePath = join(directory, 'probe.tmp')
    writeFileSync(probePath, 'workbench trash probe')
    await trash(probePath)
    if (existsSync(probePath)) {
      return { available: false, message: '探针文件仍存在，回收站操作未生效。' }
    }
    return { available: true, message: '系统回收站可用。' }
  } catch (error) {
    return { available: false, message: `系统回收站不可用：${rawMessageOf(error)}` }
  } finally {
    if (directory !== null) {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch {
        // 目录可能已被回收站操作一并处理，忽略
      }
    }
  }
}
