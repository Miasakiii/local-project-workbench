import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeleteEntriesResult, FileOperationItem, FileOperationReason } from '@shared/types'
import { isProtectedEntry, type PathRejection, resolveProjectPath } from '../security/path-guard'

/**
 * 文件访问模块 —— 删除与失败处理（设计稿第 7 章，推进计划 M0-5）。
 *
 * 三条不可协商的规则：
 * 1. **删除一律进系统回收站。** 回收站不可用时**停止并说明**，绝不降级为永久删除
 *    （风险 R6）。
 * 2. **逐项报告。** 批量操作按项记录成功、失败与未执行，不给出统一成功提示。
 * 3. **源文件优先。** 任何失败都保留源文件，不请求管理员权限，不做无法真正完成的
 *    撤销承诺。
 *
 * 回收站能力通过参数注入（`TrashFn`），因此本模块不导入 Electron，可在纯 Node 下
 * 测试；主进程注入 `shell.trashItem`。
 */

/** 回收站能力。主进程注入 `shell.trashItem`。 */
export type TrashFn = (absolutePath: string) => Promise<void>

/** 单次批量操作的项数上限，防止误操作放大到不可收拾的规模。 */
export const MAX_BATCH_ITEMS = 500

/** 已知的「项级」错误码：属于该目标自身的问题，不影响后续项继续执行。 */
const ITEM_LEVEL_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EBUSY',
  'ENOTEMPTY',
  'EEXIST',
  'EROFS',
  'EISDIR',
  'ENOTDIR',
  'ENAMETOOLONG',
  'EMFILE',
  'ENFILE'
])

interface ClassifiedError {
  reason: FileOperationReason
  message: string
}

function rawMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : null
}

/** 把 Node 的 errno 映射为面向用户的失败原因。 */
export function classifyError(error: unknown): ClassifiedError {
  const code = codeOf(error)
  const raw = rawMessageOf(error)

  switch (code) {
    case 'ENOENT':
      return { reason: 'not-found', message: `目标不存在或已被移动，未执行删除：${raw}` }
    case 'EACCES':
    case 'EPERM':
      return { reason: 'permission-denied', message: `没有权限完成该操作，源文件已保留：${raw}` }
    case 'EBUSY':
    case 'ENOTEMPTY':
    case 'EEXIST':
      return { reason: 'in-use', message: `目标被占用或目录非空，源文件已保留：${raw}` }
    case 'EROFS':
      return { reason: 'read-only', message: `目标位于只读位置，源文件已保留：${raw}` }
    default:
      return { reason: 'io-error', message: raw }
  }
}

/**
 * 判断回收站失败是否属于「回收站整体不可用」。
 *
 * 实测结论（见 M0 验证记录 M0-5）：Electron 的 `shell.trashItem` 在文件被独占
 * 句柄占用时抛出的是**不带错误码**的 `Error: Operation was aborted`，与「回收站
 * 不可用」在错误码层面无法区分。因此判定分三步：
 *
 *   1. 错误码属于已知项级问题（无权限、被占用等）→ 按项处理。
 *   2. 错误信息明确指向回收站不支持 → 判为不可用。
 *   3. 其余情况用「目标当前是否可访问」区分：目标可读却无法送入回收站，
 *      说明问题在回收站而非目标；目标不可读则属于项级问题。
 */
export interface TrashFailureDecision {
  /** 是否应中止整批操作 */
  abort: boolean
  reason: FileOperationReason
  message: string
}

/** 探测目标当前是否可访问（文件与目录均适用）。 */
function probeAccessible(
  absolutePath: string
): { accessible: true } | { accessible: false; reason: FileOperationReason; message: string } {
  try {
    const handle = openSync(absolutePath, 'r')
    closeSync(handle)
    return { accessible: true }
  } catch (error) {
    const classified = classifyError(error)
    return {
      accessible: false,
      reason: classified.reason === 'io-error' ? 'in-use' : classified.reason,
      message: classified.message
    }
  }
}

