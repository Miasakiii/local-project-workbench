import type { BlockNode, InlineNode } from './markdown-parse'
import { inlineToPlainText, RAW_TEXT_TAGS } from './markdown-parse'

/**
 * HTML 净化与渲染（设计稿 4.3）。
 *
 * 三条不可协商的规则：
 * 1. **文本一律转义。** 源码中的 `<script>` 只会以文字形式出现，不进入标签流。
 * 2. **标签走白名单。** 原始 HTML 先被词法拆解，再按标签与属性白名单过滤；
 *    事件属性（`on*`）、`style`、以及 script／iframe／object／embed／svg 等
 *    主动内容标签整体丢弃，仅保留其内部文字。
 * 3. **URL 不落地。** 允许的项目内图片不写入 `src`，只写入 `data-asset`，
 *    由渲染进程按需经主进程校验后换取内容；网络地址与不安全协议不进入
 *    可加载属性。这样「默认不加载网络资源」是结构性保证，而非策略开关。
 *
 * 输出经 `auditHtml` 自审：任何白名单外的标签、事件属性或不安全协议都会
 * 被报告，调用方可据此拒绝整段输出。
 */

export type LinkDecision =
  | { kind: 'external'; href: string }
  | { kind: 'anchor'; href: string }
  | { kind: 'project'; relativePath: string }
  | { kind: 'blocked'; reason: BlockedReason }

export type ImageDecision =
  | { kind: 'asset'; relativePath: string }
  /** 已获项目授权的外部图片：只产出标记，不产出可加载 URL */
  | { kind: 'remote'; url: string }
  | { kind: 'blocked'; reason: BlockedReason }

export type BlockedReason =
  | 'unsafe-protocol'
  | 'remote-resource'
  | 'outside-project'
  | 'invalid-path'
  | 'oversized'
  | 'unsupported-format'
  | 'raw-html'
  | 'unreadable'

export interface SanitizePolicy {
  /** 解析链接目标；实现方负责协议白名单与项目内路径校验 */
  resolveLink: (target: string) => LinkDecision
  /** 解析图片目标；实现方负责协议白名单、项目内路径校验与大小限制 */
  resolveImage: (target: string) => ImageDecision
}

export interface BlockedItem {
  kind: 'image' | 'link' | 'tag' | 'comment'
  /** 被阻止的原始目标或标签名 */
  target: string
  reason: BlockedReason
}

export interface SanitizeResult {
  html: string
  blocked: BlockedItem[]
  /** 需要按需加载的项目内图片相对路径（已去重，保持出现顺序） */
  assets: string[]
  /** 已获授权的外部图片地址（已去重）；渲染进程据此决定是否加载 */
  remoteAssets: string[]
  /** 项目内链接的相对路径（已去重） */
  projectLinks: string[]
  /** 交给系统浏览器的外链数量 */
  externalLinkCount: number
  /** 自审发现的违规项；非空表示输出不可信 */
  violations: string[]
}

/** 允许出现在输出中的标签。列表之外的标签整体丢弃。 */
const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'kbd',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

const VOID_TAGS = new Set(['br', 'hr', 'img'])

/** 携带主动内容的标签：整体丢弃并记录。 */
const ACTIVE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'video',
  'audio',
  'source',
  'track',
  'canvas',
  'template',
  'portal',
  'noscript'
])

