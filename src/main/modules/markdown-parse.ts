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
/** 行内匹配统一使用 sticky 正则并复用，避免在每个 `<` 处复制剩余字符串（O(n²)）。 */
const AUTO_LINK_AT_RE = /<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*)>/y
const EMAIL_AT_RE = /<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/y
const TAG_OPEN_AT_RE = /<([a-zA-Z][a-zA-Z0-9-]*)/y
const INLINE_HTML_AT_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/y

function matchAt(pattern: RegExp, source: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(source)
}

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
  const closing = new RegExp(`</${tagName}\\s*>`, 'gi')
  closing.lastIndex = from
  const match = closing.exec(source)
  return match === null ? source.length : match.index + match[0].length
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

/** 块级递归深度上限：超过后按纯文本降级，避免深层引用/列表嵌套耗尽调用栈。 */
const MAX_BLOCK_DEPTH = 64
/** 行内递归深度上限：链接文本与强调可以互相嵌套，必须设界。 */
const MAX_INLINE_DEPTH = 32
/** 解析工作量预算：以源字符数为基准，限制嵌套导致的超线性放大。 */
const WORK_BUDGET_FACTOR = 16
const MIN_WORK_BUDGET = 1_000_000

interface ParseContext {
  blockDepth: number
  inlineDepth: number
  /** 共享的可变预算，所有递归层级共同消耗 */
  budget: { remaining: number }
}

function createContext(sourceLength: number): ParseContext {
  return {
    blockDepth: 0,
    inlineDepth: 0,
    budget: { remaining: Math.max(MIN_WORK_BUDGET, sourceLength * WORK_BUDGET_FACTOR) }
  }
}

function chargeWork(ctx: ParseContext, units: number): boolean {
  ctx.budget.remaining -= units
  return ctx.budget.remaining >= 0
}

function childInlineContext(ctx: ParseContext): ParseContext {
  return { blockDepth: ctx.blockDepth, inlineDepth: ctx.inlineDepth + 1, budget: ctx.budget }
}

function childBlockContext(ctx: ParseContext): ParseContext {
  return { blockDepth: ctx.blockDepth + 1, inlineDepth: ctx.inlineDepth, budget: ctx.budget }
}

/** 降级时把内容作为纯文本段落：净化层会转义文本节点，不会引入可执行内容。 */
function plainTextParagraph(lines: string[]): BlockNode {
  return { type: 'paragraph', children: [{ type: 'text', value: lines.join('\n') }] }
}

function parseBlocks(lines: string[], ctx: ParseContext): BlockNode[] {
  if (ctx.blockDepth > MAX_BLOCK_DEPTH) return [plainTextParagraph(lines)]

  let lineCharacters = 0
  for (const line of lines) lineCharacters += line.length + 1
  if (!chargeWork(ctx, lineCharacters)) return [plainTextParagraph(lines)]

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
        children: parseInlineInternal(heading[2] ?? '', ctx)
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
      blocks.push({ type: 'blockquote', children: parseBlocks(stripQuotePrefix(collected), childBlockContext(ctx)) })
      continue
    }

    // 管道表格：当前行含分隔符且下一行是合法分隔行
    const next = lines[index + 1]
    if (line.includes('|') && next !== undefined && TABLE_DELIM_RE.test(next) && next.includes('-')) {
      const header = splitTableRow(line, ctx)
      const rows: InlineNode[][][] = []
      index += 2
      while (index < lines.length && !isBlank(lines[index] as string)) {
        const row = lines[index] as string
        if (!row.includes('|')) break
        rows.push(splitTableRow(row, ctx))
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
        items.push(parseBlocks(itemLines, childBlockContext(ctx)))
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
    blocks.push({ type: 'paragraph', children: parseInlineInternal(paragraph.join('\n'), ctx) })
  }

  return blocks
}

function splitTableRow(line: string, ctx: ParseContext): InlineNode[][] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map((cell) => parseInlineInternal(cell.trim(), ctx))
}

/** 解析行内内容为节点序列。 */
export function parseInline(source: string): InlineNode[] {
  return parseInlineInternal(source, createContext(source.length))
}

/**
 * 按需查找括号配对，并缓存扫描结果。
 *
 * 此前每个 `[` 都向后重新扫描配对，未闭合的括号会让解析退化为 O(n²)。
 * 扫描语义与原实现一致（从给定位置起算、跳过转义字符、按栈配对），
 * 区别只在于一次扫描会顺带缓存途中经过的所有配对，因此总扫描量是线性的。
 * 不能改成全文全局配对：那会让代码跨度里的括号参与配对，改变合法链接的识别结果。
 */
interface PairMatcher {
  /** 返回与 openIndex 处括号配对的闭括号下标；无配对返回 -1。 */
  closeOf(openIndex: number): number
}

