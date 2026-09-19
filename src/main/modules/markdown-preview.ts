import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import type { AssetReadResult, BlockedNotice, MarkdownDocument, ReadmeDetection, ReadmeVariant } from '@shared/types'
import { type PathRejection, resolveProjectPath } from '../security/path-guard'
import { parseMarkdown } from './markdown-parse'
import {
  type BlockedReason,
  firstParagraphText,
  type ImageDecision,
  type LinkDecision,
  sanitizeMarkdown
} from './markdown-sanitize'

/**
 * Markdown 预览模块（设计稿 4.1 / 4.2 / 4.3）。
 *
 * 职责：README 识别、渲染、资源路径解析与限制、按需资源读取。
 * 不导入 Electron，可独立测试；渲染进程从不接触项目内的真实路径。
 *
 * 安全边界（与 path-guard、markdown-sanitize 共同构成）：
 * - 所有相对资源先解码、再规范化，最后按「项目根 + 相对路径」解析真实路径，
 *   越过项目根的路径（含经符号链接／目录联接的）一律拒绝。
 * - 网络图片默认不加载；即使项目显式授权，也只产出 `data-remote` 标记，
 *   由渲染进程按授权决定是否加载，净化层永不输出可加载 URL。
 * - SVG 等可携带主动内容的格式不作为图片加载。
 */

/** 文本预览阈值（设计稿 4.3，标注为待验证） */
export const TEXT_PREVIEW_LIMIT_BYTES = 5 * 1024 * 1024
/** 图片预览阈值（设计稿 4.3，标注为待验证） */
export const IMAGE_PREVIEW_LIMIT_BYTES = 20 * 1024 * 1024
/** 单个文档最多解析的图片数量，避免异常文档放大解析成本 */
const MAX_ASSETS = 200

const README_PRIORITY = ['README.md', 'README.markdown', 'README.txt', 'README']
const README_SEARCH_DIRECTORIES = ['', 'docs', '.github']
const VARIANT_RE = /^readme[._-]([a-z]{2}(?:[-_][a-z]{2,4})?)\.(md|markdown|txt)$/i

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/** 明确排除的图片格式：可携带脚本或外部引用，不作为图片加载（设计稿 4.2）。 */
const ACTIVE_IMAGE_EXTENSIONS = new Set(['.svg', '.svgz', '.mhtml', '.xhtml', '.html', '.htm'])

export interface PreviewPolicy {
  /** 是否允许加载网络图片（按项目授权，默认关闭） */
  allowNetworkImages: boolean
  /** 授权后仍允许的域名白名单；为空表示授权时不限制域名 */
  allowedImageHosts: string[]
}

export const DEFAULT_PREVIEW_POLICY: PreviewPolicy = {
  allowNetworkImages: false,
  allowedImageHosts: []
}

/**
 * 预览层的路径拒绝码：沿用 path-guard 的取值，并补充 `invalid-path`
 * 用于「形态检查未通过但无法归入具体原因」的情形。
 */
type PreviewRejection = PathRejection | 'invalid-path'

/** 把拒绝原因映射为面向用户的说明，界面据此解释「为什么没显示」。 */
function describeRejection(rejection: PreviewRejection, target: string): string {
  switch (rejection) {
    case 'traversal':
      return `路径穿越已被阻止：${target}`
    case 'absolute':
    case 'drive-relative':
    case 'unc':
      return `不接受项目外或绝对路径：${target}`
    case 'outside-project':
      return `目标经符号链接或目录联接指向项目之外：${target}`
    case 'ads':
      return `不接受备用数据流写法：${target}`
    case 'device-path':
      return `不接受系统保留设备名：${target}`
    case 'trailing-dot-or-space':
      return `文件名以点或空格结尾，Windows 下含义不确定：${target}`
    case 'nul-byte':
      return `路径包含 NUL 字节：${target}`
    case 'empty':
    case 'not-a-string':
      return `路径为空或格式不正确：${target}`
    case 'invalid-path':
      return `路径不合法，已阻止：${target}`
    case 'not-found':
      return `目标不存在：${target}`
    case 'not-directory':
    case 'not-file':
      return `目标类型不符：${target}`
    case 'io-error':
      return `无法解析目标路径：${target}`
  }
}

/**
 * 把路径拒绝原因收敛为面向界面的阻止原因码。
 * 试图离开项目范围的几种写法（穿越、绝对路径、UNC、经链接指向外部）统一
 * 归为 `outside-project`，便于界面按「项目外内容」归类解释。
 */
