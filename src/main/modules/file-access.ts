import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  CreateEntryResult,
  DeleteEntriesResult,
  FileOperationBatchResult,
  FileOperationItem,
  FileOperationReason,
  FileOperationStatus,
  RenameEntryResult,
  TransferEntriesResult
} from '@shared/types'
import { checkRelativeShape, isSameLocation } from '../security/path-guard'
import { normalizeEntryName, normalizeRenameName } from './entry-name'
import {
  classifyError,
  classifyWriteError,
  codeOf,
  discriminateTrashFailure,
  rawMessageOf
} from './file-op-errors'
import {
  resolveDirectoryForWrite,
  resolveForWrite,
  writtenTargetIntact,
  type FileRejection,
  type WriteGuardWording
} from './write-guard'

/**
 * 再导出：保持本模块的公开导出面不变。
 *
 * `classifyError` / `discriminateTrashFailure` 的实现已移至 `file-op-errors.ts`（重构，
 * 行为不变），但验证脚本与调用方一直从 `file-access.ts` 导入它们；这里经 barrel
 * 再导出，导入方零改动。
 */
export { classifyError, discriminateTrashFailure } from './file-op-errors'
export type { TrashFailureDecision } from './file-op-errors'

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
 *
 * 模块拆分（重构，行为不变；公开导出面经 barrel 再导出保持不变）：
 * - `write-guard.ts`    「相对路径 → 可写真实路径」的判定顺序（四步守卫 + 执行后复核）；
 * - `file-op-errors.ts` errno 与回收站失败的「原因 + 文案」翻译；
 * - `entry-name.ts`     新建与重命名的单段名称校验。
 * 本文件只保留四个写入口的流程编排与各自的守卫措辞。
 */

/** 回收站能力。主进程注入 `shell.trashItem`。 */
export type TrashFn = (absolutePath: string) => Promise<void>

/** 单次批量操作的项数上限，防止误操作放大到不可收拾的规模。 */
export const MAX_BATCH_ITEMS = 500

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

