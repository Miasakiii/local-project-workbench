/**
 * M0-4 技术验证：Markdown 隔离。
 *
 * 验证目标（对应设计稿 4.3 与推进计划 M0-4 退出条件）：
 *   1. 脚本与可执行 HTML 不进入预览输出
 *   2. 路径穿越（含百分号编码）被阻止
 *   3. 符号链接／目录联接指向项目外时被阻止
 *   4. 绝对路径、盘符、UNC、设备名写法被阻止
 *   5. 网络资源默认不加载，且不产生任何可加载 URL 属性
 *   6. 项目内相对图片与链接正常放行
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-loader/register.mjs scripts/verify-markdown-isolation-m0.mts
 *   （附加 --keep 保留临时样例目录，便于人工检查）
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectReadme, extractSummary, readAsset, renderMarkdownFile } from '../src/main/modules/markdown-preview.ts'
import { checkRelativeShape } from '../src/main/security/path-guard.ts'

const keepFixture = process.argv.includes('--keep')
const fixtureRoot = join(tmpdir(), 'workbench-m0-4-fixture')
const projectDir = join(fixtureRoot, 'project')
const outsideDir = join(fixtureRoot, 'outside')

/** 1x1 透明 PNG */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

const README = String.raw`# 演示项目

<p align="center"><img src="assets/logo.png" width="120" alt="logo"></p>

普通段落，包含 <script>alert('xss')</script> 内联脚本。

<img src=x onerror="alert(1)">
<iframe src="https://evil.example/frame"></iframe>
<object data="evil.swf"></object>
<embed src="evil.swf">
<svg onload="alert(1)"><circle r="1"/></svg>
<style>body{background:red}</style>
<base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<img src="\\evil-host\share\raw.png" alt="raw-unc">
<a href="javascript:alert(1)">javascript 链接</a>
<a href="https://example.com/ok" style="color:red">合法外链</a>
<!-- 注释应被移除 -->

## 图片

![合法图片](assets/logo.png)
![根相对图片](/assets/logo.png)
![网络图片](https://evil.example/track.png)
![协议相对图片](//evil.example/track.png)
![脚本协议图片](javascript:alert(1))
![data 图片](data:image/png;base64,AAAA)
![本地文件图片](file:///C:/Windows/win.ini)
![穿越图片](../../outside/secret.png)
![编码穿越图片](..%2F..%2Foutside%2Fsecret.png)
![联接图片](junction/secret.png)
![UNC 图片](\\evil-host\share\track.png)
![绝对路径图片](C:\Windows\win.ini)
![SVG 图片](active.svg)

## 链接

[穿越链接](../../outside/secret.txt)
[脚本链接](javascript:void(0))
[项目内链接](docs/guide.md)
[锚点](#图片)
[合法外链](https://example.com/docs)

> 引用块内的脚本 <script>alert('quote')</script> 也应被移除。

| 列 A | 列 B |
| --- | --- |
| 1 | 2 |
`

