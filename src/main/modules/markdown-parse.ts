/**
 * Markdown 解析（第一版，无第三方依赖）。
 *
 * 为什么自行实现而不用现成渲染器：
 * 1. README 是不可信内容，净化必须发生在**结构层**而非字符串替换层。自建 AST
 *    可以让「允许什么」成为显式白名单，而不是依赖净化器对某渲染器输出的补丁。
 * 2. 主进程与渲染进程共用同一份解析结果，避免「先渲染再净化」的两段式信任链。
 *
 * 覆盖范围（CommonMark 子集）：ATX 标题、段落、围栏代码块、缩进代码块、
 * 引用块、有序／无序列表（支持嵌套）、水平线、管道表格、原始 HTML 块，
 * 以及行内的代码、强调、删除线、链接、图片、自动链接、硬换行、转义。
 *
 * 已知未覆盖（第一版接受，记录于 M0-4 验证记录）：引用式链接与脚注、
 * Setext 标题、HTML 实体全集、行内数学公式。
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  | { type: 'del'; children: InlineNode[] }
  | { type: 'link'; href: string; title: string | null; children: InlineNode[] }
  | { type: 'image'; src: string; title: string | null; alt: string }
  | { type: 'html'; raw: string }
  | { type: 'break' }

export type BlockNode =
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'code'; language: string | null; value: string }
  | { type: 'blockquote'; children: BlockNode[] }
  | { type: 'list'; ordered: boolean; start: number; items: BlockNode[][] }
  | { type: 'hr' }
  | { type: 'table'; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'htmlBlock'; raw: string }

const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const BLOCKQUOTE_RE = /^ {0,3}>[ ]?/
const ULIST_RE = /^( {0,3})([-*+])[ \t]+/
const OLIST_RE = /^( {0,3})(\d{1,9})([.)])[ \t]+/
const TABLE_DELIM_RE = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/
const HTML_BLOCK_RE = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)(\s|\/|>|$)/
const INLINE_HTML_RE = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/

/**
 * 原始文本元素：其内容不是普通文本，而是不可解析的原始内容（脚本、样式、矢量图等）。
 * 处理策略是**整体丢弃**（含内容），而不是只丢标签留下正文——否则脚本源码会以
 * 可见文字形式出现在预览中。
 */
export const RAW_TEXT_TAGS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noscript',
  'template',
  'svg',
  'math'
])

/** 查找原始文本元素的结束位置；未找到闭合标签时返回字符串末尾（整体丢弃）。 */
export function findRawTextEnd(source: string, tagName: string, from: number): number {
  const closing = new RegExp(`</${tagName}\\s*>`, 'i')
  const match = closing.exec(source.slice(from))
  return match === null ? source.length : from + match.index + match[0].length
}

