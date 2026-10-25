import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  checkRelativeShape,
  isInside,
  isProtectedEntry,
  isSameLocation,
  rejectionForRealpathError,
  resolveProjectPath
} from '../../src/main/security/path-guard'

const isWindows = process.platform === 'win32'

function rejectionOf(input: unknown): string | null {
  return checkRelativeShape(input).rejection
}

test('形态检查接受常规相对路径并统一分隔符', () => {
  const shape = checkRelativeShape('src\\index.ts')
  assert.equal(shape.ok, true)
  assert.equal(shape.normalized, 'src/index.ts')
  assert.equal(shape.rejection, null)

  const nested = checkRelativeShape('docs/设计 稿.md')
  assert.equal(nested.ok, true)
  assert.equal(nested.normalized, 'docs/设计 稿.md')
})

test('形态检查拒绝空值、绝对路径、穿越与 UNC', () => {
  assert.equal(rejectionOf(''), 'empty')
  assert.equal(rejectionOf(123), 'not-a-string')
  assert.equal(rejectionOf('a\0b'), 'nul-byte')
  assert.equal(rejectionOf('../etc/passwd'), 'traversal')
  assert.equal(rejectionOf('a/../../b'), 'traversal')
  assert.equal(rejectionOf('/absolute'), 'absolute')
  assert.equal(rejectionOf('C:\\Windows'), 'absolute')
  assert.equal(rejectionOf('C:relative'), 'drive-relative')
  assert.equal(rejectionOf('\\\\server\\share\\file'), 'unc')
})

test('形态检查不误判合法名字', () => {
  for (const name of ['..foo', 'README.md', 'a-b_c.txt', 'UPPER.TXT', 'deep/nested/file.ext']) {
    const shape = checkRelativeShape(name)
    assert.equal(shape.ok, true, `应接受 ${name}`)
    assert.equal(shape.rejection, null)
  }
})

test('Windows 专用拒绝规则', { skip: !isWindows }, () => {
  assert.equal(rejectionOf('CON'), 'device-path')
  assert.equal(rejectionOf('nul.txt'), 'device-path')
  assert.equal(rejectionOf('file.txt:stream'), 'ads')
  assert.equal(rejectionOf('file.txt.'), 'trailing-dot-or-space')
  assert.equal(rejectionOf('file.txt '), 'trailing-dot-or-space')
})

test('归属检查不把 ..foo 误判为项目外', () => {
  const root = isWindows ? 'C:\\project' : '/project'
  const inside = isWindows ? 'C:\\project\\..foo\\file.txt' : '/project/..foo/file.txt'
  const outside = isWindows ? 'C:\\project\\..\\outside.txt' : '/project/../outside.txt'

  assert.equal(isInside(root, root), true)
  assert.equal(isInside(root, inside), true)
  assert.equal(isInside(root, outside), false)
})

test('受保护项只按首段判定，Windows 下大小写不敏感', () => {
  assert.equal(isProtectedEntry(''), true)
  assert.equal(isProtectedEntry('.git'), true)
  assert.equal(isProtectedEntry('.git/config'), true)
  assert.equal(isProtectedEntry('sub/.git'), false)
  assert.equal(isProtectedEntry('..foo'), false)
  if (isWindows) assert.equal(isProtectedEntry('.GIT/config'), true)
})

test('resolveProjectPath 对不存在的目标仍复核归属', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-path-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'sub'))

  const allowed = resolveProjectPath(root, 'sub/new-file.txt', { mustExist: false })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.absolutePath?.endsWith('new-file.txt'), true)

  const traversal = resolveProjectPath(root, '../outside.txt', { mustExist: false })
  assert.equal(traversal.ok, false)
  assert.equal(traversal.rejection, 'traversal')

  const legitDotDotName = resolveProjectPath(root, '..foo', { mustExist: false })
  assert.equal(legitDotDotName.ok, true)
})

test('resolveProjectPath 拒绝经目录联接指向项目外', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'workbench-path-link-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))

  const root = join(base, 'project')
  const outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'secret')

  try {
    symlinkSync(outside, join(root, 'link'), isWindows ? 'junction' : 'dir')
  } catch {
    t.skip('当前环境不允许创建目录链接')
    return
  }

  const result = resolveProjectPath(root, 'link/secret.txt', { mustExist: true })
  assert.equal(result.ok, false)
  assert.equal(result.viaReparsePoint, true)
  assert.equal(result.rejection, 'outside-project')
})

test('真实路径解析失败按错误码区分不存在、无权限与 I/O 失败', () => {
  assert.equal(rejectionForRealpathError('ENOENT', 'not-found'), 'not-found')
  assert.equal(rejectionForRealpathError('ENOTDIR', 'not-found'), 'not-found')
  assert.equal(rejectionForRealpathError('EPERM', 'not-found'), 'permission-denied')
  assert.equal(rejectionForRealpathError('EACCES', 'not-found'), 'permission-denied')
  assert.equal(rejectionForRealpathError('ELOOP', 'not-found'), 'io-error')
  assert.equal(rejectionForRealpathError(null, 'not-found'), 'io-error')
  assert.equal(rejectionForRealpathError('ENOENT', 'io-error'), 'io-error')
})

test('isSameLocation 以真实路径判断同一位置', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-same-location-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'sub'))

  assert.equal(isSameLocation(root, root), true)
  assert.equal(isSameLocation(root, join(root, 'sub')), false)
  assert.equal(isSameLocation(root, join(root, 'missing')), false)
})