function createPairMatcher(source: string, opening: string, closing: string): PairMatcher {
  // 0 = 未查询；正数 = 配对下标 + 1；-1 = 已确认无配对
  let cache: Int32Array | null = null

  return {
    closeOf(openIndex: number): number {
      if (cache === null) cache = new Int32Array(source.length)
      const known = cache[openIndex] as number
      if (known !== 0) return known > 0 ? known - 1 : -1

      const stack: number[] = []
      for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index]
        if (char === '\\') {
          index += 1
          continue
        }
        if (char === opening) {
          stack.push(index)
          continue
        }
        if (char !== closing) continue
        const open = stack.pop()
        if (open === undefined) continue
        cache[open] = index + 1
        if (open === openIndex) return index
      }

      // 扫到末尾仍未闭合：本次压栈的括号都不会有闭括号
      for (const open of stack) cache[open] = -1
      cache[openIndex] = -1
      return -1
    }
  }
}

function parseInlineInternal(source: string, ctx: ParseContext): InlineNode[] {
  if (ctx.inlineDepth > MAX_INLINE_DEPTH || !chargeWork(ctx, source.length + 1)) {
    return [{ type: 'text', value: source }]
  }

  const bracketMatcher = createPairMatcher(source, '[', ']')
  const parenMatcher = createPairMatcher(source, '(', ')')
  /** 记录已确认没有闭合串的反引号 run，避免对每个未闭合反引号重复扫描到末尾 */
  const failedCodeRuns = new Set<string>()
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
      let runLength = 1
      while (source[index + runLength] === '`') runLength += 1
      const run = '`'.repeat(runLength)
      if (!failedCodeRuns.has(run)) {
        const closingIndex = source.indexOf(run, index + run.length)
        if (closingIndex !== -1) {
          flush()
          const raw = source.slice(index + run.length, closingIndex)
          nodes.push({ type: 'code', value: raw.replace(/^ (.*) $/, '$1') })
          index = closingIndex + run.length
          continue
        }
        failedCodeRuns.add(run)
      }
    }

    // 图片
    if (char === '!' && source[index + 1] === '[') {
      const parsed = parseLinkLike(source, index + 1, bracketMatcher, parenMatcher, ctx)
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
      const parsed = parseLinkLike(source, index, bracketMatcher, parenMatcher, ctx)
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
      const autoMatch = matchAt(AUTO_LINK_AT_RE, source, index)
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
      const emailMatch = matchAt(EMAIL_AT_RE, source, index)
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
      const tagOpen = matchAt(TAG_OPEN_AT_RE, source, index)
      if (tagOpen && RAW_TEXT_TAGS.has((tagOpen[1] as string).toLowerCase())) {
        const tagName = (tagOpen[1] as string).toLowerCase()
        const stop = findRawTextEnd(source, tagName, index)
        flush()
        nodes.push({ type: 'html', raw: source.slice(index, stop) })
        index = stop
        continue
      }

      // 注释与声明：整体作为原始片段，交由净化层移除
      if (source.startsWith('<!--', index)) {
        const end = source.indexOf('-->', index + 4)
        const stop = end === -1 ? source.length : end + 3
        flush()
        nodes.push({ type: 'html', raw: source.slice(index, stop) })
        index = stop
        continue
      }
      if (source.startsWith('<!', index) || source.startsWith('<?', index)) {
        const end = source.indexOf('>', index)
        const stop = end === -1 ? source.length : end + 1
        flush()
        nodes.push({ type: 'html', raw: source.slice(index, stop) })
        index = stop
        continue
      }

      const htmlMatch = matchAt(INLINE_HTML_AT_RE, source, index)
      if (htmlMatch) {
        flush()
        nodes.push({ type: 'html', raw: htmlMatch[0] })
        index += htmlMatch[0].length
        continue
      }
    }

    // 强调与删除线
    const emphasis = matchEmphasis(source, index, ctx)
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
function parseLinkLike(
  source: string,
  bracketStart: number,
  bracketMatcher: PairMatcher,
  parenMatcher: PairMatcher,
  ctx: ParseContext
): LinkLike | null {
  if (source[bracketStart] !== '[') return null

  const closeBracket = bracketMatcher.closeOf(bracketStart)
  if (closeBracket < 0) return null
  if (source[closeBracket + 1] !== '(') return null

  const closeParen = parenMatcher.closeOf(closeBracket + 1)
  if (closeParen < 0) return null

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
    children: parseInlineInternal(source.slice(bracketStart + 1, closeBracket), childInlineContext(ctx)),
    end: closeParen + 1
  }
}

interface EmphasisMatch {
  node: InlineNode
  end: number
}

function matchEmphasis(source: string, index: number, ctx: ParseContext): EmphasisMatch | null {
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
      node: { type, children: parseInlineInternal(inner, childInlineContext(ctx)) } as InlineNode,
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
  return parseBlocks(normalizeMarkdown(source).split('\n'), createContext(source.length))
}