/** 每个标签允许的属性。未列出的属性（含所有 `on*` 与 `style`）一律丢弃。 */
const TAG_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'tabindex', 'role']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  p: new Set(['align']),
  div: new Set(['align']),
  span: new Set(['align']),
  table: new Set(['align', 'width']),
  tr: new Set(['align']),
  td: new Set(['align', 'colspan', 'rowspan']),
  th: new Set(['align', 'colspan', 'rowspan']),
  ol: new Set(['start']),
  details: new Set(['open'])
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 属性值转义：比文本更严格，同时屏蔽反引号与换行。 */
function escapeAttribute(value: string): string {
  return escapeHtml(value)
    .replace(/`/g, '&#96;')
    .replace(/[\n\r]/g, '&#10;')
}

/**
 * 标签与属性词法。每次调用新建实例，避免模块级 `lastIndex` 在递归渲染中互相干扰。
 */
function createTagTokenRe(): RegExp {
  return /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g
}

function createAttributeRe(): RegExp {
  return /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
}

interface RenderContext {
  policy: SanitizePolicy
  blocked: BlockedItem[]
  assets: Set<string>
  remoteAssets: Set<string>
  projectLinks: Set<string>
  externalLinkCount: number
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * 过滤一段原始 HTML，只保留白名单标签与属性。
 * 非标签文本按普通文本转义输出。
 */
function sanitizeRawHtml(raw: string, ctx: RenderContext): string {
  let output = ''
  let cursor = 0
  const tagRe = createTagTokenRe()

  for (let match = tagRe.exec(raw); match !== null; match = tagRe.exec(raw)) {
    const textBefore = raw.slice(cursor, match.index)
    if (textBefore.length > 0) output += escapeHtml(textBefore)
    cursor = match.index + match[0].length

    const isClosing = match[1] === '/'
    const tagName = (match[2] as string).toLowerCase()
    const rawAttributes = match[3] ?? ''

    // 原始文本元素（script／style／svg／iframe 等）：连同内容整体丢弃。
    // 只丢标签会使其源码以可见文字形式出现在预览中。
    if (!isClosing && RAW_TEXT_TAGS.has(tagName)) {
      const closing = new RegExp(`</${tagName}\\s*>`, 'i')
      const rest = raw.slice(tagRe.lastIndex)
      const closingMatch = closing.exec(rest)
      tagRe.lastIndex =
        closingMatch === null ? raw.length : tagRe.lastIndex + closingMatch.index + closingMatch[0].length
      // 游标必须同步跳过被丢弃的内容，否则正文会在循环结束后以文本形式补回
      cursor = tagRe.lastIndex
      ctx.blocked.push({ kind: 'tag', target: tagName, reason: 'raw-html' })
      continue
    }

    if (ACTIVE_TAGS.has(tagName) || !ALLOWED_TAGS.has(tagName)) {
      // 标签整体丢弃，仅保留其内部文字（文字在下一轮循环中按文本转义）
      ctx.blocked.push({ kind: 'tag', target: tagName, reason: 'raw-html' })
      continue
    }

    if (isClosing) {
      if (!VOID_TAGS.has(tagName)) output += `</${tagName}>`
      continue
    }

    const allowed = TAG_ATTRIBUTES[tagName]
    const attributes: string[] = []

    if (allowed && rawAttributes.length > 0) {
      const attributeRe = createAttributeRe()
      for (
        let attributeMatch = attributeRe.exec(rawAttributes);
        attributeMatch !== null;
        attributeMatch = attributeRe.exec(rawAttributes)
      ) {
        const name = (attributeMatch[1] as string).toLowerCase()
        if (!allowed.has(name)) continue
        const value = attributeMatch[2] === undefined ? '' : unquote(attributeMatch[2] as string)

        if (name === 'href') {
          const decision = ctx.policy.resolveLink(value)
          if (decision.kind === 'external') {
            // 外链不写入 href：渲染进程通过 data-external-url 交给系统浏览器。
            // 这样「输出中不存在可加载 URL 属性」成为可断言的不变量。
            attributes.push(
              `data-external-url="${escapeAttribute(decision.href)}"`,
              'data-external="true"',
              'tabindex="0"',
              'role="link"'
            )
            ctx.externalLinkCount += 1
          } else if (decision.kind === 'anchor') {
            attributes.push(`href="${escapeAttribute(decision.href)}"`)
          } else if (decision.kind === 'project') {
            ctx.projectLinks.add(decision.relativePath)
            attributes.push(
              `data-project-path="${escapeAttribute(decision.relativePath)}"`,
              'tabindex="0"',
              'role="link"'
            )
          } else {
            ctx.blocked.push({ kind: 'link', target: value, reason: decision.reason })
          }
          continue
        }

        if (name === 'src') {
          const decision = ctx.policy.resolveImage(value)
          if (decision.kind === 'asset') {
            ctx.assets.add(decision.relativePath)
            attributes.push(`data-asset="${escapeAttribute(decision.relativePath)}"`)
          } else if (decision.kind === 'remote') {
            ctx.remoteAssets.add(decision.url)
            attributes.push(`data-remote="${escapeAttribute(decision.url)}"`)
          } else {
            ctx.blocked.push({ kind: 'image', target: value, reason: decision.reason })
          }
          continue
        }

        attributes.push(`${name}="${escapeAttribute(value)}"`)
      }
    }

    // 图片若未取得可用的资源引用，则不输出任何可加载标签
    if (
      tagName === 'img' &&
      !attributes.some((item) => item.startsWith('data-asset=') || item.startsWith('data-remote='))
    ) {
      continue
    }

    const attributeText = attributes.length > 0 ? ` ${attributes.join(' ')}` : ''
    output += `<${tagName}${attributeText}>`
  }

  const tail = raw.slice(cursor)
  if (tail.length > 0) output += escapeHtml(tail)
  return output
}

/** 丢弃 HTML 注释、CDATA 与处理指令，并记录。 */
function stripComments(source: string, ctx: RenderContext): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, () => {
      ctx.blocked.push({ kind: 'comment', target: '<!-- -->', reason: 'raw-html' })
      return ''
    })
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, () => {
      ctx.blocked.push({ kind: 'comment', target: '<![CDATA[]]>', reason: 'raw-html' })
      return ''
    })
    .replace(/<[?!][^>]*>/g, () => {
      ctx.blocked.push({ kind: 'comment', target: '<? >', reason: 'raw-html' })
      return ''
    })
}

function renderInlineNodes(nodes: InlineNode[], ctx: RenderContext): string {
  let output = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        output += escapeHtml(node.value)
        break
      case 'code':
        output += `<code>${escapeHtml(node.value)}</code>`
        break
      case 'strong':
        output += `<strong>${renderInlineNodes(node.children, ctx)}</strong>`
        break
      case 'em':
        output += `<em>${renderInlineNodes(node.children, ctx)}</em>`
        break
      case 'del':
        output += `<del>${renderInlineNodes(node.children, ctx)}</del>`
        break
      case 'break':
        output += '<br>'
        break
      case 'html':
        output += sanitizeRawHtml(stripComments(node.raw, ctx), ctx)
        break
      case 'link': {
        const inner = renderInlineNodes(node.children, ctx)
        const decision = ctx.policy.resolveLink(node.href)
        if (decision.kind === 'external') {
          ctx.externalLinkCount += 1
          output += `<a data-external-url="${escapeAttribute(decision.href)}" data-external="true" tabindex="0" role="link">${inner}</a>`
        } else if (decision.kind === 'anchor') {
          output += `<a href="${escapeAttribute(decision.href)}">${inner}</a>`
        } else if (decision.kind === 'project') {
          ctx.projectLinks.add(decision.relativePath)
          output += `<a data-project-path="${escapeAttribute(decision.relativePath)}" class="md-project-link" tabindex="0" role="link">${inner}</a>`
        } else {
          ctx.blocked.push({ kind: 'link', target: node.href, reason: decision.reason })
          output += `<span class="md-blocked" data-blocked="link">${inner}</span>`
        }
        break
      }
      case 'image': {
        const decision = ctx.policy.resolveImage(node.src)
        const titleText = node.title === null ? '' : ` title="${escapeAttribute(node.title)}"`
        if (decision.kind === 'asset') {
          ctx.assets.add(decision.relativePath)
          output += `<img data-asset="${escapeAttribute(decision.relativePath)}" alt="${escapeAttribute(node.alt)}"${titleText}>`
        } else if (decision.kind === 'remote') {
          ctx.remoteAssets.add(decision.url)
          output += `<img data-remote="${escapeAttribute(decision.url)}" alt="${escapeAttribute(node.alt)}"${titleText}>`
        } else {
          ctx.blocked.push({ kind: 'image', target: node.src, reason: decision.reason })
          const label = node.alt.length > 0 ? escapeHtml(node.alt) : '图片'
          output += `<span class="md-blocked" data-blocked="image" data-blocked-reason="${decision.reason}">${label}</span>`
        }
        break
      }
    }
  }
  return output
}

function renderBlocks(blocks: BlockNode[], ctx: RenderContext): string {
  let output = ''
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        output += `<h${block.level}>${renderInlineNodes(block.children, ctx)}</h${block.level}>`
        break
      case 'paragraph':
        output += `<p>${renderInlineNodes(block.children, ctx)}</p>`
        break
      case 'hr':
        output += '<hr>'
        break
      case 'code': {
        const language =
          block.language === null ? '' : ` data-language="${escapeAttribute(block.language.replace(/[^\w+#.-]/g, ''))}"`
        output += `<pre${language}><code>${escapeHtml(block.value)}</code></pre>`
        break
      }
      case 'blockquote':
        output += `<blockquote>${renderBlocks(block.children, ctx)}</blockquote>`
        break
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul'
        const startAttribute = block.ordered && block.start !== 1 ? ` start="${block.start}"` : ''
        const items = block.items
          .map((item) => {
            // 单段落项直接内联渲染，避免 <li><p>…</p></li> 的冗余层级
            const inner =
              item.length === 1 && item[0]?.type === 'paragraph'
                ? renderInlineNodes((item[0] as { children: InlineNode[] }).children, ctx)
                : renderBlocks(item, ctx)
            return `<li>${inner}</li>`
          })
          .join('')
        output += `<${tag}${startAttribute}>${items}</${tag}>`
        break
      }
      case 'table': {
        const header = block.header.map((cell) => `<th>${renderInlineNodes(cell, ctx)}</th>`).join('')
        const rows = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineNodes(cell, ctx)}</td>`).join('')}</tr>`)
          .join('')
        output += `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`
        break
      }
      case 'htmlBlock':
        output += sanitizeRawHtml(stripComments(block.raw, ctx), ctx)
        break
    }
  }
  return output
}

/**
 * 自审：重新解析输出 HTML，逐项确认标签、属性与 URL 均在白名单内。
 * 返回违规描述；空数组表示输出可信。
 *
 * 注意：自审接受 `class`、`rel` 与 `data-*`，因为这些属性由本模块自己写入
 * 用于标注（阻止占位、外链、资源引用），但**不接受它们来自不可信输入**——
 * 输入侧的属性白名单只有 `TAG_ATTRIBUTES`。
 */
const AUDIT_EXTRA_ATTRIBUTES = new Set(['class', 'rel'])

export function auditHtml(html: string): string[] {
  const violations: string[] = []
  const tagRe = createTagTokenRe()

  for (let match = tagRe.exec(html); match !== null; match = tagRe.exec(html)) {
    const tagName = (match[2] as string).toLowerCase()
    if (!ALLOWED_TAGS.has(tagName)) {
      violations.push(`白名单外标签：<${tagName}>`)
      continue
    }
    const rawAttributes = match[3] ?? ''
    const allowed = TAG_ATTRIBUTES[tagName]
    const attributeRe = createAttributeRe()
    for (
      let attributeMatch = attributeRe.exec(rawAttributes);
      attributeMatch !== null;
      attributeMatch = attributeRe.exec(rawAttributes)
    ) {
      const name = (attributeMatch[1] as string).toLowerCase()
      if (name.startsWith('on')) {
        violations.push(`事件属性：${tagName}[${name}]`)
        continue
      }
      if (name === 'style') {
        violations.push(`内联样式：${tagName}[style]`)
        continue
      }
      if (name === 'src' || name === 'href' || name === 'xlink:href') {
        const rawValue = attributeMatch[2] === undefined ? '' : unquote(attributeMatch[2] as string)
        const isInternalAnchor = name === 'href' && rawValue.startsWith('#')
        if (!isInternalAnchor) violations.push(`可加载 URL 属性未清理：${tagName}[${name}]`)
        continue
      }
      if (name.startsWith('data-')) continue
      if (AUDIT_EXTRA_ATTRIBUTES.has(name)) continue
      if (allowed && !allowed.has(name)) {
        violations.push(`白名单外属性：${tagName}[${name}]`)
      }
    }
  }

  for (const forbidden of ['<script', '<iframe', '<object', '<embed', '<svg', '<math', '<link', '<meta']) {
    if (html.toLowerCase().includes(forbidden)) violations.push(`输出包含 ${forbidden}`)
  }

  return violations
}

export function sanitizeMarkdown(blocks: BlockNode[], policy: SanitizePolicy): SanitizeResult {
  const ctx: RenderContext = {
    policy,
    blocked: [],
    assets: new Set(),
    remoteAssets: new Set(),
    projectLinks: new Set(),
    externalLinkCount: 0
  }

  const html = renderBlocks(blocks, ctx)
  const violations = auditHtml(html)

  return {
    html,
    blocked: ctx.blocked,
    assets: [...ctx.assets],
    remoteAssets: [...ctx.remoteAssets],
    projectLinks: [...ctx.projectLinks],
    externalLinkCount: ctx.externalLinkCount,
    violations
  }
}

/** 提取「第一个有效正文段落」的纯文本，用于项目卡片简介（设计稿 4.1）。 */
export function firstParagraphText(blocks: BlockNode[]): string | null {
  for (const block of blocks) {
    if (block.type !== 'paragraph') continue
    const text = inlineToPlainText(block.children).replace(/\s+/g, ' ').trim()
    if (text.length > 0) return text
  }
  return null
}
