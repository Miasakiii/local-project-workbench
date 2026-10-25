import assert from 'node:assert/strict'
import test from 'node:test'
import { countByGroup, countUniqueFiles, parsePorcelainV2 } from '../../src/main/modules/git-parse'

function porcelain(records: string[]): Buffer {
  return Buffer.from(`${records.join('\0')}\0`, 'utf8')
}

const FILE_FIELDS = 'N... 100644 100644 100644 aaaa bbbb'

test('解析分支、未暂存、已暂存、未跟踪与冲突条目', () => {
  const parsed = parsePorcelainV2(
    porcelain([
      '# branch.oid abc123',
      '# branch.head main',
      `1 .M ${FILE_FIELDS} path with space.txt`,
      `1 M. ${FILE_FIELDS} staged.txt`,
      '? untracked.txt',
      `u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt`
    ])
  )

  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.detached, false)
  assert.equal(parsed.entries.length, 4)
  assert.deepEqual(
    parsed.entries.map((entry) => ({ group: entry.group, path: entry.relativePath })),
    [
      { group: 'unstaged', path: 'path with space.txt' },
      { group: 'staged', path: 'staged.txt' },
      { group: 'untracked', path: 'untracked.txt' },
      { group: 'conflicted', path: 'conflict.txt' }
    ]
  )
})

test('同一文件可同时出现在已暂存与未暂存', () => {
  const parsed = parsePorcelainV2(
    porcelain([`1 MM ${FILE_FIELDS} both.txt`])
  )
  assert.deepEqual(countByGroup(parsed.entries), {
    unstaged: 1,
    staged: 1,
    untracked: 0,
    conflicted: 0
  })
  assert.equal(countUniqueFiles(parsed.entries), 1)
})

test('重命名条目携带原路径', () => {
  const parsed = parsePorcelainV2(
    porcelain([`2 R. ${FILE_FIELDS} cccc new-name.txt`, 'old-name.txt'])
  )
  assert.equal(parsed.entries.length, 1)
  const entry = parsed.entries[0]
  assert.ok(entry)
  assert.equal(entry.group, 'staged')
  assert.equal(entry.relativePath, 'new-name.txt')
  assert.equal(entry.originalPath, 'old-name.txt')
})

test('detached HEAD 不伪装成分支名', () => {
  const parsed = parsePorcelainV2(
    porcelain(['# branch.head (detached)', '# branch.oid abc123'])
  )
  assert.equal(parsed.branch, null)
  assert.equal(parsed.detached, true)
  assert.equal(parsed.entries.length, 0)
})

test('空输入不产生条目', () => {
  const parsed = parsePorcelainV2(Buffer.from('', 'utf8'))
  assert.equal(parsed.branch, null)
  assert.equal(parsed.detached, false)
  assert.equal(parsed.entries.length, 0)
})

test('分组统计与去重文件数一致', () => {
  const parsed = parsePorcelainV2(
    porcelain([
      `1 .M ${FILE_FIELDS} a.txt`,
      `1 MM ${FILE_FIELDS} a.txt`,
      '? b.txt'
    ])
  )
  assert.deepEqual(countByGroup(parsed.entries), {
    unstaged: 2,
    staged: 1,
    untracked: 1,
    conflicted: 0
  })
  assert.equal(countUniqueFiles(parsed.entries), 2)
})
