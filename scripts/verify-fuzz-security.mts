/**
 * 安全敏感组件的 fuzz / property-based 测试。
 *
 * 覆盖两个自研安全模块：
 * 1. **路径守卫**（`path-guard.ts`）：对随机生成的路径做形态检查与归属检查，
 *    断言不变量——任何包含穿越意图的路径都必须被拒绝，合法路径不得误判。
 * 2. **Markdown 净化层**（`markdown-sanitize.ts`）：对随机生成的 HTML/Markdown
 *    输入做净化，断言结构性不变量——输出永不含 `<script`、事件属性、`src` 属性
 *    等可加载／主动内容。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-fuzz-security.mts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BlockNode, parseMarkdown } from '../src/main/modules/markdown-parse.ts'
import { auditHtml, sanitizeMarkdown, type SanitizePolicy } from '../src/main/modules/markdown-sanitize.ts'
import { checkRelativeShape, resolveProjectPath } from '../src/main/security/path-guard.ts'

/* ==================== 测试框架 ==================== */

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

/* ==================== 确定性伪随机数生成器 ==================== */

/** 简单的 LCG，确保测试可重复 */
function createRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff
    return state / 0x7fffffff
  }
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

function randomPick<T>(random: () => number, items: T[]): T {
  return items[randomInt(random, 0, items.length - 1)] as T
}

/* ==================== 路径守卫 fuzz ==================== */

/** 路径穿越攻击向量（文件系统层面） */
const TRAVERSAL_VECTORS = [
  '../etc/passwd',
  '..\\..\\windows\\system32',
  '....//....//etc/passwd',
  '....\\....\\etc/passwd',
  '..\\..\\..\\..\\..\\etc/passwd',
  'a/../../b',
  'a/b/../../../c',
  './../etc/passwd',
  'foo/./../../etc/passwd',
  'C:\\Windows\\System32\\config\\SAM',
  'C:/Windows/System32/config/SAM',
  '\\\\evil-host\\share\\file',
  '//evil-host/share/file',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '\\\\.\\PhysicalDrive0',
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'LPT1',
  'file.txt:stream',
  'file.txt ',
  'file.txt.',
  '..',
  ''
]

/** 合法路径（不应被误判） */
const LEGITIMATE_PATHS = [
  'README.md',
  'src/index.ts',
  'docs/guide.md',
  'a/b/c/d.txt',
  'file-name.txt',
  'file_name.txt',
  'file.name.txt',
  'UPPER.TXT',
  'mixed-Case_File.md',
  'node_modules/package/index.js',
  'deeply/nested/directory/structure/file.ext'
]

/** 生成随机路径字符串 */
function generateRandomPath(random: () => number): string {
  const segments: string[] = []
  const count = randomInt(random, 1, 8)
  const segmentChoices = [
    'a', 'b', 'c', 'dir', 'file.txt', '..', '.', 'sub', 'x', 'y',
    'a.txt', 'b.md', 'c.ts', 'nested', 'deep', 'path', 'to', 'file'
  ]
  for (let i = 0; i < count; i += 1) {
    segments.push(randomPick(random, segmentChoices))
  }
  const separator = random() > 0.5 ? '/' : '\\'
  return segments.join(separator)
}