function toBlockedReason(rejection: PreviewRejection): BlockedReason {
  switch (rejection) {
    case 'traversal':
    case 'outside-project':
    case 'absolute':
    case 'drive-relative':
    case 'unc':
      return 'outside-project'
    default:
      return 'invalid-path'
  }
}

function describeBlockedReason(reason: BlockedReason, target: string): string {
  switch (reason) {
    case 'unsafe-protocol':
      return `协议不在允许范围内，已阻止：${target}`
    case 'remote-resource':
      return `网络资源默认不加载，已阻止：${target}`
    case 'outside-project':
      return `目标位于项目之外，已阻止：${target}`
    case 'invalid-path':
      return `路径不合法，已阻止：${target}`
    case 'oversized':
      return `文件超过预览阈值，已阻止自动加载：${target}`
    case 'unsupported-format':
      return `该格式可能携带主动内容，不作为图片加载：${target}`
    case 'raw-html':
      return `内嵌的主动内容标签已被移除：${target}`
    case 'unreadable':
      return `文件无法读取：${target}`
  }
}

/** 拆分 URL 的查询串与锚点，保留路径部分。 */
function stripUrlSuffix(target: string): string {
  const hashIndex = target.indexOf('#')
  const withoutHash = hashIndex === -1 ? target : target.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  return queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
}

function safeDecode(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

function schemeOf(target: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target)
  return match ? (match[1] as string).toLowerCase() : null
}

/** 允许交给系统浏览器打开的外链协议（设计稿 4.3：仅允许明确支持的协议）。 */
const EXTERNAL_LINK_PROTOCOLS = new Set(['http', 'https', 'mailto'])

/**
 * 把 Markdown 中的目标解析为项目内相对路径。
 * 以 `previewDirectory` 为基准（README 所在目录），支持 `/` 前缀表示项目根。
 */
function resolveTarget(
  projectRoot: string,
  previewDirectory: string,
  target: string
):
  | { ok: true; relativePath: string; absolutePath: string }
  | { ok: false; rejection: PreviewRejection; detail: string } {
  const trimmed = target.trim()
  const withoutSuffix = stripUrlSuffix(trimmed)
  const decoded = safeDecode(withoutSuffix)

  const isRootRelative = decoded.startsWith('/') && !decoded.startsWith('//')
  const candidate = isRootRelative
    ? decoded.slice(1)
    : previewDirectory.length > 0
      ? `${previewDirectory}/${decoded}`
      : decoded

  const resolution = resolveProjectPath(projectRoot, candidate, { mustExist: true })
  if (!resolution.ok || resolution.absolutePath === null) {
    return {
      ok: false,
      rejection: resolution.rejection ?? 'invalid-path',
      detail: resolution.detail
    }
  }
  return {
    ok: true,
    relativePath: resolution.normalized,
    absolutePath: resolution.absolutePath
  }
}

