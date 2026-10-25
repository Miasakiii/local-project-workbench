import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  abortBatch,
  childRelativePath,
  isSameOrDescendant,
  leafOf,
  messageForRejection,
  reasonForRejection,
  summarize
} from '../../src/main/modules/file-op-common'
import { classifyError, classifyWriteError, discriminateTrashFailure } from '../../src/main/modules/file-op-errors'
import type { FileOperationItem } from '../../src/shared/types'

function item(status: FileOperationItem['status'], relativePath: string): FileOperationItem {
  return {
    relativePath,
    targetRelativePath: null,
    status,
    reason: status === 'ok' ? null : 'io-error',
    message: relativePath
  }
}

test('summarize 逐项计数且不把失败并入成功', () => {
  const result = summarize([item('ok', 'a'), item('failed', 'b'), item('skipped', 'c'), item('ok', 'd')])
  assert.equal(result.ok, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.aborted, false)
  assert.equal(result.items.length, 4)
})

test('abortBatch 明确整批中止原因', () => {
  const result = abortBatch('trash-unavailable', '回收站不可用')
  assert.equal(result.aborted, true)
  assert.equal(result.abortReason, 'trash-unavailable')
  assert.equal(result.ok, 0)
  assert.equal(result.failed, 0)
})

test('路径样式辅助函数覆盖边界', () => {
  assert.equal(childRelativePath('', 'a.txt'), 'a.txt')
  assert.equal(childRelativePath('dir', 'a.txt'), 'dir/a.txt')
  assert.equal(leafOf('a/b/c.txt'), 'c.txt')
  assert.equal(leafOf('a/b/'), 'b')
  assert.equal(isSameOrDescendant('a/b', 'a/b'), true)
  assert.equal(isSameOrDescendant('a/b', 'a/b/c'), true)
  assert.equal(isSameOrDescendant('a/b', 'a/bc'), false)
})

test('路径拒绝原因与文案保持既有映射', () => {
  assert.equal(reasonForRejection('traversal'), 'outside-project')
  assert.equal(reasonForRejection('outside-project'), 'outside-project')
  assert.equal(reasonForRejection('not-found'), 'not-found')
  assert.equal(reasonForRejection('permission-denied'), 'permission-denied')
  assert.equal(reasonForRejection('ads'), 'invalid-path')
  assert.match(messageForRejection('unc', '\\\\srv\\share'), /UNC/)
  assert.match(messageForRejection('traversal', '../x'), /项目之外/)
  assert.match(messageForRejection('permission-denied', 'x'), /没有权限/)
})

test('errno 在回收站与写目标两种语境下含义不同', () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  assert.equal(classifyError(denied).reason, 'permission-denied')
  assert.match(classifyError(denied).message, /源文件已保留/)

  const exists = Object.assign(new Error('exists'), { code: 'EEXIST' })
  assert.equal(classifyWriteError(exists, '复制').reason, 'name-conflict')
  assert.match(classifyWriteError(exists, '复制').message, /未覆盖/)

  const unknown = classifyWriteError(new Error('boom'), '新建文件')
  assert.equal(unknown.reason, 'io-error')
  assert.match(unknown.message, /新建文件失败/)
})

test('回收站失败按项级、整体不可用与可访问性区分', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-trash-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'file.txt')
  writeFileSync(file, 'content')

  const itemLevel = discriminateTrashFailure(file, Object.assign(new Error('busy'), { code: 'EBUSY' }))
  assert.equal(itemLevel.abort, false)
  assert.equal(itemLevel.reason, 'in-use')

  const unsupported = discriminateTrashFailure(file, new Error('operation not supported'))
  assert.equal(unsupported.abort, true)
  assert.equal(unsupported.reason, 'trash-unavailable')

  const accessibleButFailed = discriminateTrashFailure(file, new Error('Operation was aborted'))
  assert.equal(accessibleButFailed.abort, true)
  assert.equal(accessibleButFailed.reason, 'trash-unavailable')

  const missing = discriminateTrashFailure(join(dir, 'missing.txt'), new Error('unknown'))
  assert.equal(missing.abort, false)
  assert.equal(missing.reason, 'not-found')
})