function runPathGuardFuzz(): void {
  const root = join(tmpdir(), 'workbench-fuzz-path-guard')
  const projectDir = join(root, 'project')
  const outsideDir = join(root, 'outside')

  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# test\n')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret\n')

  /* ---------- 已知攻击向量必须全部被拒绝 ---------- */

  let allTraversalRejected = true
  const traversalFailures: string[] = []
  for (const vector of TRAVERSAL_VECTORS) {
    const shape = checkRelativeShape(vector)
    // 空串与 '.' 在形态检查中可能通过（归一化为空），但归属检查会拒绝
    const resolution = resolveProjectPath(projectDir, vector, { mustExist: false })
    if (shape.ok && resolution.ok) {
      allTraversalRejected = false
      traversalFailures.push(`${vector} → 未被拒绝`)
    }
  }
  check(
    '路径守卫：已知攻击向量全部被拒绝',
    allTraversalRejected,
    allTraversalRejected ? `${TRAVERSAL_VECTORS.length} 个向量全部拒绝` : traversalFailures.join('; ')
  )

  /* ---------- 合法路径不得被误判 ---------- */

  let allLegitPassed = true
  const legitFailures: string[] = []
  for (const path of LEGITIMATE_PATHS) {
    const resolution = resolveProjectPath(projectDir, path, { mustExist: false })
    if (!resolution.ok) {
      allLegitPassed = false
      legitFailures.push(`${path} → ${resolution.rejection}: ${resolution.detail}`)
    }
  }
  check(
    '路径守卫：合法路径不被误判',
    allLegitPassed,
    allLegitPassed ? `${LEGITIMATE_PATHS.length} 个合法路径全部通过` : legitFailures.join('; ')
  )

  /* ---------- 随机 fuzz：穿越意图必须被拒绝 ---------- */

  const random = createRandom(42)
  let fuzzTotal = 0
  const fuzzFailures: string[] = []

  for (let i = 0; i < 500; i += 1) {
    const path = generateRandomPath(random)
    const shape = checkRelativeShape(path)
    if (!shape.ok) {
      // 形态检查已拒绝，跳过
      fuzzTotal += 1
      continue
    }
    // 形态通过：检查归一化后的路径是否包含穿越
    const normalized = shape.normalized
    const hasTraversal = normalized.split('/').includes('..')
    if (hasTraversal) {
      // 归一化后仍含 .. 说明是 `a/../../b` 形式，归属检查必须拒绝
      const resolution = resolveProjectPath(projectDir, path, { mustExist: false })
      fuzzTotal += 1
      if (resolution.ok) {
        fuzzFailures.push(`${path} → 归一化后含 .. 但归属检查通过`)
      }
    } else {
      fuzzTotal += 1
    }
  }

  check(
    '路径守卫：500 次随机 fuzz 无逃逸',
    fuzzFailures.length === 0,
    fuzzFailures.length === 0
      ? `${fuzzTotal} 次随机路径全部正确处理`
      : `${fuzzFailures.length} 次失败: ${fuzzFailures.slice(0, 3).join('; ')}`
  )

  /* ---------- isInside 边界：..foo 不得误判 ---------- */

  // 项目根下名为 ..foo 的文件是合法的，不应被 isInside 误判为项目外
  const dotDotFoo = resolveProjectPath(projectDir, '..foo', { mustExist: false })
  check(
    '路径守卫：..foo 合法文件不被误判为项目外',
    dotDotFoo.ok,
    dotDotFoo.ok ? '通过' : `${dotDotFoo.rejection}: ${dotDotFoo.detail}`
  )

  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 忽略
  }
}

/* ==================== Markdown 净化层 fuzz ==================== */

/** 默认策略：拒绝所有链接和图片（用于 fuzz 测试） */
const FUZZ_POLICY: SanitizePolicy = {
  resolveLink: (target) => {
    if (target.startsWith('#')) return { kind: 'anchor', href: target }
    if (target.startsWith('javascript:')) return { kind: 'blocked', reason: 'unsafe-protocol' }
    return { kind: 'blocked', reason: 'remote-resource' }
  },
  resolveImage: () => ({ kind: 'blocked', reason: 'remote-resource' })
}

/** XSS 攻击向量 */
const XSS_VECTORS = [
  '<script>alert(1)</script>',
  '<script src="evil.js"></script>',
  '<img src=x onerror=alert(1)>',
  '<img/src="x"/onerror="alert(1)">',
  '<svg onload=alert(1)>',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="data:text/html,<script>alert(1)</script>">click</a>',
  '<style>body{background:url(javascript:alert(1))}</style>',
  '<link rel="stylesheet" href="javascript:alert(1)">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<form action="javascript:alert(1)"><input type="submit"></form>',
  '<input onfocus=alert(1) autofocus>',
  '<marquee onstart=alert(1)>x</marquee>',
  '<details open ontoggle=alert(1)>',
  '<video><source onerror="alert(1)"></video>',
  '<audio src=x onerror=alert(1)>',
  '<body onload=alert(1)>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '![img](javascript:alert(1))',
  '[link](javascript:alert(1))',
  '[link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '<math><mtext></mtext><script>alert(1)</script></math>',
  '<!--<script>alert(1)</script>-->',
  '<?php echo "xss"; ?>',
  '<xss id=x tabindex=1 onactivate=alert(1)></xss>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<IMG SRC="javascript:alert(1);">',
  '<IMG SRC=javascript:alert(1)>',
  '<IMG SRC=JaVaScRiPt:alert(1)>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<<SCRIPT>alert(1);//<</SCRIPT>',
  '<img src=`x`onerror=`alert(1)`>',
  '<img src=x onerror=\'alert(1)\'>',
  '<img src=x onerror="alert(1)"//>',
  '<x onxxx=alert(1)>',
  '<x on:x=alert(1)>',
  '<x xmlns:on="x" on:load="alert(1)">',
]

