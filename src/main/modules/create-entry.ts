import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CreateEntryResult } from '@shared/types'
import { isSameLocation } from '../security/path-guard'
import { normalizeEntryName } from './entry-name'
import type { BeforeExecuteHook } from './file-op-common'
import { abortBatch, childRelativePath, operationItem, summarize } from './file-op-common'
import { classifyWriteError } from './file-op-errors'
import {
  captureFileIdentity,
  fileIdentityUnchanged,
  resolveDirectoryForWrite,
  resolveForWrite,
  type WriteGuardWording,
  writtenTargetIntact
} from './write-guard'

/**
 * 新建入口 —— 新建空文件或空文件夹（从 `file-access.ts` 拆出，行为不变）。
 *
 * 不覆盖已有目标：`openSync('wx')` 与 `mkdirSync` 均为「存在即失败」的原子原语，
 * 冲突经 `classifyWriteError` 翻译为逐项失败报告。
 */

export interface CreateEntryRequest {
  projectRoot: string
  /** 新建目标所在的项目内目录；空串表示项目根 */
  parentRelativePath: string
  /** 单段文件或文件夹名称 */
  name: unknown
  kind: 'file' | 'directory'
  trusted: boolean
  /** 执行前钩子；仅验证脚本注入（见 BeforeExecuteHook） */
  beforeExecute?: BeforeExecuteHook
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

  // 身份快照：解析后、执行前，目标或父目录被替换（同名异文件、父目录换成链接）
  // 一律拒绝（A1／R9）。realpath 等价复核对「同名异文件」是盲区。
  const parentIdentity = captureFileIdentity(parent.absolutePath)
  const targetIdentity = captureFileIdentity(target.absolutePath)

  request.beforeExecute?.({ operation: 'create', targetAbsolutePath: target.absolutePath })

  if (
    !fileIdentityUnchanged(parentIdentity, parent.absolutePath) ||
    !fileIdentityUnchanged(targetIdentity, target.absolutePath)
  ) {
    return summarize([
      operationItem(
        targetRelativePath,
        'failed',
        'path-changed',
        '目标或其父目录在执行前发生变化，未执行新建。',
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
