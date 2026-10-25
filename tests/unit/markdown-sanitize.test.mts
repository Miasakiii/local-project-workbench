import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMarkdown } from '../../src/main/modules/markdown-parse'
import { auditHtml, type SanitizePolicy, sanitizeMarkdown } from '../../src/main/modules/markdown-sanitize'

const policy: SanitizePolicy = {
  resolveLink: (target) => {
    if (target.startsWith('https://')) return { kind: 'external', href: target }
    if (target.startsWith('#')) return { kind: 'anchor', href: target }
    if (target.startsWith('./')) return { kind: 'project', relativePath: target.slice(2) }
    return { kind: 'blocked', reason: 'unsafe-protocol' }
  },
  resolveImage: (target) => {
    if (target.startsWith('https://')) return { kind: 'remote', url: target }
    if (target.startsWith('./')) return { kind: 'asset', relativePath: target.slice(2) }
    return { kind: 'blocked', reason: 'unsafe-protocol' }
  }
}

function render(markdown: string) {
  return sanitizeMarkdown(parseMarkdown(markdown), policy)
}

test('外链不写 href，只写 data-external-url', () => {
  const result = render('[site](https://example.com)')
  assert.match(result.html, /data-external-url="https:\/\/example\.com"/)
  assert.doesNotMatch(result.html, /\shref=/)
  assert.equal(result.externalLinkCount, 1)
  assert.deepEqual(result.violations, [])
})

test('项目内链接不写 href，只写 data-project-path', () => {
  const result = render('[doc](./docs/guide.md)')
  assert.match(result.html, /data-project-path="docs\/guide\.md"/)
  assert.doesNotMatch(result.html, /\shref=/)
  assert.deepEqual(result.projectLinks, ['docs/guide.md'])
  assert.deepEqual(result.violations, [])
})

test('项目内图片不写 src，只写 data-asset', () => {
  const result = render('![pic](./img/a.png)')
  assert.match(result.html, /data-asset="img\/a\.png"/)
  assert.doesNotMatch(result.html, /\ssrc=/)
  assert.deepEqual(result.assets, ['img/a.png'])
  assert.deepEqual(result.violations, [])
})

test('授权远程图片只写 data-remote，仍不产生可加载 URL', () => {
  const result = render('![remote](https://example.com/a.png)')
  assert.match(result.html, /data-remote="https:\/\/example\.com\/a\.png"/)
  assert.doesNotMatch(result.html, /\ssrc=/)
  assert.deepEqual(result.remoteAssets, ['https://example.com/a.png'])
  assert.deepEqual(result.violations, [])
})

test('不安全协议被阻止且不进入输出', () => {
  const result = render('[bad](javascript:alert)')
  assert.doesNotMatch(result.html, /javascript:/)
  assert.equal(result.blocked.length, 1)
  assert.equal(result.blocked[0]?.kind, 'link')
  assert.equal(result.blocked[0]?.reason, 'unsafe-protocol')
  assert.deepEqual(result.violations, [])
})

test('原始 HTML 不合格标签与事件属性被丢弃', () => {
  const result = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">')
  assert.doesNotMatch(result.html, /<script/i)
  assert.doesNotMatch(result.html, /onerror/i)
  assert.doesNotMatch(result.html, /\ssrc=/)
  assert.equal(result.blocked.some((item) => item.kind === 'tag' && item.target === 'script'), true)
  assert.deepEqual(result.violations, [])
})

test('HTML 注释被整体丢弃', () => {
  const result = render('<!-- secret -->')
  assert.doesNotMatch(result.html, /secret/)
  assert.equal(result.blocked.some((item) => item.kind === 'comment'), true)
  assert.deepEqual(result.violations, [])
})

test('auditHtml 能识别脚本、事件属性与可加载 URL', () => {
  assert.deepEqual(auditHtml('<p>ok</p>'), [])
  assert.notDeepEqual(auditHtml('<script>alert(1)</script>'), [])
  assert.notDeepEqual(auditHtml('<p onclick="alert(1)">ok</p>'), [])
  assert.notDeepEqual(auditHtml('<img src="https://example.com/a.png">'), [])
})

test('结构性不变量：净化输出中不存在 src 或非锚点 href', () => {
  const inputs = [
    '[site](https://example.com)',
    '[doc](./README.md)',
    '![pic](./img/a.png)',
    '![remote](https://example.com/a.png)',
    '<img src="x" onerror="alert(1)">',
    '<a href="https://example.com">x</a>'
  ]

  for (const input of inputs) {
    const result = render(input)
    assert.doesNotMatch(result.html, /\ssrc=/, input)
    assert.doesNotMatch(result.html, /\shref=/, input)
    assert.deepEqual(result.violations, [], input)
  }
})
