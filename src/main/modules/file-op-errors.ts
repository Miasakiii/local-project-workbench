import { closeSync, openSync } from 'node:fs'
import type { FileOperationReason } from '@shared/types'

/**
 * 文件操作的错误翻译层 —— 把 Node errno 与回收站失败映射为面向用户的失败原因。
 *
 * 从 `file-access.ts` 拆出（重构，行为不变）：这里只做「错误 → 原因 + 文案」的翻译，
 * 不感知任何具体操作流程；`file-access.ts` 的四个写入口经此获得统一的失败措辞。
 *
 * 本模块不导入 Electron，可在纯 Node 下测试（`verify-file-ops-m0.mts` 即直接断言
 * `classifyError` 与 `discriminateTrashFailure`）。
 */

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

/** 取错误的原始消息文本；供各入口在「执行前发生变化」等措辞里引用。 */
export function rawMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 取 NodeJS.ErrnoException 的错误码；非该类错误返回 null。 */
export function codeOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : null
}

/**
 * errno 的解释语境。
 *
 * 同一错误码在两类专业操作里含义不同：送入回收站失败时 `EEXIST`/`ENOTEMPTY` 指向
 * 目标自身被占用（回收站无法安置它）；写入目标时它们指向「目标名称已被占用」。
 * 因此映射按语境分列在同一张表里——历史上这两处曾各自维护而悄悄分歧。
 */
type ErrnoContext = 'trash' | 'write'

const ERRNO_REASONS: Record<ErrnoContext, Record<string, FileOperationReason>> = {
  trash: {
    ENOENT: 'not-found',
    EACCES: 'permission-denied',
    EPERM: 'permission-denied',
    EBUSY: 'in-use',
    ENOTEMPTY: 'in-use',
    EEXIST: 'in-use',
    EROFS: 'read-only'
  },
  write: {
    EEXIST: 'name-conflict',
    ENOTEMPTY: 'name-conflict',
    ENOENT: 'not-found',
    EACCES: 'permission-denied',
    EPERM: 'permission-denied',
    EBUSY: 'in-use',
    EROFS: 'read-only'
  }
}

/** 面向用户的说明。`action` 只在 write 语境参与措辞（「新建文件」「复制」等）。 */
type ErrnoMessageBuilder = (action: string, raw: string) => string

const ERRNO_MESSAGES: Record<ErrnoContext, Partial<Record<FileOperationReason, ErrnoMessageBuilder>>> = {
  trash: {
    'not-found': (_action, raw) => `目标不存在或已被移动，未执行删除：${raw}`,
    'permission-denied': (_action, raw) => `没有权限完成该操作，源文件已保留：${raw}`,
    'in-use': (_action, raw) => `目标被占用或目录非空，源文件已保留：${raw}`,
    'read-only': (_action, raw) => `目标位于只读位置，源文件已保留：${raw}`,
    'io-error': (_action, raw) => raw
  },
  write: {
    'name-conflict': (_action, raw) => `目标名称已存在，未覆盖现有项：${raw}`,
    'not-found': (action, raw) => `${action}所需的源项或目标父目录不存在，源项已保留：${raw}`,
    'permission-denied': (action, raw) => `没有权限完成${action}，源项已保留：${raw}`,
    'in-use': (action, raw) => `${action}所需的源项或目标目录被占用，源项已保留：${raw}`,
    'read-only': (action, raw) => `${action}目标位于只读位置，源项已保留：${raw}`,
    'io-error': (action, raw) => `${action}失败，源项已保留：${raw}`
  }
}

/** 把 Node 的 errno 映射为面向用户的失败原因。 */
function classifyErrno(error: unknown, context: ErrnoContext, action = ''): ClassifiedError {
  const raw = rawMessageOf(error)
  const code = codeOf(error)
  const reason = (code !== null ? ERRNO_REASONS[context][code] : undefined) ?? 'io-error'
  const build = ERRNO_MESSAGES[context][reason]
  return { reason, message: build === undefined ? raw : build(action, raw) }
}

/** 回收站与目标状态检查语境的分类。 */
export function classifyError(error: unknown): ClassifiedError {
  return classifyErrno(error, 'trash')
}

/** 写目标语境的分类；`action` 用于「新建文件」「复制」等措辞。 */
export function classifyWriteError(error: unknown, action: string): ClassifiedError {
  return classifyErrno(error, 'write', action)
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