function summarize(items: FileOperationItem[]): FileOperationBatchResult {
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

function abortBatch(reason: FileOperationReason, message: string): FileOperationBatchResult {
  return { items: [], ok: 0, failed: 0, skipped: 0, aborted: true, abortReason: reason, abortMessage: message }
}

function childRelativePath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`
}

function leafOf(relativePath: string): string {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function operationItem(
  relativePath: string,
  status: FileOperationStatus,
  reason: FileOperationReason | null,
  message: string,
  targetRelativePath: string | null = null
): FileOperationItem {
  return { relativePath, targetRelativePath, status, reason, message }
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

export interface CreateEntryRequest {
  projectRoot: string
  /** 新建目标所在的项目内目录；空串表示项目根 */
  parentRelativePath: string
  /** 单段文件或文件夹名称 */
  name: unknown
  kind: 'file' | 'directory'
  trusted: boolean
}

/** 新建入口的守卫文案：父目录与新建目标各一套。 */
const CREATE_PARENT_WORDING: WriteGuardWording = {
  viaReparsePoint: '写操作不支持经过符号链接或目录联接的目标目录，未执行新建。',
  protectedEntry: () => 'Git 元数据目录不提供新建操作。',
  unresolvable: (_input, _rejection, detail) => ({
    reason: 'invalid-path',
    message: `新建目标目录不可用：${detail}`
  })
}

const CREATE_TARGET_WORDING: WriteGuardWording = {
  viaReparsePoint: '写操作不支持经过符号链接或目录联接的目标路径，未执行新建。',
  protectedEntry: () => '项目根目录与 Git 元数据不提供新建操作。',
  unresolvable: (_input, _rejection, detail) => ({
    reason: 'outside-project',
    message: `目标路径不可用：${detail}`
  })
}

/** 新建空文件或空文件夹；不覆盖已有目标。 */
export function createEntry(request: CreateEntryRequest): CreateEntryResult {
  if (!request.trusted) {
    return abortBatch('untrusted-project', '该项目尚未被信任，当前为只读浏览状态，未执行任何新建操作。')
  }

  const name = normalizeEntryName(request.name)
  if (!name.ok) {
    return summarize([operationItem('', 'failed', 'invalid-path', name.message)])
  }

  const parent = resolveDirectoryForWrite(request.projectRoot, request.parentRelativePath, CREATE_PARENT_WORDING)
  if (!parent.ok) {
    return abortBatch(parent.reason, parent.message)
  }

  const targetRelativePath = childRelativePath(parent.relativePath, name.normalized)
  const target = resolveForWrite(request.projectRoot, targetRelativePath, {
    mustExist: false,
    wording: CREATE_TARGET_WORDING
  })
  if (!target.ok) {
    return summarize([
      operationItem(targetRelativePath, target.status, target.reason, target.message, targetRelativePath)
    ])
  }
  if (!isSameLocation(dirname(target.absolutePath), parent.absolutePath)) {
    return summarize([
      operationItem(
        targetRelativePath,
        'failed',
        'path-changed',
        '目标父目录在执行前发生变化，未执行新建。',
        targetRelativePath
      )
    ])
  }

  try {
    if (request.kind === 'file') {
      const handle = openSync(target.absolutePath, 'wx')
      closeSync(handle)
    } else {
      mkdirSync(target.absolutePath)
    }
  } catch (error) {
    const classified = classifyWriteError(error, request.kind === 'file' ? '新建文件' : '新建文件夹')
    return summarize([
      operationItem(targetRelativePath, 'failed', classified.reason, classified.message, targetRelativePath)
    ])
  }

  if (!writtenTargetIntact(request.projectRoot, targetRelativePath, request.kind, target.absolutePath)) {
    return summarize([
      operationItem(
        targetRelativePath,
        'failed',
        'path-changed',
        '新建调用已返回，但磁盘状态无法安全确认；请刷新文件树后再继续。',
        targetRelativePath
      )
    ])
  }

  return summarize([
    operationItem(
      targetRelativePath,
      'ok',
      null,
      request.kind === 'file' ? '已新建空文件。' : '已新建空文件夹。',
      targetRelativePath
    )
  ])
}

export interface TransferEntriesRequest {
  projectRoot: string
  /** 待复制或移动的项目内相对路径 */
  relativePaths: string[]
  /** 粘贴目标目录；空串表示项目根 */
  targetDirectory: string
  mode: 'copy' | 'move'
  trusted: boolean
}

/** 复制／剪切入口的守卫文案：粘贴目录、源项、落地目标各一套。 */
const PASTE_DIRECTORY_WORDING: WriteGuardWording = {
  viaReparsePoint: '写操作不支持经过符号链接或目录联接的粘贴目标目录。',
  protectedEntry: () => 'Git 元数据目录不提供复制或剪切粘贴目标。',
  unresolvable: (_input, _rejection, detail) => ({
    reason: 'invalid-path',
    message: `粘贴目标目录不可用：${detail}`
  })
}

const TRANSFER_SOURCE_WORDING: WriteGuardWording = {
  viaReparsePoint: '写操作不支持经过符号链接或目录联接的源项。',
  protectedEntry: () => '项目根目录与 Git 元数据不提供复制或移动。',
  unresolvable: (_input, rejection, detail) => ({
    reason: reasonForRejection(rejection),
    message: `源项无法处理：${detail}`
  })
}

const TRANSFER_TARGET_WORDING: WriteGuardWording = {
  viaReparsePoint: '目标名称已指向符号链接或目录联接，未执行以避免误操作。',
  protectedEntry: () => '项目根目录与 Git 元数据不提供复制或移动。',
  unresolvable: (_input, _rejection, detail) => ({
    reason: 'outside-project',
    message: `目标路径不可用：${detail}`
  })
}

/**
 * 在同一项目内复制或移动一批文件/文件夹。
 *
 * 目标存在时逐项失败且不覆盖；单项失败不阻断后续项，目标目录或信任状态
 * 等结构性问题则整批拒绝。剪切粘贴由 `mode: 'move'` 表达。
 */
export function transferEntries(request: TransferEntriesRequest): TransferEntriesResult {
  if (!request.trusted) {
    return abortBatch('untrusted-project', '该项目尚未被信任，当前为只读浏览状态，未执行复制或剪切粘贴。')
  }

  const uniquePaths = [...new Set(request.relativePaths.map((item) => String(item)))]
  if (uniquePaths.length === 0) return abortBatch('invalid-path', '没有需要复制或剪切的项。')
  if (uniquePaths.length > MAX_BATCH_ITEMS) {
    return abortBatch(
      'invalid-path',
      `单次操作最多处理 ${MAX_BATCH_ITEMS} 项，当前为 ${uniquePaths.length} 项。请分批执行。`
    )
  }

  const targetDirectory = resolveDirectoryForWrite(
    request.projectRoot,
    request.targetDirectory,
    PASTE_DIRECTORY_WORDING
  )
  if (!targetDirectory.ok) {
    return abortBatch(targetDirectory.reason, targetDirectory.message)
  }

  const items: FileOperationItem[] = []

  for (const inputPath of uniquePaths) {
    const source = resolveForWrite(request.projectRoot, inputPath, {
      mustExist: true,
      wording: TRANSFER_SOURCE_WORDING
    })
    if (!source.ok) {
      items.push(operationItem(inputPath, source.status, source.reason, source.message))
      continue
    }

    const hasSelectedAncestor = uniquePaths.some((otherInput) => {
      if (otherInput === inputPath) return false
      const otherShape = checkRelativeShape(otherInput)
      return otherShape.ok && isSameOrDescendant(otherShape.normalized, source.relativePath)
    })
    if (hasSelectedAncestor) {
      items.push(
        operationItem(
          source.relativePath,
          'skipped',
          'invalid-path',
          '该项已包含在另一个选中目录内，本批次跳过以避免重复复制或移动。'
        )
      )
      continue
    }

    let sourceIsDirectory = false
    try {
      sourceIsDirectory = lstatSync(source.absolutePath).isDirectory()
    } catch (error) {
      const classified = classifyWriteError(error, request.mode === 'copy' ? '复制' : '移动')
      items.push(operationItem(source.relativePath, 'failed', classified.reason, classified.message))
      continue
    }

    if (sourceIsDirectory) {
      if (isSameOrDescendant(source.relativePath, targetDirectory.relativePath)) {
        items.push(
          operationItem(source.relativePath, 'failed', 'invalid-path', '不能把文件夹复制或移动到自身或其子目录内。')
        )
        continue
      }
    }

    const targetRelativePath = childRelativePath(targetDirectory.relativePath, leafOf(source.relativePath))
    const target = resolveForWrite(request.projectRoot, targetRelativePath, {
      mustExist: false,
      wording: TRANSFER_TARGET_WORDING
    })
    if (!target.ok) {
      items.push(operationItem(source.relativePath, target.status, target.reason, target.message, targetRelativePath))
      continue
    }
    if (existsSync(target.absolutePath)) {
      items.push(
        operationItem(
          source.relativePath,
          'failed',
          'name-conflict',
          `目标名称已存在，未覆盖现有项：${targetRelativePath}`,
          targetRelativePath
        )
      )
      continue
    }
    if (!isSameLocation(dirname(target.absolutePath), targetDirectory.absolutePath)) {
      items.push(
        operationItem(
          source.relativePath,
          'failed',
          'path-changed',
          '粘贴目标目录在执行前发生变化，未执行该项。',
          targetRelativePath
        )
      )
      continue
    }

    try {
      if (request.mode === 'copy') {
        cpSync(source.absolutePath, target.absolutePath, { recursive: true, errorOnExist: true, force: false })
      } else {
        renameSync(source.absolutePath, target.absolutePath)
      }
    } catch (error) {
      const classified = classifyWriteError(error, request.mode === 'copy' ? '复制' : '移动')
      items.push(
        operationItem(source.relativePath, 'failed', classified.reason, classified.message, targetRelativePath)
      )
      continue
    }

    // 剪切要求源项已消失，复制要求源项仍在；任一不符都不报告成功
    const sourceStillExists = existsSync(source.absolutePath)
    const sourceStateOkay = request.mode === 'copy' ? sourceStillExists : !sourceStillExists
    if (
      !writtenTargetIntact(
        request.projectRoot,
        targetRelativePath,
        sourceIsDirectory ? 'directory' : 'file',
        target.absolutePath,
        () => !sourceStateOkay
      )
    ) {
      items.push(
        operationItem(
          source.relativePath,
          'failed',
          'path-changed',
          '操作调用已返回，但源项或目标项状态无法安全确认；请刷新文件树后再继续。',
          targetRelativePath
        )
      )
      continue
    }

    items.push(
      operationItem(
        source.relativePath,
        'ok',
        null,
        request.mode === 'copy' ? '已复制到目标目录。' : '已移动到目标目录。',
        targetRelativePath
      )
    )
  }

  return summarize(items)
}

export interface RenameEntryRequest {
  projectRoot: string
  /** 待重命名的项目内相对路径 */
  relativePath: string
  /** 同一父目录内的新名称；不接受路径分隔符 */
  newName: unknown
  /** 不可信项目默认只读 */
  trusted: boolean
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

/**
 * 在同一父目录内重命名单个文件或文件夹。
 *
 * 安全与一致性边界：
 * - 只接受项目内相对路径和单段新名称，不接受跨目录移动；
 * - 写操作拒绝经过符号链接或目录联接的路径，避免把链接目标误当成链接本身；
 * - 解析、冲突检查和真实路径复核均在执行前完成，执行后再次确认磁盘状态；
 * - 路径 API 无法消除全部 TOCTOU 窗口，任何执行后无法确认的情况都不报告成功。
 */
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

  try {
    renameSync(source.absolutePath, target.absolutePath)
  } catch (error) {
    const classified = classifyWriteError(error, '重命名')
    return renameFailure(sourceInput, targetRelative, classified.reason, classified.message)
  }

  // 执行后复核：不能把「系统调用返回」直接等同于「用户可确认的成功」。
  if (
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
