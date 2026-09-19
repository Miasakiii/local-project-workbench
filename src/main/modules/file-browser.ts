import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { FileEntry, FileListResult, FilePreview, PreviewKind } from '@shared/types'
import { resolveProjectPath } from '../security/path-guard'
import { highlightCode, languageForExtension } from './code-highlight'
import { readAsset, renderMarkdownFile, TEXT_PREVIEW_LIMIT_BYTES, type PreviewPolicy } from './markdown-preview'

/**
 * 文件浏览与只读预览（设计稿 4.2，M1-4／M1-5）。
 *
 * 边界：
 * - 只读。不提供保存入口，也不提供任何写操作。
 * - Git 忽略的文件仍可列出（设计稿 4.2）——忽略规则只影响 Git 状态，不影响浏览。
 * - 不跟随指向项目外的链接：符号链接与目录联接在解析阶段被拒绝。
 * - 二进制、编码不支持、无权限分别给出明确状态，不显示空白成功页（设计稿 4.3）。
 */

/** 单目录条目上限。超出时明确告知已截断，而不是静默只给一部分。 */
export const MAX_DIRECTORY_ENTRIES = 2000

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn'])
const PLAIN_TEXT_EXTENSIONS = new Set(['.txt', '.text', '.log', '.csv', '.tsv', '.diff', '.patch'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif'])
/** 明确不作为图片加载的格式：可携带主动内容（设计稿 4.2） */
const ACTIVE_FORMATS = new Set(['.svg', '.svgz', '.html', '.htm', '.xhtml', '.mhtml'])
const TEXT_EXTENSIONLESS_NAMES = new Set([
  'readme',
  'license',
  'licence',
  'changelog',
  'contributing',
  'authors',
  'notice',
  'makefile',
  'dockerfile',
  'procfile',
  'gemfile',
  'rakefile',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.env'
])

function compareEntries(left: FileEntry, right: FileEntry): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

function buildBreadcrumb(relativePath: string): Array<{ name: string; relativePath: string }> {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  const trail: Array<{ name: string; relativePath: string }> = []
  let accumulated = ''
  for (const segment of segments) {
    accumulated = accumulated.length === 0 ? segment : `${accumulated}/${segment}`
    trail.push({ name: segment, relativePath: accumulated })
  }
  return trail
}

function errorMessage(cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return '没有权限访问该目录'
    case 'ENOENT':
      return '目录不存在或已被移动'
    case 'EBUSY':
      return '目录被占用，暂时无法读取'
    default:
      return cause instanceof Error ? cause.message : String(cause)
  }
}

export interface ListDirectoryRequest {
  projectRoot: string
  relativePath: string
}

export function listDirectory(request: ListDirectoryRequest): FileListResult {
  const relativePath = request.relativePath === '.' ? '' : request.relativePath
  const base: FileListResult = {
    relativePath,
    breadcrumb: buildBreadcrumb(relativePath),
    entries: [],
    truncated: false,
    error: null
  }

  const resolution = resolveProjectPath(request.projectRoot, relativePath.length > 0 ? relativePath : '.', {
    mustExist: true,
    expect: 'directory'
  })
  if (!resolution.ok || resolution.absolutePath === null) {
    return { ...base, error: resolution.detail }
  }

  let names: Array<{ name: string; isDirectory: boolean; isLink: boolean }>
  try {
    names = readdirSync(resolution.absolutePath, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isLink: entry.isSymbolicLink()
    }))
  } catch (cause) {
    return { ...base, error: errorMessage(cause) }
  }

  const entries: FileEntry[] = []
  let truncated = false

  for (const item of names) {
    if (entries.length >= MAX_DIRECTORY_ENTRIES) {
      truncated = true
      break
    }
    const childRelative = relativePath.length > 0 ? `${relativePath}/${item.name}` : item.name
    const child = resolveProjectPath(request.projectRoot, childRelative, { mustExist: true })
    if (!child.ok || child.absolutePath === null) {
      // 指向项目外的链接等不可用目标仍然列出，但标记为链接并给出 0 尺寸，
      // 让用户看得到它的存在，而不是静默消失
      entries.push({
        name: item.name,
        relativePath: childRelative,
        kind: item.isDirectory ? 'directory' : 'file',
        size: 0,
        modifiedAt: new Date(0).toISOString(),
        isLink: true
      })
      continue
    }

    let size = 0
    let modifiedAt = new Date(0).toISOString()
    try {
      const stats = statSync(child.absolutePath)
      size = item.isDirectory ? 0 : stats.size
      modifiedAt = stats.mtime.toISOString()
    } catch {
      // 读取失败不影响列出
    }

    entries.push({
      name: item.name,
      relativePath: childRelative,
      kind: item.isDirectory ? 'directory' : 'file',
      size,
      modifiedAt,
      isLink: item.isLink
    })
  }

  entries.sort(compareEntries)
  return { ...base, entries, truncated }
}

function isMarkdownFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(extname(lower))) return true
  return lower === 'readme'
}

function classify(name: string): { kind: PreviewKind; language: string | null } {
  const lower = name.toLowerCase()
  const extension = extname(lower)

  if (ACTIVE_FORMATS.has(extension)) return { kind: 'unsupported', language: null }
  if (isMarkdownFile(lower)) return { kind: 'markdown', language: null }
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', language: null }
  if (PLAIN_TEXT_EXTENSIONS.has(extension)) return { kind: 'text', language: null }

  const language = languageForExtension(extension)
  if (language !== null) return { kind: 'code', language }

  if (extension.length === 0 && TEXT_EXTENSIONLESS_NAMES.has(lower)) {
    return { kind: 'text', language: null }
  }

  return { kind: 'unsupported', language: null }
}

interface DecodedText {
  ok: boolean
  text: string
  message: string | null
}

/**
 * 解码文本内容。
 * 二进制（含 NUL 字节）与编码不支持的场景分别给出明确结论（设计稿 4.3）。
 */
function decodeText(buffer: Buffer): DecodedText {
  if (buffer.includes(0)) {
    return { ok: false, text: '', message: '这是二进制文件，第一版不提供内容预览。' }
  }

  // UTF-16 BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { ok: true, text: buffer.subarray(2).toString('utf16le'), message: null }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return { ok: true, text: swapped.toString('utf16le'), message: '文件为 UTF-16 大端编码，已按 UTF-16 解码。' }
  }

  const text = buffer.toString('utf8')
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length
  if (replacementCount > 0) {
    const ratio = replacementCount / Math.max(text.length, 1)
    if (ratio > 0.01) {
      return {
        ok: false,
        text: '',
        message: '文件不是 UTF-8 编码，第一版不做编码猜测，请用外部程序打开。'
      }
    }
  }
  return { ok: true, text, message: null }
}

/**
 * 内容嗅探：扩展名未知时判断文件是文本还是二进制。
 * 只看前 4 KB，不读取整个文件。无法判断时返回 `unknown`，由调用方给出通用说明。
 */
function sniffContent(absolutePath: string): 'text' | 'binary' | 'unknown' {
  let handle: number | undefined
  try {
    handle = openSync(absolutePath, 'r')
    const buffer = Buffer.alloc(4096)
    const read = readSync(handle, buffer, 0, buffer.length, 0)
    const sample = buffer.subarray(0, read)
    if (sample.length === 0) return 'text'
    if (sample.includes(0)) return 'binary'

    const text = sample.toString('utf8')
    const replacement = (text.match(/\uFFFD/g) ?? []).length
    if (replacement / Math.max(text.length, 1) > 0.02) return 'binary'

    let control = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code < 9 || (code > 13 && code < 32)) control += 1
    }
    return control / Math.max(text.length, 1) > 0.05 ? 'binary' : 'text'
  } catch {
    return 'unknown'
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // 忽略
      }
    }
  }
}

export interface PreviewFileRequest {
  projectRoot: string
  relativePath: string
  policy?: PreviewPolicy
}

