import assert from 'node:assert/strict'
import test from 'node:test'
import {
  countDiffLines,
  parseUnifiedDiff,
  synthesizeAddedDiff,
  synthesizeContentDiff
} from '../../src/main/modules/git-diff-parse'

test('空差异返回 unchanged', () => {
  const parsed = parseUnifiedDiff('')
  assert.equal(parsed.status, 'unchanged')
  assert.equal(parsed.hunks.length, 0)
  assert.equal(parsed.addedLines, 0)
  assert.equal(parsed.removedLines, 0)
})

test('解析标准 hunk 的行号与增删计数', () => {
  const parsed = parseUnifiedDiff(
    [
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-old two',
      '+new two',
      ' line three',
      ''
    ].join('\n')
  )

  assert.equal(parsed.hunks.length, 1)
  assert.equal(parsed.addedLines, 1)
  assert.equal(parsed.removedLines, 1)

  const hunk = parsed.hunks[0]
  assert.ok(hunk)
  assert.deepEqual(
    hunk.lines.map((line) => line.kind),
    ['context', 'remove', 'add', 'context']
  )
  assert.equal(hunk.lines[0]?.oldLine, 1)
  assert.equal(hunk.lines[1]?.oldLine, 2)
  assert.equal(hunk.lines[2]?.newLine, 2)
  assert.equal(hunk.lines[3]?.oldLine, 3)
})

test('hunk 内的 --- / +++ 是内容行，不是文件头', () => {
  const parsed = parseUnifiedDiff(
    ['@@ -1,2 +1,2 @@', '--- old', '+++ new', ''].join('\n')
  )
  const hunk = parsed.hunks[0]
  assert.ok(hunk)
  assert.deepEqual(
    hunk.lines.map((line) => ({ kind: line.kind, text: line.text })),
    [
      { kind: 'remove', text: '-- old' },
      { kind: 'add', text: '++ new' }
    ]
  )
  assert.equal(parsed.addedLines, 1)
  assert.equal(parsed.removedLines, 1)
})

test('识别二进制、新增、删除与重命名标记', () => {
  assert.equal(parseUnifiedDiff('Binary files a/x and b/x differ\n').binary, true)
  assert.equal(parseUnifiedDiff('new file mode 100644\n').status, 'added')
  assert.equal(parseUnifiedDiff('deleted file mode 100644\n').status, 'deleted')

  const renamed = parseUnifiedDiff('rename from old.txt\nrename to new.txt\n')
  assert.equal(renamed.status, 'renamed')
  assert.equal(renamed.originalPath, 'old.txt')
})

test('三路差异被标记为 combined 且不按普通 hunk 解析', () => {
  const parsed = parseUnifiedDiff('@@@ -1,1 -1,1 +1,1 @@@\n')
  assert.equal(parsed.combined, true)
  assert.equal(parsed.hunks.length, 0)
})

test('当前内容视图把所有行标为上下文', () => {
  const parsed = synthesizeContentDiff('alpha\nbeta\n')
  const hunk = parsed.hunks[0]
  assert.ok(hunk)
  assert.equal(hunk.lines.length, 2)
  assert.deepEqual(
    hunk.lines.map((line) => line.kind),
    ['context', 'context']
  )
  assert.equal(hunk.lines[0]?.oldLine, null)
  assert.equal(hunk.lines[0]?.newLine, 1)
  assert.equal(hunk.lines[1]?.newLine, 2)
})

test('未跟踪文件视图把所有行标为新增', () => {
  const parsed = synthesizeAddedDiff('alpha\nbeta\n')
  assert.equal(parsed.status, 'added')
  assert.equal(parsed.addedLines, 2)
  assert.equal(parsed.removedLines, 0)
  assert.equal(parsed.hunks[0]?.lines.length, 2)
  assert.equal(parsed.hunks[0]?.lines[0]?.kind, 'add')
})

test('countDiffLines 与解析计数一致', () => {
  const parsed = parseUnifiedDiff(
    ['@@ -1,2 +1,2 @@', ' same', '-old', '+new', ''].join('\n')
  )
  assert.deepEqual(countDiffLines(parsed.hunks), {
    added: parsed.addedLines,
    removed: parsed.removedLines
  })
})
