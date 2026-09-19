import { readFileSync, statSync } from 'node:fs'
import type { DiffHunk, DiffScope, FileDiff } from '@shared/types'
import { resolveProjectPath } from '../security/path-guard'
import { parseUnifiedDiff, synthesizeAddedDiff, synthesizeContentDiff } from './git-diff-parse'
import { queryFileDiff } from './git-query'

/**
 * 差异服务（设计稿 5.2）。
 *
 * 职责：决定比较对象、调用 Git 或合成未跟踪内容的差异、施加大小上限。
 *
 * 三种比较对象的语义（界面必须如实呈现）：
 * - `unstaged`：工作区与索引比较。
 * - `staged`：索引与 HEAD 比较。仓库尚无首次提交时，Git 会把索引与空树比较，
 *   因此不会因为「没有 HEAD」而失败。
 * - `untracked`：**没有 Git 历史基线**，只呈现当前内容，不做「新增了哪些行」的推断。
 */

/** 单个文件的差异行数上限：超过即截断并告知 */
export const MAX_DIFF_LINES = 2000
/** 合成未跟踪文件差异时的读取上限 */
export const MAX_UNTRACKED_BYTES = 512 * 1024
/** 二进制探测的采样长度 */
const BINARY_SAMPLE_BYTES = 4096

export interface FileDiffRequest {
  projectId: string
  projectRoot: string
  relativePath: string
  scope: DiffScope
  /** 重命名时的原路径；传入后 Git 才能在限定路径的情况下配对两侧 */
  originalPath?: string | null
}

function failedDiff(request: FileDiffRequest, error: string): FileDiff {
  return {
    projectId: request.projectId,
    relativePath: request.relativePath,
    scope: request.scope,
    status: 'unchanged',
    binary: false,
    originalPath: null,
    hunks: [],
    addedLines: 0,
    removedLines: 0,
    truncated: false,
    noBaseline: request.scope === 'untracked',
    updatedAt: new Date().toISOString(),
    stale: true,
    error
  }
}

/** 按行数上限截断 hunks，返回截断后的结果与是否发生截断 */
function clampHunks(hunks: DiffHunk[]): { hunks: DiffHunk[]; truncated: boolean } {
  let remaining = MAX_DIFF_LINES
  const output: DiffHunk[] = []
  let truncated = false

  for (const hunk of hunks) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (hunk.lines.length <= remaining) {
      output.push(hunk)
      remaining -= hunk.lines.length
      continue
    }
    output.push({ ...hunk, lines: hunk.lines.slice(0, remaining) })
    truncated = true
    remaining = 0
  }

  return { hunks: output, truncated }
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)
}

/** 合成未跟踪文件的「全部新增」差异：无基线，仅呈现当前内容。 */
function contentDiff(request: FileDiffRequest, mode: 'untracked' | 'conflicted'): FileDiff {
  const resolution = resolveProjectPath(request.projectRoot, request.relativePath, {
    mustExist: true,
    expect: 'file'
  })
  if (!resolution.ok || resolution.absolutePath === null) {
    return failedDiff(request, resolution.detail)
  }

  let size = 0
  try {
    size = statSync(resolution.absolutePath).size
  } catch (error) {
    return failedDiff(request, error instanceof Error ? error.message : String(error))
  }

  const noBaseline = mode === 'untracked'
  if (size > MAX_UNTRACKED_BYTES) {
    return {
      ...failedDiff(request, ''),
      error: null,
      status: mode === 'conflicted' ? 'modified' : 'added',
      truncated: true,
      noBaseline,
      updatedAt: new Date().toISOString(),
      stale: false
    }
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(resolution.absolutePath)
  } catch (error) {
    return failedDiff(request, error instanceof Error ? error.message : String(error))
  }

  if (looksBinary(buffer)) {
    return {
      ...failedDiff(request, ''),
      error: null,
      status: mode === 'conflicted' ? 'modified' : 'added',
      binary: true,
      noBaseline,
      updatedAt: new Date().toISOString(),
      stale: false
    }
  }

  const content = buffer.toString('utf8')
  // 冲突文件呈现「当前内容」（含冲突标记），不做增删推断（设计稿 5.2）
  const parsed = mode === 'conflicted' ? synthesizeContentDiff(content) : synthesizeAddedDiff(content)
  const clamped = clampHunks(parsed.hunks)

  return {
    projectId: request.projectId,
    relativePath: resolution.normalized,
    scope: mode,
    status: mode === 'conflicted' ? 'modified' : 'added',
    binary: false,
    originalPath: null,
    hunks: clamped.hunks,
    addedLines: parsed.addedLines,
    removedLines: 0,
    truncated: clamped.truncated,
    noBaseline,
    updatedAt: new Date().toISOString(),
    stale: false,
    error: null
  }
}

/** 查询单个文件的只读差异。 */
export async function fileDiff(request: FileDiffRequest): Promise<FileDiff> {
  if (request.scope === 'untracked' || request.scope === 'conflicted') {
    return contentDiff(request, request.scope)
  }

  const resolution = resolveProjectPath(request.projectRoot, request.relativePath, { mustExist: false })
  if (!resolution.ok) return failedDiff(request, resolution.detail)

  const result = await queryFileDiff(
    request.projectId,
    request.projectRoot,
    resolution.normalized,
    request.scope,
    request.originalPath ?? null
  )
  if (result.error !== null) return result

  const clamped = clampHunks(result.hunks)
  return { ...result, hunks: clamped.hunks, truncated: clamped.truncated }
}

/** 供调用方判断：给定扩展名是否值得尝试逐行差异（二进制文件直接跳过）。 */
export function isProbablyTextExtension(extension: string): boolean {
  const binary = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.ico',
    '.avif',
    '.bmp',
    '.pdf',
    '.zip',
    '.gz',
    '.7z',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.woff',
    '.woff2',
    '.ttf',
    '.otf',
    '.mp4',
    '.mp3',
    '.mov'
  ])
  return !binary.has(extension.toLowerCase())
}

export { parseUnifiedDiff }