export function previewFile(request: PreviewFileRequest): FilePreview {
  const name = basename(request.relativePath)
  const base: FilePreview = {
    kind: 'error',
    relativePath: request.relativePath,
    name,
    language: null,
    text: null,
    highlightedHtml: null,
    markdown: null,
    image: null,
    size: 0,
    truncated: false,
    lineCount: null,
    message: null
  }

  const resolution = resolveProjectPath(request.projectRoot, request.relativePath, {
    mustExist: true,
    expect: 'file'
  })
  if (!resolution.ok || resolution.absolutePath === null) {
    return { ...base, message: resolution.detail }
  }

  let size = 0
  try {
    size = statSync(resolution.absolutePath).size
  } catch (cause) {
    return { ...base, message: errorMessage(cause) }
  }

  const classified = classify(name)
  let kind = classified.kind
  const language = classified.language

  if (kind === 'unsupported') {
    // 可携带主动内容的格式：无论内容如何都不在应用内渲染（设计稿 4.2）
    if (ACTIVE_FORMATS.has(extname(name.toLowerCase()))) {
      return {
        ...base,
        kind: 'unsupported',
        size,
        message: '该格式可携带主动内容，第一版只提供「用默认程序打开」，不在应用内渲染。'
      }
    }
    // 其余未知扩展名做内容嗅探：是文本就按文本预览，是二进制就明确说明
    const sniffed = sniffContent(resolution.absolutePath)
    if (sniffed === 'binary') {
      return {
        ...base,
        kind: 'unsupported',
        size,
        message: '这是二进制文件，第一版不提供内容预览。'
      }
    }
    if (sniffed === 'unknown') {
      return {
        ...base,
        kind: 'unsupported',
        size,
        message: '该格式第一版不提供内置预览，可用默认程序打开。'
      }
    }
    kind = 'text'
  }

  if (kind === 'markdown') {
    const document = renderMarkdownFile({
      projectId: 'preview',
      projectRoot: request.projectRoot,
      relativePath: request.relativePath,
      policy: request.policy
    })
    return {
      ...base,
      kind: 'markdown',
      markdown: document,
      size: document.sourceBytes,
      truncated: document.truncated,
      message: document.violations.length > 0 ? '渲染自审发现问题，已拒绝采用该输出。' : null
    }
  }

  if (kind === 'image') {
    const asset = readAsset({ projectRoot: request.projectRoot, relativePath: request.relativePath })
    if (asset.status === 'unsupported-format') {
      return { ...base, kind: 'unsupported', size: asset.bytes, message: asset.message }
    }
    return {
      ...base,
      kind: 'image',
      image: asset,
      size: asset.bytes > 0 ? asset.bytes : size,
      message: asset.message
    }
  }

  // 文本与代码
  let buffer: Buffer
  try {
    buffer = readFileSync(resolution.absolutePath)
  } catch (cause) {
    return { ...base, message: errorMessage(cause) }
  }

  const truncated = buffer.byteLength > TEXT_PREVIEW_LIMIT_BYTES
  const effective = truncated ? buffer.subarray(0, TEXT_PREVIEW_LIMIT_BYTES) : buffer
  const decoded = decodeText(effective)
  if (!decoded.ok) {
    return { ...base, kind: 'unsupported', size: buffer.byteLength, message: decoded.message }
  }

  if (kind === 'code') {
    const highlighted = highlightCode(decoded.text, language)
    return {
      ...base,
      kind: 'code',
      language,
      text: decoded.text,
      highlightedHtml: highlighted.html,
      size: buffer.byteLength,
      truncated,
      lineCount: highlighted.lineCount,
      message: decoded.message ?? (highlighted.plain && language !== null ? '内容较大，已跳过高亮以保证响应速度。' : null)
    }
  }

  return {
    ...base,
    kind: 'text',
    text: decoded.text,
    size: buffer.byteLength,
    truncated,
    lineCount: decoded.text.split('\n').length,
    message: decoded.message
  }
}

/** 供诊断：判断某路径是否为项目内目录（终端启动目录校验用）。 */
export function resolveDirectory(projectRoot: string, relativePath: string): string | null {
  const resolution = resolveProjectPath(projectRoot, relativePath.length > 0 ? relativePath : '.', {
    mustExist: true,
    expect: 'directory'
  })
  return resolution.ok ? resolution.absolutePath : null
}

/** 解析项目内文件或目录的真实路径（用于「用默认程序打开」「在资源管理器中定位」）。 */
export function resolveEntryPath(projectRoot: string, relativePath: string): string | null {
  if (relativePath.length === 0) return projectRoot
  const resolution = resolveProjectPath(projectRoot, relativePath, { mustExist: true })
  return resolution.ok ? resolution.absolutePath : null
}
