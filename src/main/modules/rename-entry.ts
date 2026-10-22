import { existsSync, lstatSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FileOperationReason, RenameEntryResult } from '@shared/types'
import { isSameLocation } from '../security/path-guard'
import { normalizeRenameName } from './entry-name'
import type { BeforeExecuteHook } from './file-op-common'
import { reasonForRejection } from './file-op-common'
import { classifyWriteError, codeOf, rawMessageOf } from './file-op-errors'
import {
  captureFileIdentity,
  fileFingerprintUnchanged,
  fileIdentityUnchanged,
  resolveForWrite,
  sameFileIdentity,
  type WriteGuardWording,
  writtenTargetIntact
} from './write-guard'

/**
 * 重命名入口 —— 在同一父目录内重命名单个文件或文件夹
 * （从 `file-access.ts` 拆出，行为不变）。
 *
 * 安全与一致性边界：
 * - 只接受项目内相对路径和单段新名称，不接受跨目录移动；
 * - 写操作拒绝经过符号链接或目录联接的路径，避免把链接目标误当成链接本身；
 * - 解析、冲突检查和真实路径复核均在执行前完成，执行后再次确认磁盘状态；
 * - 路径 API 无法消除全部 TOCTOU 窗口，任何执行后无法确认的情况都不报告成功。
 */

export interface RenameEntryRequest {
  projectRoot: string
  /** 待重命名的项目内相对路径 */
  relativePath: string
  /** 同一父目录内的新名称；不接受路径分隔符 */
  newName: unknown
  /** 不可信项目默认只读 */
  trusted: boolean
  /** 执行前钩子；仅验证脚本注入（见 BeforeExecuteHook） */
  beforeExecute?: BeforeExecuteHook
}

function renameFailure(
  relativePath: string,
  targetRelativePath: string | null,
  reason: FileOperationReason,
  message: string,
  status: 'failed' | 'skipped' = 'failed'
): RenameEntryResult {
  return { relativePath, targetRelativePath, status, reason, message }
}

/** 重命名入口的守卫文案：源项与目标名各一套。 */
const RENAME_SOURCE_WORDING: WriteGuardWording = {
  viaReparsePoint: '写操作不支持经过符号链接或目录联接的路径，未执行重命名。',
  protectedEntry: () => '项目根目录与 Git 元数据不提供重命名。',
  unresolvable: (_input, rejection, detail) => ({
    reason: reasonForRejection(rejection),
    message: `源项无法用于重命名：${detail}`
  })
}

const RENAME_TARGET_WORDING: WriteGuardWording = {
  viaReparsePoint: '写操作不支持经过符号链接或目录联接的路径，未执行重命名。',
  protectedEntry: () => '不能把文件或文件夹重命名为项目根目录或 Git 元数据。',
  unresolvable: (_input, _rejection, detail) => ({
    reason: 'outside-project',
    message: `目标路径无法用于重命名：${detail}`
  })
}

export function renameEntry(request: RenameEntryRequest): RenameEntryResult {
  const sourceInput = request.relativePath
  if (!request.trusted) {
    return renameFailure(
      sourceInput,
      null,
      'untrusted-project',
      '该项目尚未被信任，当前为只读浏览状态，未执行任何重命名。',
      'skipped'
    )
  }

  const name = normalizeRenameName(request.newName)
  if (!name.ok) return renameFailure(sourceInput, null, 'invalid-path', name.message)

  const source = resolveForWrite(request.projectRoot, sourceInput, {
    mustExist: true,
    wording: RENAME_SOURCE_WORDING
  })
  if (!source.ok) {
    return renameFailure(sourceInput, null, source.reason, source.message, source.status)
  }

  const sourceRelative = source.relativePath
  const separator = sourceRelative.lastIndexOf('/')
  const parentRelative = separator < 0 ? '' : sourceRelative.slice(0, separator)
  const targetRelative = parentRelative.length === 0 ? name.normalized : `${parentRelative}/${name.normalized}`

  const target = resolveForWrite(request.projectRoot, targetRelative, {
    mustExist: false,
    wording: RENAME_TARGET_WORDING
  })
  if (!target.ok) {
    return renameFailure(sourceInput, targetRelative, target.reason, target.message, target.status)
  }

  try {
    lstatSync(source.absolutePath)
  } catch (error) {
    return renameFailure(
      sourceInput,
      targetRelative,
      'path-changed',
      `源项在执行前发生变化，未执行重命名：${rawMessageOf(error)}`
    )
  }

  try {
    lstatSync(target.absolutePath)
    return renameFailure(
      sourceInput,
      targetRelative,
      'name-conflict',
      `目标名称已存在，未覆盖现有项：${targetRelative}`
    )
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      const classified = classifyWriteError(error, '重命名')
      return renameFailure(sourceInput, targetRelative, classified.reason, classified.message)
    }
  }

  if (!isSameLocation(dirname(source.absolutePath), dirname(target.absolutePath))) {
    return renameFailure(
      sourceInput,
      targetRelative,
      'path-changed',
      '源项与目标父目录在执行前已发生变化，未执行重命名。'
    )
  }

  // 身份快照：源项物理身份 + 目标必须仍不存在（A1／R9）。
  // renameSync 在 Windows 上会静默覆盖已存在的目标，仅靠 existsSync 预检挡不住
  // 「检查后、执行前目标被创建」；物理身份不一致时一律拒绝。
  const sourceIdentity = captureFileIdentity(source.absolutePath)
  const targetIdentity = captureFileIdentity(target.absolutePath)

  request.beforeExecute?.({ operation: 'rename', targetAbsolutePath: target.absolutePath })

  if (
    !fileIdentityUnchanged(sourceIdentity, source.absolutePath) ||
    !fileFingerprintUnchanged(sourceIdentity, source.absolutePath) ||
    !fileIdentityUnchanged(targetIdentity, target.absolutePath)
  ) {
    return renameFailure(sourceInput, targetRelative, 'path-changed', '源项或目标名称在执行前发生变化，未执行重命名。')
  }

  try {
    renameSync(source.absolutePath, target.absolutePath)
  } catch (error) {
    const classified = classifyWriteError(error, '重命名')
    return renameFailure(sourceInput, targetRelative, classified.reason, classified.message)
  }

  // 执行后复核：不能把「系统调用返回」直接等同于「用户可确认的成功」。
  // A1 身份维度：目标必须就是已验证的那个源文件对象（rename 保留文件记录号）。
  if (
    !sameFileIdentity(captureFileIdentity(target.absolutePath), sourceIdentity) ||
    !writtenTargetIntact(request.projectRoot, targetRelative, 'any', target.absolutePath, () =>
      existsSync(source.absolutePath)
    )
  ) {
    return renameFailure(
      sourceInput,
      targetRelative,
      'path-changed',
      '重命名调用已返回，但磁盘状态无法安全确认；请检查源项与目标项后再继续。'
    )
  }

  return {
    relativePath: sourceRelative,
    targetRelativePath: targetRelative,
    status: 'ok',
    reason: null,
    message: `已将 ${sourceRelative} 重命名为 ${targetRelative}。`
  }
}