export function discriminateTrashFailure(absolutePath: string, error: unknown): TrashFailureDecision {
  const code = codeOf(error)
  const raw = rawMessageOf(error)

  if (code !== null && ITEM_LEVEL_CODES.has(code)) {
    const classified = classifyError(error)
    return { abort: false, reason: classified.reason, message: classified.message }
  }

  if (/not supported|unsupported|not implemented|recycle|trash|回收站/i.test(raw)) {
    return { abort: true, reason: 'trash-unavailable', message: `无法发送到系统回收站：${raw}` }
  }

  const probe = probeAccessible(absolutePath)
  if (!probe.accessible) {
    return {
      abort: false,
      reason: probe.reason,
      message: `无法发送到系统回收站（${probe.message}），源文件已保留。`
    }
  }

  return { abort: true, reason: 'trash-unavailable', message: `无法发送到系统回收站：${raw}` }
}

/** 兼容旧调用：仅判断「回收站不可用」。 */
export function isTrashUnavailable(absolutePath: string, error: unknown): boolean {
  return discriminateTrashFailure(absolutePath, error).abort
}

/**
 * 文件操作层的路径拒绝码：沿用 path-guard 的取值，并补充 `invalid-path`
 * 用于「形态检查未通过但无法归入具体原因」的情形。
 */
type FileRejection = PathRejection | 'invalid-path'

function reasonForRejection(rejection: FileRejection): FileOperationReason {
  switch (rejection) {
    case 'traversal':
    case 'outside-project':
    case 'absolute':
    case 'drive-relative':
    case 'unc':
      return 'outside-project'
    case 'not-found':
      return 'not-found'
    default:
      return 'invalid-path'
  }
}

function messageForRejection(rejection: FileRejection, relativePath: string): string {
  switch (rejection) {
    case 'outside-project':
    case 'traversal':
      return `目标位于项目之外或经链接指向项目外，未执行：${relativePath}`
    case 'absolute':
    case 'drive-relative':
    case 'unc':
      return `不接受绝对路径、盘符或 UNC 写法，未执行：${relativePath}`
    case 'not-found':
      return `目标不存在：${relativePath}`
    default:
      return `路径不合法，未执行：${relativePath}`
  }
}

export interface DeleteEntriesRequest {
  projectRoot: string
  /** 待删除的项目内相对路径（文件或文件夹） */
  relativePaths: string[]
  /** 项目是否已被用户信任；不可信项目默认只读浏览（设计稿第 7 章） */
  trusted: boolean
  trash: TrashFn
}

function summarize(items: FileOperationItem[]): DeleteEntriesResult {
  let ok = 0
  let failed = 0
  let skipped = 0
  for (const item of items) {
    if (item.status === 'ok') ok += 1
    else if (item.status === 'failed') failed += 1
    else skipped += 1
  }
  return { items, ok, failed, skipped, aborted: false, abortReason: null, abortMessage: null }
}

/**
 * 把项目内若干路径发送到系统回收站。
 *
 * 返回值按项列出结果。整批中止时（`aborted` 为真）未执行的项标记为 `skipped`，
 * 已成功的项保持成功，界面据此说明「哪些做了、哪些没做」。
 */
export async function deleteEntries(request: DeleteEntriesRequest): Promise<DeleteEntriesResult> {
  const items: FileOperationItem[] = []

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

    // 项目根与 .git 元数据不从普通文件操作入口提供破坏性操作
    if (isProtectedEntry(relativePath)) {
      items.push({
        relativePath,
        status: 'skipped',
        reason: 'protected-entry',
        message: relativePath.trim().length === 0 ? '项目根目录不允许删除。' : '项目根目录与 Git 元数据不提供删除操作。'
      })
      continue
    }

    const resolution = resolveProjectPath(request.projectRoot, relativePath, { mustExist: true })
    if (!resolution.ok || resolution.absolutePath === null) {
      const rejection = resolution.rejection ?? 'invalid-path'
      items.push({
        relativePath,
        status: 'failed',
        reason: reasonForRejection(rejection),
        message: messageForRejection(rejection, relativePath)
      })
      continue
    }

    // 复核目标类型：目录联接本身也是目录，但仍按项处理
    try {
      lstatSync(resolution.absolutePath)
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

    try {
      await request.trash(resolution.absolutePath)
    } catch (error) {
      const decision = discriminateTrashFailure(resolution.absolutePath, error)

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
    if (existsSync(resolution.absolutePath)) {
      items.push({
        relativePath,
        status: 'failed',
        reason: 'io-error',
        message: '回收站操作已返回，但目标仍然存在，未确认删除成功。'
      })
      continue
    }

    items.push({
      relativePath: resolution.normalized,
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