export function normalizeMarkdown(source: string): string {
  return source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

/** 剥离引用前缀，返回剥离后的行数组（保持行数对齐，空行为空串）。 */
function stripQuotePrefix(lines: string[]): string[] {
  return lines.map((line) => (BLOCKQUOTE_RE.test(line) ? line.replace(BLOCKQUOTE_RE, '') : line))
}

function parseBlocks(lines: string[]): BlockNode[] {
  const blocks: BlockNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] as string

    if (isBlank(line)) {
      index += 1
      continue
    }

    // 围栏代码块：内容原样保留，不做行内解析
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1] as string
      const language = (fence[2] ?? '').trim()
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const candidate = lines[index] as string
        const closing = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`)
        if (closing.test(candidate)) {
          index += 1
          break
        }
        body.push(candidate)
        index += 1
      }
      blocks.push({
        type: 'code',
        language: language.length > 0 ? language : null,
        value: body.join('\n')
      })
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] as string).length,
        children: parseInline(heading[2] ?? '')
      })
      index += 1
      continue
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const collected: string[] = []
      while (index < lines.length) {
        const candidate = lines[index] as string
        if (BLOCKQUOTE_RE.test(candidate)) {
          collected.push(candidate)
          index += 1
          continue
        }
        // 引用块内的惰性延续：非空行且不是新块起始，则并入引用
        if (!isBlank(candidate) && !HEADING_RE.test(candidate) && !HR_RE.test(candidate)) {
          collected.push(candidate)
          index += 1
          continue
        }
        break
      }
      blocks.push({ type: 'blockquote', children: parseBlocks(stripQuotePrefix(collected)) })
      continue
    }

    // 管道表格：当前行含分隔符且下一行是合法分隔行
    const next = lines[index + 1]
    if (line.includes('|') && next !== undefined && TABLE_DELIM_RE.test(next) && next.includes('-')) {
      const header = splitTableRow(line)
      const rows: InlineNode[][][] = []
      index += 2
      while (index < lines.length && !isBlank(lines[index] as string)) {
        const row = lines[index] as string
        if (!row.includes('|')) break
        rows.push(splitTableRow(row))
        index += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    // HTML 注释块：整体作为一个原始块，交由净化层移除
    if (/^ {0,3}<!--/.test(line)) {
      const collected: string[] = []
      while (index < lines.length) {
        const candidate = lines[index] as string
        collected.push(candidate)
        index += 1
        if (candidate.includes('-->')) break
      }
      blocks.push({ type: 'htmlBlock', raw: collected.join('\n') })
      continue
    }

    // 原始 HTML 块：交由净化层按白名单过滤
    const htmlBlock = HTML_BLOCK_RE.exec(line)
    if (htmlBlock) {
      const tagName = (htmlBlock[1] as string).toLowerCase()

      // 原始文本元素整体收集（含闭合标签），避免内容以文字形式泄漏到预览
      if (RAW_TEXT_TAGS.has(tagName)) {
        const closing = new RegExp(`</${tagName}\\s*>`, 'i')
        const collected: string[] = []
        while (index < lines.length) {
          const candidate = lines[index] as string
          collected.push(candidate)
          index += 1
          if (closing.test(candidate)) break
        }
        blocks.push({ type: 'htmlBlock', raw: collected.join('\n') })
        continue
      }

      const collected: string[] = []
      while (index < lines.length && !isBlank(lines[index] as string)) {
        collected.push(lines[index] as string)
        index += 1
      }
      blocks.push({ type: 'htmlBlock', raw: collected.join('\n') })
      continue
    }

    const ulist = ULIST_RE.exec(line)
    const olist = OLIST_RE.exec(line)
    if (ulist || olist) {
      const ordered = olist !== null
      const start = ordered ? Number.parseInt((olist as RegExpExecArray)[2] as string, 10) : 1
      const items: BlockNode[][] = []

      while (index < lines.length) {
        const candidate = lines[index] as string
        const match = ordered ? OLIST_RE.exec(candidate) : ULIST_RE.exec(candidate)
        if (!match) break

        const markerLength = match[0].length
        const itemLines: string[] = [candidate.slice(markerLength)]
        index += 1

        // 收集该项的后续行：缩进大于标记宽度，或空行，或惰性延续
        while (index < lines.length) {
          const follower = lines[index] as string
          if (isBlank(follower)) {
            itemLines.push('')
            index += 1
            continue
          }
          if (ULIST_RE.test(follower) || OLIST_RE.test(follower) || HEADING_RE.test(follower)) break
          const indent = follower.length - follower.trimStart().length
          if (indent >= Math.min(markerLength, 4) || indent > 0) {
            itemLines.push(follower.replace(/^ {1,4}/, ''))
            index += 1
            continue
          }
          break
        }

        while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1] as string)) {
          itemLines.pop()
        }
        items.push(parseBlocks(itemLines))
      }

      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    // 缩进代码块（4 空格）
    if (/^ {4}/.test(line)) {
      const body: string[] = []
      while (index < lines.length) {
        const candidate = lines[index] as string
        if (/^ {4}/.test(candidate)) {
          body.push(candidate.slice(4))
          index += 1
          continue
        }
        if (isBlank(candidate)) {
          body.push('')
          index += 1
          continue
        }
        break
      }
      while (body.length > 0 && isBlank(body[body.length - 1] as string)) body.pop()
      blocks.push({ type: 'code', language: null, value: body.join('\n') })
      continue
    }

    // 段落：直到空行或下一个块起始
    const paragraph: string[] = []
    while (index < lines.length) {
      const candidate = lines[index] as string
      if (isBlank(candidate)) break
      if (
        paragraph.length > 0 &&
        (HEADING_RE.test(candidate) ||
          HR_RE.test(candidate) ||
          FENCE_RE.test(candidate) ||
          BLOCKQUOTE_RE.test(candidate) ||
          ULIST_RE.test(candidate) ||
          OLIST_RE.test(candidate))
      ) {
        break
      }
      paragraph.push(candidate)
      index += 1
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) })
  }

  return blocks
}

function splitTableRow(line: string): InlineNode[][] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((cell) => parseInline(cell.trim()))
}

/** 解析行内内容为节点序列。 */
export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer.length > 0) {
      nodes.push({ type: 'text', value: buffer })
      buffer = ''
    }
  }

  while (index < source.length) {
    const char = source[index] as string

    // 转义
    if (char === '\\' && index + 1 < source.length && ESCAPABLE.includes(source[index + 1] as string)) {
      buffer += source[index + 1]
      index += 2
      continue
    }

    // 硬换行：行尾两个及以上空格，或反斜杠换行
    if (char === '\n') {
      const trailingSpaces = / {2,}$/.test(buffer)
      if (trailingSpaces) {
        buffer = buffer.replace(/ {2,}$/, '')
        flush()
        nodes.push({ type: 'break' })
      } else {
        buffer += ' '
      }
      index += 1
      continue
    }
    if (char === '\\' && source[index + 1] === '\n') {
      flush()
      nodes.push({ type: 'break' })
      index += 2
      continue
    }

    // 代码跨度
    if (char === '`') {
      const runMatch = /^`+/.exec(source.slice(index))
      const run = runMatch ? runMatch[0] : '`'
      const closingIndex = source.indexOf(run, index + run.length)
      if (closingIndex !== -1) {
        flush()
        const raw = source.slice(index + run.length, closingIndex)
        nodes.push({ type: 'code', value: raw.replace(/^ (.*) $/, '$1') })
        index = closingIndex + run.length
        continue
      }
    }

    // 图片
    if (char === '!' && source[index + 1] === '[') {
      const parsed = parseLinkLike(source, index + 1)
      if (parsed) {
        flush()
        nodes.push({
          type: 'image',
          src: parsed.destination,
          title: parsed.title,
          alt: inlineToPlainText(parsed.children)
        })
        index = parsed.end
        continue
      }
    }

    // 链接
    if (char === '[') {
      const parsed = parseLinkLike(source, index)
      if (parsed) {
        flush()
        nodes.push({
          type: 'link',
          href: parsed.destination,
          title: parsed.title,
          children: parsed.children
        })
        index = parsed.end
        continue
      }
    }

    // 自动链接与行内 HTML
    if (char === '<') {
      const rest = source.slice(index)
      const autoMatch = /^<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*)>/.exec(rest)
      if (autoMatch) {
        flush()
        const target = autoMatch[1] as string
        nodes.push({
          type: 'link',
          href: target,
          title: null,
          children: [{ type: 'text', value: target }]
        })
        index += autoMatch[0].length
        continue
      }
      const emailMatch = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(rest)
      if (emailMatch) {
        flush()
        const address = emailMatch[1] as string
        nodes.push({
          type: 'link',
          href: `mailto:${address}`,
          title: null,
          children: [{ type: 'text', value: address }]
        })
        index += emailMatch[0].length
        continue
      }
      // 原始文本元素：连同内容整体丢弃。必须在通用标签匹配之前判断，
      // 否则 `<script>` 会先被当作普通标签取出，其正文将泄漏为可见文本。
      const tagOpen = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)
      if (tagOpen && RAW_TEXT_TAGS.has((tagOpen[1] as string).toLowerCase())) {
        const tagName = (tagOpen[1] as string).toLowerCase()
        const stop = findRawTextEnd(source, tagName, index)
        flush()
        nodes.push({ type: 'html', raw: source.slice(index, stop) })
        index = stop
        continue
      }

      // 注释与声明：整体作为原始片段，交由净化层移除
      if (rest.startsWith('<!--')) {
        const end = rest.indexOf('-->', 4)
        const stop = end === -1 ? source.length : index + end + 3
        flush()
        nodes.push({ type: 'html', raw: source.slice(index, stop) })
        index = stop
        continue
      }
      if (rest.startsWith('<!') || rest.startsWith('<?')) {
        const end = rest.indexOf('>')
        const stop = end === -1 ? source.length : index + end + 1
        flush()
        nodes.push({ type: 'html', raw: source.slice(index, stop) })
        index = stop
        continue
      }

      const htmlMatch = INLINE_HTML_RE.exec(rest)
      if (htmlMatch) {
        flush()
        nodes.push({ type: 'html', raw: htmlMatch[0] })
        index += htmlMatch[0].length
        continue
      }
    }

    // 强调与删除线
    const emphasis = matchEmphasis(source, index)
    if (emphasis) {
      flush()
      nodes.push(emphasis.node)
      index = emphasis.end
      continue
    }

    buffer += char
    index += 1
  }

  flush()
  return nodes
}