function buildFixture(): void {
  if (existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true })

  mkdirSync(join(outsideDir), { recursive: true })
  writeFileSync(join(outsideDir, 'secret.png'), PNG_BYTES)
  writeFileSync(join(outsideDir, 'secret.txt'), '项目外机密内容')

  mkdirSync(join(projectDir, 'assets'), { recursive: true })
  mkdirSync(join(projectDir, 'docs'), { recursive: true })
  mkdirSync(join(projectDir, 'empty-dir'), { recursive: true })

  writeFileSync(join(projectDir, 'README.md'), README)
  writeFileSync(join(projectDir, 'README.zh-CN.md'), '# 中文说明\n')
  writeFileSync(join(projectDir, 'assets', 'logo.png'), PNG_BYTES)
  writeFileSync(join(projectDir, 'docs', 'guide.md'), '# 指南\n')
  writeFileSync(join(projectDir, 'active.svg'), '<svg onload="alert(1)"></svg>')

  // 目录联接：Windows 下创建联接不需要管理员权限，是最现实的项目外逃逸手法
  symlinkSync(outsideDir, join(projectDir, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')

  // 超过文本预览阈值的文件：内容置于围栏代码块内，避免拖慢解析
  const bigLines = ['```', ...Array.from({ length: 100_000 }, () => 'x'.repeat(58)), '```', '']
  writeFileSync(join(projectDir, 'big.md'), bigLines.join('\n'))

  // 超过图片预览阈值的图片
  writeFileSync(join(projectDir, 'oversized.png'), Buffer.alloc(21 * 1024 * 1024))
  writeFileSync(join(projectDir, 'oversized.md'), '![超大图片](oversized.png)\n')
}

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

function hasNotice(
  notices: Array<{ kind: string; target: string; reason: string }>,
  kind: string,
  target: string,
  reason: string
): boolean {
  return notices.some((notice) => notice.kind === kind && notice.target === target && notice.reason === reason)
}

function run(): void {
  buildFixture()

  const doc = renderMarkdownFile({ projectId: 'fixture', projectRoot: projectDir, relativePath: 'README.md' })
  const html = doc.html

  /* ---------- 一、输出侧不变量 ---------- */

  check('净化自审无违规', doc.violations.length === 0, doc.violations.join('；') || '无')
  check('输出不含 <script', !/<script/i.test(html), '已确认')
  check('输出不含 <iframe', !/<iframe/i.test(html), '已确认')
  check('输出不含 <object / <embed', !/<object/i.test(html) && !/<embed/i.test(html), '已确认')
  check('输出不含 <svg / <math', !/<svg/i.test(html) && !/<math/i.test(html), '已确认')
  check('输出不含事件属性', !/\son[a-z]+\s*=/i.test(html), '已确认')
  check('输出不含内联样式', !/style\s*=/i.test(html), '已确认')
  check('输出不含 javascript: 协议', !/javascript:/i.test(html), '已确认')
  check('输出不含 http-equiv', !/http-equiv/i.test(html), '已确认')
  check('输出不含 <base', !/<base/i.test(html), '已确认')
  check('脚本正文未泄漏为可见文本', !/alert/i.test(html), '已确认')
  check('HTML 注释未残留', !html.includes('注释应被移除'), '已确认')
  check('输出不含任何 src 属性', !/\ssrc\s*=/i.test(html), '已确认（可加载 URL 结构性缺席）')

  /* ---------- 二、合法内容放行 ---------- */

  const imgCount = (html.match(/<img/g) ?? []).length
  const allAssetsOk = imgCount === 3 && (html.match(/data-asset="assets\/logo\.png"/g) ?? []).length === 3
  check('项目内图片放行且去重', allAssetsOk, `<img> 数量=${imgCount}，data-asset 引用=3`)
  check('资源清单去重', doc.assets.length === 1 && doc.assets[0] === 'assets/logo.png', doc.assets.join(', '))
  check('允许的原始 HTML 属性保留', html.includes('<p align="center">'), '保留 <p align="center">')
  check('锚点链接保留', html.includes('href="#'), '保留站内锚点')
  check('项目内链接识别', doc.projectLinks.includes('docs/guide.md'), doc.projectLinks.join(', '))
  check('合法外链计入外链', doc.externalLinkCount >= 1, `externalLinkCount=${doc.externalLinkCount}`)
  check('默认策略下无外部图片资源', doc.remoteAssets.length === 0, `remoteAssets=${doc.remoteAssets.length}`)
  // 键盘可达（a11y）：外链/项目内链接输出 tabindex + role=link，但**不引入可加载 href**
  const hrefAttrs = html.match(/href="[^"]*"/g) ?? []
  check(
    '输出 href 仅限站内锚点',
    hrefAttrs.every((value) => value.startsWith('href="#')),
    hrefAttrs.join(' ')
  )
  check(
    '外链/项目内链接可键盘聚焦 tabindex="0"',
    (html.match(/tabindex="0"/g) ?? []).length >= 2,
    `tabindex×${(html.match(/tabindex="0"/g) ?? []).length}`
  )
  check(
    '外链/项目内链接带 role=link',
    (html.match(/role="link"/g) ?? []).length >= 2,
    `role=link×${(html.match(/role="link"/g) ?? []).length}`
  )
  check(
    '外链经 data-external-url 承载且无 href',
    html.includes('data-external-url="https://example.com/') && !html.includes('href="https://example.com/'),
    '已确认'
  )

  /* ---------- 三、恶意样例逐项阻止 ---------- */

  const blockedImages: Array<[string, string]> = [
    ['../../outside/secret.png', 'outside-project'],
    ['..%2F..%2Foutside%2Fsecret.png', 'outside-project'],
    ['junction/secret.png', 'outside-project'],
    [String.raw`\evil-host\share\track.png`, 'outside-project'],
    [String.raw`\\evil-host\share\raw.png`, 'outside-project'],
    [String.raw`C:\Windows\win.ini`, 'outside-project'],
    ['javascript:alert(1)', 'unsafe-protocol'],
    ['data:image/png;base64,AAAA', 'unsafe-protocol'],
    ['file:///C:/Windows/win.ini', 'unsafe-protocol'],
    ['//evil.example/track.png', 'unsafe-protocol'],
    ['https://evil.example/track.png', 'remote-resource'],
    ['active.svg', 'unsupported-format'],
    ['x', 'invalid-path']
  ]
  for (const [target, reason] of blockedImages) {
    check(`阻止图片 ${target}`, hasNotice(doc.blocked, 'image', target, reason), `期望原因=${reason}`)
  }

  check(
    '阻止穿越链接',
    hasNotice(doc.blocked, 'link', '../../outside/secret.txt', 'outside-project'),
    '期望原因=outside-project'
  )
  check(
    '阻止脚本协议链接',
    hasNotice(doc.blocked, 'link', 'javascript:void(0)', 'unsafe-protocol'),
    '期望原因=unsafe-protocol'
  )
  check(
    '阻止原始 HTML 中的脚本协议链接',
    hasNotice(doc.blocked, 'link', 'javascript:alert(1)', 'unsafe-protocol'),
    '期望原因=unsafe-protocol'
  )

  for (const tag of ['script', 'iframe', 'object', 'embed', 'svg', 'style', 'base', 'meta']) {
    check(`移除主动标签 <${tag}>`, hasNotice(doc.blocked, 'tag', tag, 'raw-html'), '已记录阻止')
  }
  check(
    '移除 HTML 注释',
    doc.blocked.some((notice) => notice.kind === 'comment'),
    '已记录阻止'
  )

  /* ---------- 四、读取阶段二次校验 ---------- */

  const okAsset = readAsset({ projectRoot: projectDir, relativePath: 'assets/logo.png' })
  check(
    '项目内图片可读取为 data URL',
    okAsset.status === 'ok' &&
      okAsset.mime === 'image/png' &&
      (okAsset.dataUrl ?? '').startsWith('data:image/png;base64,'),
    `status=${okAsset.status} bytes=${okAsset.bytes}`
  )

  const readStageCases: Array<[string, string]> = [
    ['junction/secret.png', 'blocked'],
    ['../../outside/secret.png', 'blocked'],
    ['..%2F..%2Foutside%2Fsecret.png', 'blocked'],
    [String.raw`C:\Windows\win.ini`, 'blocked'],
    [String.raw`\\evil-host\share\track.png`, 'blocked'],
    ['active.svg', 'unsupported-format'],
    ['oversized.png', 'too-large']
  ]
  for (const [target, status] of readStageCases) {
    const result = readAsset({ projectRoot: projectDir, relativePath: target })
    check(`读取阶段阻止 ${target}`, result.status === status, `status=${result.status}（期望 ${status}）`)
  }

  /* ---------- 五、路径形态检查 ---------- */

  const shapeCases: Array<[string, boolean, string]> = [
    ['docs/guide.md', true, '合法相对路径'],
    ['../outside/secret.txt', false, 'traversal'],
    [String.raw`..\..\secret.txt`, false, 'traversal'],
    [String.raw`C:\Windows\win.ini`, false, 'drive-relative'],
    ['C:/Windows/win.ini', false, 'absolute'],
    ['/etc/passwd', false, 'absolute'],
    [String.raw`\\host\share\file`, false, 'unc'],
    ['a\0b', false, 'nul-byte'],
    ['CON', false, 'device-path'],
    ['nul.txt', false, 'device-path'],
    ['a.', false, 'trailing-dot-or-space'],
    ['a ', false, 'trailing-dot-or-space'],
    ['docs/file.txt:stream', false, 'ads'],
    ['a:b', false, 'drive-relative'],
    ['', false, 'empty']
  ]
  for (const [input, expectedOk, label] of shapeCases) {
    const shape = checkRelativeShape(input)
    check(`路径形态：${label}`, shape.ok === expectedOk, `ok=${shape.ok} rejection=${shape.rejection ?? '无'}`)
  }

  /* ---------- 六、项目授权后才加载网络图片 ---------- */

  const allowedDoc = renderMarkdownFile({
    projectId: 'fixture',
    projectRoot: projectDir,
    relativePath: 'README.md',
    policy: { allowNetworkImages: true, allowedImageHosts: [] }
  })
  check(
    '授权后网络图片进入待加载清单',
    allowedDoc.remoteAssets.includes('https://evil.example/track.png'),
    `remoteAssets=${allowedDoc.remoteAssets.join(', ')}`
  )
  check('授权后仍不输出 src 属性', !/\ssrc\s*=/i.test(allowedDoc.html), '结构性保证未放松')
  check(
    '授权后仍不加载域名未列入白名单的图片',
    (() => {
      const restricted = renderMarkdownFile({
        projectId: 'fixture',
        projectRoot: projectDir,
        relativePath: 'README.md',
        policy: { allowNetworkImages: true, allowedImageHosts: ['cdn.example.com'] }
      })
      return restricted.remoteAssets.length === 0
    })(),
    '域名白名单生效'
  )

  /* ---------- 七、README 识别与阈值 ---------- */

  const detection = detectReadme(projectDir)
  check(
    'README 识别命中根目录',
    detection.selected === 'README.md' && detection.location === 'root',
    `selected=${String(detection.selected)}`
  )
  check(
    '多语言变体被识别',
    detection.variants.some((variant) => variant.relativePath === 'README.zh-CN.md' && variant.locale === 'zh-CN'),
    detection.variants.map((variant) => `${variant.relativePath}(${String(variant.locale)})`).join(', ')
  )
  const preferred = detectReadme(projectDir, 'docs/guide.md')
  check('用户指定介绍文件优先', preferred.selected === 'docs/guide.md', `selected=${String(preferred.selected)}`)
  const missing = detectReadme(join(projectDir, 'empty-dir'))
  check('无 README 时明确返回未找到', missing.selected === null && missing.variants.length === 0, 'selected=null')

  const bigDoc = renderMarkdownFile({ projectId: 'fixture', projectRoot: projectDir, relativePath: 'big.md' })
  check(
    '超过文本阈值时标记截断',
    bigDoc.truncated === true && bigDoc.sourceBytes > 5 * 1024 * 1024,
    `sourceBytes=${bigDoc.sourceBytes} truncated=${String(bigDoc.truncated)}`
  )

  const oversizedDoc = renderMarkdownFile({
    projectId: 'fixture',
    projectRoot: projectDir,
    relativePath: 'oversized.md'
  })
  check(
    '超过图片阈值时阻止自动加载',
    hasNotice(oversizedDoc.blocked, 'image', 'oversized.png', 'oversized'),
    `notices=${oversizedDoc.blocked.map((notice) => notice.reason).join(', ')}`
  )

  const summary = extractSummary(projectDir, 'README.md')
  check('简介提取跳过标题与 HTML 块', summary?.includes('普通段落') === true, `summary=${String(summary)}`)

  /* ---------- 输出 ---------- */

  console.log('=== M0-4 技术验证：Markdown 隔离 ===')
  console.log(`样例目录：${fixtureRoot}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }

  console.log(`\n合计：${passed}/${checks.length} 项通过`)

  const violations = doc.violations
  if (violations.length > 0) {
    console.log(`\n净化自审违规：\n${violations.join('\n')}`)
  }
  console.log(`\n阻止清单（${doc.blocked.length} 项）：`)
  for (const notice of doc.blocked) {
    console.log(`  - [${notice.kind}] ${notice.target} → ${notice.reason}`)
  }

  if (!keepFixture) rmSync(fixtureRoot, { recursive: true, force: true })
  else console.log(`\n样例目录已保留：${fixtureRoot}`)

  process.exit(passed === checks.length ? 0 : 1)
}

run()