/** 生成随机 HTML 片段 */
function generateRandomHtml(random: () => number): string {
  const tags = ['div', 'span', 'p', 'a', 'img', 'script', 'style', 'iframe', 'svg', 'input', 'form', 'button']
  const attrs = ['onclick', 'onerror', 'onload', 'href', 'src', 'style', 'class', 'id', 'data-x', 'onmouseover']
  const values = ['alert(1)', 'javascript:alert(1)', 'x', '#', 'data:text/html,x', '', 'on', 'true']
  const parts: string[] = []

  const count = randomInt(random, 1, 5)
  for (let i = 0; i < count; i += 1) {
    const tag = randomPick(random, tags)
    const attrCount = randomInt(random, 0, 3)
    const attrStrings: string[] = []
    for (let j = 0; j < attrCount; j += 1) {
      const attr = randomPick(random, attrs)
      const value = randomPick(random, values)
      attrStrings.push(`${attr}="${value}"`)
    }
    const attrStr = attrStrings.length > 0 ? ` ${attrStrings.join(' ')}` : ''
    parts.push(`<${tag}${attrStr}>content</${tag}>`)
  }

  return parts.join('\n')
}

function runSanitizerFuzz(): void {
  /* ---------- 已知 XSS 向量必须全部被净化 ---------- */

  let allXssBlocked = true
  const xssFailures: string[] = []

  for (const vector of XSS_VECTORS) {
    const blocks = parseMarkdown(vector)
    const result = sanitizeMarkdown(blocks, FUZZ_POLICY)
    const violations = auditHtml(result.html)

    // 断言：输出不含 <script、事件属性、src 属性
    const lowerHtml = result.html.toLowerCase()
    const hasScript = lowerHtml.includes('<script')
    const hasEventHandler = /\son\w+=/i.test(result.html)
    const hasSrc = /\ssrc\s*=/i.test(result.html)
    const hasAuditViolation = violations.length > 0

    if (hasScript || hasEventHandler || hasSrc || hasAuditViolation) {
      allXssBlocked = false
      const reasons: string[] = []
      if (hasScript) reasons.push('script')
      if (hasEventHandler) reasons.push('event-handler')
      if (hasSrc) reasons.push('src-attr')
      if (hasAuditViolation) reasons.push(`audit:${violations[0]}`)
      xssFailures.push(`${vector.slice(0, 40)} → ${reasons.join(',')}`)
    }
  }

  check(
    '净化层：已知 XSS 向量全部被净化',
    allXssBlocked,
    allXssBlocked ? `${XSS_VECTORS.length} 个向量全部净化` : `${xssFailures.length} 个失败: ${xssFailures.slice(0, 3).join('; ')}`
  )

  /* ---------- 随机 fuzz：输出永不含危险构造 ---------- */

  const random = createRandom(123)
  let fuzzClean = true
  const fuzzFailures: string[] = []

  for (let i = 0; i < 500; i += 1) {
    const html = generateRandomHtml(random)
    const blocks = parseMarkdown(html)
    const result = sanitizeMarkdown(blocks, FUZZ_POLICY)

    const lowerHtml = result.html.toLowerCase()
    const hasScript = lowerHtml.includes('<script')
    const hasEventHandler = /\son\w+=/i.test(result.html)
    const hasSrc = /\ssrc\s*=/i.test(result.html)
    const hasUnsafeProtocol = /javascript:|data:text\/html|vbscript:/i.test(result.html)

    if (hasScript || hasEventHandler || hasSrc || hasUnsafeProtocol) {
      fuzzClean = false
      const reasons: string[] = []
      if (hasScript) reasons.push('script')
      if (hasEventHandler) reasons.push('event-handler')
      if (hasSrc) reasons.push('src-attr')
      if (hasUnsafeProtocol) reasons.push('unsafe-protocol')
      fuzzFailures.push(`#${i}: ${html.slice(0, 60)} → ${reasons.join(',')}`)
    }
  }

  check(
    '净化层：500 次随机 fuzz 输出无危险构造',
    fuzzClean,
    fuzzClean ? '500 次随机输入全部净化' : `${fuzzFailures.length} 次失败: ${fuzzFailures.slice(0, 3).join('; ')}`
  )

  /* ---------- 结构性不变量：输出永不含 src 属性 ---------- */

  let noSrcInvariant = true
  const srcFailures: string[] = []

  for (const vector of XSS_VECTORS) {
    const blocks = parseMarkdown(vector)
    const result = sanitizeMarkdown(blocks, FUZZ_POLICY)
    if (/\ssrc\s*=/i.test(result.html)) {
      noSrcInvariant = false
      srcFailures.push(vector.slice(0, 40))
    }
  }

  check(
    '净化层：结构性不变量——输出永不含 src 属性',
    noSrcInvariant,
    noSrcInvariant ? '全部通过' : `${srcFailures.length} 个失败: ${srcFailures.slice(0, 3).join('; ')}`
  )
}