interface LinkLike {
  destination: string
  title: string | null
  children: InlineNode[]
  end: number
}

/** 解析 `[text](dest "title")` 形式。不支持引用式链接（第一版已知限制）。 */
function parseLinkLike(source: string, bracketStart: number): LinkLike | null {
  if (source[bracketStart] !== '[') return null

  let depth = 0
  let closeBracket = -1
  for (let i = bracketStart; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) {
        closeBracket = i
        break
      }
    }
  }
  if (closeBracket === -1) return null
  if (source[closeBracket + 1] !== '(') return null

  let parenDepth = 0
  let closeParen = -1
  for (let i = closeBracket + 1; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '(') parenDepth += 1
    else if (char === ')') {
      parenDepth -= 1
      if (parenDepth === 0) {
        closeParen = i
        break
      }
    }
  }
  if (closeParen === -1) return null

  const inner = source.slice(closeBracket + 2, closeParen).trim()
  const destMatch = /^(<[^>]*>|[^\s]*)(?:\s+(["'])([\s\S]*?)\2)?$/.exec(inner)
  if (!destMatch) return null

  let destination = destMatch[1] as string
  if (destination.startsWith('<') && destination.endsWith('>')) {
    destination = destination.slice(1, -1)
  }
  destination = destination.replace(/\\([\\()])/g, '$1')

  return {
    destination,
    title: destMatch[3] ?? null,
    children: parseInline(source.slice(bracketStart + 1, closeBracket)),
    end: closeParen + 1
  }
}

interface EmphasisMatch {
  node: InlineNode
  end: number
}

function matchEmphasis(source: string, index: number): EmphasisMatch | null {
  const definitions: Array<{ marker: string; type: 'strong' | 'em' | 'del' }> = [
    { marker: '**', type: 'strong' },
    { marker: '__', type: 'strong' },
    { marker: '~~', type: 'del' },
    { marker: '*', type: 'em' },
    { marker: '_', type: 'em' }
  ]

  for (const { marker, type } of definitions) {
    if (!source.startsWith(marker, index)) continue
    const closing = source.indexOf(marker, index + marker.length)
    if (closing === -1) continue
    const inner = source.slice(index + marker.length, closing)
    if (inner.length === 0) continue
    if (type === 'em' && marker === '_' && /^\w/.test(inner) && /\w$/.test(inner)) continue
    return {
      node: { type, children: parseInline(inner) } as InlineNode,
      end: closing + marker.length
    }
  }

  return null
}

/** 把行内节点降级为纯文本，用于图片替代文本与简介提取。 */
export function inlineToPlainText(nodes: InlineNode[]): string {
  let output = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        output += node.value
        break
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        output += inlineToPlainText(node.children)
        break
      case 'image':
        output += node.alt
        break
      case 'break':
        output += ' '
        break
      case 'html':
        break
    }
  }
  return output
}

export function parseMarkdown(source: string): BlockNode[] {
  return parseBlocks(normalizeMarkdown(source).split('\n'))
}
