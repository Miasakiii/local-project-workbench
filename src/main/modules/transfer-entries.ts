import { cpSync, existsSync, lstatSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FileOperationItem, TransferEntriesResult } from '@shared/types'
import { checkRelativeShape, isSameLocation } from '../security/path-guard'
import type { BeforeExecuteHook } from './file-op-common'
import {
  abortBatch,
  childRelativePath,
  isSameOrDescendant,
  leafOf,
  MAX_BATCH_ITEMS,
  operationItem,
  reasonForRejection,
  summarize
} from './file-op-common'
import { classifyWriteError } from './file-op-errors'
import {
  captureFileIdentity,
  fileFingerprintUnchanged,
  fileIdentityUnchanged,
  resolveDirectoryForWrite,
  resolveForWrite,
  sameFileIdentity,
  type WriteGuardWording,
  writtenTargetIntact
} from './write-guard'

/**
 * 复制／剪切入口 —— 在同一项目内复制或移动一批文件/文件夹
 * （从 `file-access.ts` 拆出，行为不变）。
 *
 * 目标存在时逐项失败且不覆盖；单项失败不阻断后续项，目标目录或信任状态
 * 等结构性问题则整批拒绝。剪切粘贴由 `mode: 'move'` 表达。
 */

export interface TransferEntriesRequest {
  projectRoot: string
  /** 待复制或移动的项目内相对路径 */
  relativePaths: string[]
  /** 粘贴目标目录；空串表示项目根 */
  targetDirectory: string
  mode: 'copy' | 'move'
  trusted: boolean
  /** 执行前钩子；仅验证脚本注入（见 BeforeExecuteHook） */
  beforeExecute?: BeforeExecuteHook
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

    // 身份快照：源项物理身份 + 目标必须仍不存在（A1／R9）
    const sourceIdentity = captureFileIdentity(source.absolutePath)
    const targetIdentity = captureFileIdentity(target.absolutePath)

    request.beforeExecute?.({
      operation: request.mode === 'copy' ? 'copy' : 'move',
      targetAbsolutePath: target.absolutePath
    })

    if (
      !fileIdentityUnchanged(sourceIdentity, source.absolutePath) ||
      !fileFingerprintUnchanged(sourceIdentity, source.absolutePath) ||
      !fileIdentityUnchanged(targetIdentity, target.absolutePath)
    ) {
      items.push(
        operationItem(
          source.relativePath,
          'failed',
          'path-changed',
          '源项或目标位置在执行前发生变化，未执行该项。',
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

    // 写入后立即采集目标身份：复制分支此前只复核源项，没有绑定「刚写出的目标」，
    // 目标在系统调用返回后被替换也无法发现。
    const writtenIdentity = captureFileIdentity(target.absolutePath)

    // 执行后复核：不能把「系统调用返回」直接等同于「用户可确认的成功」。
    // A1 身份维度：剪切的目标必须就是已验证的那个源文件对象；复制的目标必须
    // 是刚写出的对象，且源项未被换过、文件大小与源一致。
    const sourceStillExists = existsSync(source.absolutePath)
    const sourceStateOkay = request.mode === 'copy' ? sourceStillExists : !sourceStillExists
    const targetIdentityAfter = captureFileIdentity(target.absolutePath)
    const identityOkay =
      request.mode === 'move'
        ? sameFileIdentity(targetIdentityAfter, sourceIdentity)
        : writtenIdentity !== null &&
          sameFileIdentity(targetIdentityAfter, writtenIdentity) &&
          fileFingerprintUnchanged(writtenIdentity, target.absolutePath) &&
          fileIdentityUnchanged(sourceIdentity, source.absolutePath) &&
          fileFingerprintUnchanged(sourceIdentity, source.absolutePath) &&
          (sourceIdentity === null || !sourceIdentity.isFile || writtenIdentity.size === sourceIdentity.size)
    if (
      !identityOkay ||
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