/* ==================== Markdown 解析器资源边界 ==================== */

/** 迭代遍历块级 AST，返回引用块的最大嵌套深度（避免测试自身递归爆栈）。 */
function maxBlockquoteDepth(blocks: BlockNode[]): number {
  let max = 0
  const stack: Array<{ nodes: BlockNode[]; depth: number }> = [{ nodes: blocks, depth: 0 }]
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    for (const node of item.nodes) {
      if (node.type === 'blockquote') {
        max = Math.max(max, item.depth + 1)
        stack.push({ nodes: node.children, depth: item.depth + 1 })
      } else if (node.type === 'list') {
        for (const children of node.items) {
          stack.push({ nodes: children, depth: item.depth })
        }
      }
    }
  }
  return max
}

function runParserBoundsCheck(): void {
  /* ---------- 大量未闭合方括号：不得退化为平方级扫描 ---------- */

  const bracketInput = '['.repeat(40_000)
  const bracketStarted = performance.now()
  let bracketOk = true
  let bracketDetail = ''
  try {
    const blocks = parseMarkdown(bracketInput)
    const elapsed = performance.now() - bracketStarted
    bracketOk = blocks.length === 1 && blocks[0]?.type === 'paragraph' && elapsed < 2000
    bracketDetail = `blocks=${blocks.length} 用时=${elapsed.toFixed(0)}ms`
  } catch (error) {
    bracketOk = false
    bracketDetail = error instanceof Error ? error.message : String(error)
  }
  check('解析器：4 万未闭合方括号在预算内完成', bracketOk, bracketDetail)

  /* ---------- 深层引用：限深降级，不得栈溢出 ---------- */

  const quoteInput = `${'>'.repeat(12_000)} 深层引用 <script>alert(1)</script>`
  const quoteStarted = performance.now()
  let quoteOk = true
  let quoteDetail = ''
  try {
    const blocks = parseMarkdown(quoteInput)
    const depth = maxBlockquoteDepth(blocks)
    const sanitized = sanitizeMarkdown(blocks, FUZZ_POLICY)
    const violations = auditHtml(sanitized.html)
    const elapsed = performance.now() - quoteStarted
    quoteOk =
      depth <= 65 &&
      elapsed < 2000 &&
      violations.length === 0 &&
      !/<script/i.test(sanitized.html) &&
      sanitized.html.includes('&lt;script&gt;')
    quoteDetail = `depth=${depth} violations=${violations.length} 用时=${elapsed.toFixed(0)}ms`
  } catch (error) {
    quoteOk = false
    quoteDetail = error instanceof Error ? error.message : String(error)
  }
  check('解析器：深层引用被限深、降级内容仍被转义', quoteOk, quoteDetail)

  /* ---------- 配对缓存不得改变原始扫描语义 ---------- */

  const mixedBlocks = parseMarkdown('`[` ] [link](docs/guide.md)')
  const mixedChildren = mixedBlocks[0]?.type === 'paragraph' ? mixedBlocks[0].children : []
  const mixedLink = mixedChildren.find((node) => node.type === 'link')
  check(
    '解析器：代码跨度中的括号不干扰后续链接配对',
    mixedLink?.type === 'link' && mixedLink.href === 'docs/guide.md',
    mixedLink?.type === 'link' ? mixedLink.href : '未识别为链接'
  )
}

/* ==================== 主入口 ==================== */

function main(): void {
  console.log('=== 安全敏感组件 fuzz / property-based 测试 ===')
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  runPathGuardFuzz()
  runSanitizerFuzz()
  runParserBoundsCheck()

  /* ---------- 输出 ---------- */

  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${checks.length} 项通过`)

  const ok = passed === checks.length
  process.exit(ok ? 0 : 1)
}

main()