function buildPolicy(
  projectRoot: string,
  previewDirectory: string,
  policy: PreviewPolicy,
  notices: BlockedNotice[]
): { resolveLink: (target: string) => LinkDecision; resolveImage: (target: string) => ImageDecision } {
  const resolveLink = (target: string): LinkDecision => {
    const trimmed = target.trim()
    if (trimmed.length === 0) {
      notices.push({
        kind: 'link',
        target,
        reason: 'invalid-path',
        message: describeBlockedReason('invalid-path', target)
      })
      return { kind: 'blocked', reason: 'invalid-path' }
    }
    if (trimmed.startsWith('#')) return { kind: 'anchor', href: trimmed }
    if (trimmed.startsWith('//')) {
      const message = describeBlockedReason('unsafe-protocol', target)
      notices.push({ kind: 'link', target, reason: 'unsafe-protocol', message })
      return { kind: 'blocked', reason: 'unsafe-protocol' }
    }

    const scheme = schemeOf(trimmed)
    // 单字母 scheme 是 Windows 盘符（C://...）而非协议，须交给路径校验判定
    if (scheme !== null && scheme.length > 1) {
      if (EXTERNAL_LINK_PROTOCOLS.has(scheme)) {
        return { kind: 'external', href: trimmed }
      }
      notices.push({
        kind: 'link',
        target,
        reason: 'unsafe-protocol',
        message: describeBlockedReason('unsafe-protocol', target)
      })
      return { kind: 'blocked', reason: 'unsafe-protocol' }
    }

    const resolved = resolveTarget(projectRoot, previewDirectory, trimmed)
    if (!resolved.ok) {
      const reason = toBlockedReason(resolved.rejection)
      notices.push({
        kind: 'link',
        target,
        reason,
        message: describeRejection(resolved.rejection, target)
      })
      return { kind: 'blocked', reason }
    }

    return { kind: 'project', relativePath: resolved.relativePath }
  }

  const resolveImage = (target: string): ImageDecision => {
    const trimmed = target.trim()
    if (trimmed.length === 0) {
      notices.push({
        kind: 'image',
        target,
        reason: 'invalid-path',
        message: describeBlockedReason('invalid-path', target)
      })
      return { kind: 'blocked', reason: 'invalid-path' }
    }

    const scheme = schemeOf(trimmed)
    // 单字母 scheme 是 Windows 盘符（C://...）而非协议，须交给路径校验判定
    if (scheme !== null && scheme.length > 1) {
      if (scheme === 'http' || scheme === 'https') {
        if (!policy.allowNetworkImages) {
          notices.push({
            kind: 'image',
            target,
            reason: 'remote-resource',
            message: describeBlockedReason('remote-resource', target)
          })
          return { kind: 'blocked', reason: 'remote-resource' }
        }
        const host =
          safeDecode(trimmed)
            .replace(/^https?:\/\//i, '')
            .split('/')[0]
            ?.split(':')[0] ?? ''
        if (policy.allowedImageHosts.length > 0 && !policy.allowedImageHosts.includes(host.toLowerCase())) {
          notices.push({
            kind: 'image',
            target,
            reason: 'remote-resource',
            message: `域名未获授权，未加载：${target}`
          })
          return { kind: 'blocked', reason: 'remote-resource' }
        }
        return { kind: 'remote', url: trimmed }
      }
      notices.push({
        kind: 'image',
        target,
        reason: 'unsafe-protocol',
        message: describeBlockedReason('unsafe-protocol', target)
      })
      return { kind: 'blocked', reason: 'unsafe-protocol' }
    }

    if (trimmed.startsWith('//')) {
      notices.push({
        kind: 'image',
        target,
        reason: 'unsafe-protocol',
        message: describeBlockedReason('unsafe-protocol', target)
      })
      return { kind: 'blocked', reason: 'unsafe-protocol' }
    }

    const resolved = resolveTarget(projectRoot, previewDirectory, trimmed)
    if (!resolved.ok) {
      const reason = toBlockedReason(resolved.rejection)
      notices.push({ kind: 'image', target, reason, message: describeRejection(resolved.rejection, target) })
      return { kind: 'blocked', reason }
    }

    const extension = extname(resolved.absolutePath).toLowerCase()
    if (ACTIVE_IMAGE_EXTENSIONS.has(extension)) {
      notices.push({
        kind: 'image',
        target,
        reason: 'unsupported-format',
        message: describeBlockedReason('unsupported-format', target)
      })
      return { kind: 'blocked', reason: 'unsupported-format' }
    }
    if (IMAGE_MIME[extension] === undefined) {
      notices.push({
        kind: 'image',
        target,
        reason: 'unsupported-format',
        message: `不支持的图片格式（${extension || '无扩展名'}）：${target}`
      })
      return { kind: 'blocked', reason: 'unsupported-format' }
    }

    let size = 0
    try {
      size = statSync(resolved.absolutePath).size
    } catch {
      notices.push({
        kind: 'image',
        target,
        reason: 'unreadable',
        message: describeBlockedReason('unreadable', target)
      })
      return { kind: 'blocked', reason: 'unreadable' }
    }
    if (size > IMAGE_PREVIEW_LIMIT_BYTES) {
      notices.push({
        kind: 'image',
        target,
        reason: 'oversized',
        message: `${describeBlockedReason('oversized', target)}（${(size / 1024 / 1024).toFixed(1)} MB）`
      })
      return { kind: 'blocked', reason: 'oversized' }
    }

    return { kind: 'asset', relativePath: resolved.relativePath }
  }

  return { resolveLink, resolveImage }
}

/**
 * README 识别（设计稿 4.1）。
 *
 * 优先使用用户指定的介绍文件；否则在项目根按固定顺序查找，识别时兼容大小写；
 * 根目录未找到时再检查 docs 与 .github。找到后收集同目录的多语言变体。
 */
export function detectReadme(projectRoot: string, preferred: string | null = null): ReadmeDetection {
  if (preferred !== null && preferred.length > 0) {
    const resolution = resolveProjectPath(projectRoot, preferred, { mustExist: true, expect: 'file' })
    if (resolution.ok) {
      const directory = dirname(resolution.normalized).replace(/\\/g, '/')
      const normalizedDirectory = directory === '.' ? '' : directory
      return {
        selected: resolution.normalized,
        variants: collectVariants(projectRoot, normalizedDirectory, resolution.normalized),
        location: classifyLocation(normalizedDirectory)
      }
    }
  }

  for (const directory of README_SEARCH_DIRECTORIES) {
    const entries = listDirectory(projectRoot, directory)
    if (entries === null) continue

    const byLowerCase = new Map<string, string>()
    for (const entry of entries) byLowerCase.set(entry.toLowerCase(), entry)

    for (const candidate of README_PRIORITY) {
      const actual = byLowerCase.get(candidate.toLowerCase())
      if (actual === undefined) continue
      const relativePath = directory.length > 0 ? `${directory}/${actual}` : actual
      const resolution = resolveProjectPath(projectRoot, relativePath, { mustExist: true, expect: 'file' })
      if (!resolution.ok) continue
      return {
        selected: resolution.normalized,
        variants: collectVariants(projectRoot, directory, resolution.normalized),
        location: classifyLocation(directory)
      }
    }
  }

  return { selected: null, variants: [], location: null }
}

function classifyLocation(directory: string): 'root' | 'docs' | '.github' {
  if (directory === 'docs') return 'docs'
  if (directory === '.github') return '.github'
  return 'root'
}

function listDirectory(projectRoot: string, directory: string): string[] | null {
  const resolution = resolveProjectPath(projectRoot, directory.length > 0 ? directory : '.', {
    mustExist: true,
    expect: 'directory'
  })
  if (!resolution.ok || resolution.absolutePath === null) return null
  try {
    return readdirSync(resolution.absolutePath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return null
  }
}

function collectVariants(projectRoot: string, directory: string, selected: string): ReadmeVariant[] {
  const entries = listDirectory(projectRoot, directory)
  if (entries === null) return []

  const variants: ReadmeVariant[] = []
  for (const entry of entries) {
    const match = VARIANT_RE.exec(entry)
    if (!match) continue
    const relativePath = directory.length > 0 ? `${directory}/${entry}` : entry
    if (relativePath === selected) continue
    const resolution = resolveProjectPath(projectRoot, relativePath, { mustExist: true, expect: 'file' })
    if (!resolution.ok) continue
    variants.push({
      relativePath: resolution.normalized,
      locale: (match[1] as string).replace('_', '-')
    })
  }

  variants.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
  return variants
}

export interface RenderRequest {
  projectId: string
  projectRoot: string
  relativePath: string
  policy?: PreviewPolicy
}

/** 读取并渲染一个 Markdown／文本文件为可信 HTML。 */
export function renderMarkdownFile(request: RenderRequest): MarkdownDocument {
  const policy = request.policy ?? DEFAULT_PREVIEW_POLICY
  const notices: BlockedNotice[] = []

  const empty = (relativePath: string, violations: string[], message: string): MarkdownDocument => ({
    projectId: request.projectId,
    relativePath,
    html: '',
    assets: [],
    remoteAssets: [],
    projectLinks: [],
    blocked: [
      {
        kind: 'link',
        target: relativePath,
        reason: 'unreadable',
        message
      }
    ],
    externalLinkCount: 0,
    sourceBytes: 0,
    truncated: false,
    violations
  })

  const resolution = resolveProjectPath(request.projectRoot, request.relativePath, {
    mustExist: true,
    expect: 'file'
  })
  if (!resolution.ok || resolution.absolutePath === null) {
    return empty(
      request.relativePath,
      [],
      describeRejection(resolution.rejection ?? 'invalid-path', request.relativePath)
    )
  }

  let size = 0
  try {
    size = statSync(resolution.absolutePath).size
  } catch (error) {
    return empty(
      resolution.normalized,
      [],
      `无法读取文件信息：${error instanceof Error ? error.message : String(error)}`
    )
  }

  const truncated = size > TEXT_PREVIEW_LIMIT_BYTES
  let source: string
  try {
    // 大文件只读取阈值内的前缀，并明确告知已截断，而不是静默给出不完整内容
    const buffer = readFileSync(resolution.absolutePath)
    source = buffer.subarray(0, TEXT_PREVIEW_LIMIT_BYTES).toString('utf8')
  } catch (error) {
    return empty(resolution.normalized, [], `无法读取文件：${error instanceof Error ? error.message : String(error)}`)
  }

  // 预览基准目录为文件所在目录，符合 Markdown 相对路径语义
  const directory = dirname(resolution.normalized).replace(/\\/g, '/')
  const previewDirectory = directory === '.' ? '' : directory

  const { resolveLink, resolveImage } = buildPolicy(request.projectRoot, previewDirectory, policy, notices)

  const blocks = parseMarkdown(source)
  const result = sanitizeMarkdown(blocks, { resolveLink, resolveImage })

  // 净化层的标签与注释阻止记录需要合并进来；图片与链接的阻止说明由策略层
  // 提供（措辞更具体），因此只取 tag 与 comment，避免重复条目。
  for (const item of result.blocked) {
    if (item.kind !== 'tag' && item.kind !== 'comment') continue
    notices.push({
      kind: item.kind,
      target: item.target,
      reason: item.reason,
      message: describeBlockedReason(item.reason, item.target)
    })
  }

  // 资源数量上限：超出的部分不再生成标签，避免异常文档放大渲染成本
  const assets = result.assets.slice(0, MAX_ASSETS)
  const remoteAssets = result.remoteAssets.slice(0, MAX_ASSETS)
  const droppedAssets = result.assets.length - assets.length
  if (droppedAssets > 0) {
    notices.push({
      kind: 'image',
      target: '',
      reason: 'oversized',
      message: `图片数量超过上限（${MAX_ASSETS}），其余 ${droppedAssets} 项未加载`
    })
  }

  return {
    projectId: request.projectId,
    relativePath: resolution.normalized,
    html: result.html,
    assets,
    remoteAssets,
    projectLinks: result.projectLinks,
    blocked: notices,
    externalLinkCount: result.externalLinkCount,
    sourceBytes: size,
    truncated,
    violations: result.violations
  }
}

/** 提取 README 第一个有效正文段落，用于项目卡片简介（设计稿 4.1）。 */
export function extractSummary(projectRoot: string, relativePath: string): string | null {
  const resolution = resolveProjectPath(projectRoot, relativePath, { mustExist: true, expect: 'file' })
  if (!resolution.ok || resolution.absolutePath === null) return null
  try {
    const size = statSync(resolution.absolutePath).size
    if (size > TEXT_PREVIEW_LIMIT_BYTES) return null
    const source = readFileSync(resolution.absolutePath).toString('utf8')
    const text = firstParagraphText(parseMarkdown(source))
    if (text === null) return null
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return null
  }
}

export interface AssetRequest {
  projectRoot: string
  relativePath: string
  /** 是否允许返回超出图片阈值的资源（用户在界面确认后） */
  allowOversized?: boolean
}

/**
 * 按需读取项目内图片资源，返回 data URL。
 *
 * 读取时**重新**解析真实路径（而非复用渲染阶段的结论），
 * 并对读取前后的文件尺寸做一致性核对，以缩小检查与执行之间的窗口。
 */
export function readAsset(request: AssetRequest): AssetReadResult {
  const base = { relativePath: request.relativePath, mime: null, dataUrl: null, bytes: 0 }

  const resolution = resolveProjectPath(request.projectRoot, request.relativePath, {
    mustExist: true,
    expect: 'file'
  })
  if (!resolution.ok || resolution.absolutePath === null) {
    return {
      ...base,
      status: 'blocked',
      message: describeRejection(resolution.rejection ?? 'invalid-path', request.relativePath)
    }
  }

  const extension = extname(resolution.absolutePath).toLowerCase()
  const mime = IMAGE_MIME[extension]
  if (mime === undefined) {
    return {
      ...base,
      status: ACTIVE_IMAGE_EXTENSIONS.has(extension) ? 'unsupported-format' : 'unsupported-format',
      message: ACTIVE_IMAGE_EXTENSIONS.has(extension)
        ? describeBlockedReason('unsupported-format', request.relativePath)
        : `不支持的图片格式：${extension || '无扩展名'}`
    }
  }

  let sizeBefore = 0
  try {
    sizeBefore = statSync(resolution.absolutePath).size
  } catch (error) {
    return {
      ...base,
      status: 'unreadable',
      message: error instanceof Error ? error.message : String(error)
    }
  }

  if (sizeBefore > IMAGE_PREVIEW_LIMIT_BYTES && request.allowOversized !== true) {
    return {
      ...base,
      status: 'too-large',
      bytes: sizeBefore,
      message: `图片超过预览阈值（${(sizeBefore / 1024 / 1024).toFixed(1)} MB），需确认后加载或改用外部程序打开`
    }
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(resolution.absolutePath)
  } catch (error) {
    return {
      ...base,
      status: 'unreadable',
      message: error instanceof Error ? error.message : String(error)
    }
  }

  // 读取前后尺寸不一致说明文件在读取过程中被改写，结果不可信
  if (buffer.byteLength !== sizeBefore) {
    return {
      ...base,
      status: 'unreadable',
      bytes: buffer.byteLength,
      message: '文件在读取过程中发生变化，已放弃本次结果'
    }
  }

  return {
    relativePath: resolution.normalized,
    status: 'ok',
    mime,
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    bytes: buffer.length,
    message: null
  }
}
