import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  captureFileIdentity,
  fileFingerprintUnchanged,
  fileIdentityUnchanged,
  resolveDirectoryForWrite,
  resolveForWrite,
  sameFileIdentity,
  type WriteGuardWording,
  writtenTargetIntact
} from '../../src/main/modules/write-guard'

const isWindows = process.platform === 'win32'

const wording: WriteGuardWording = {
  viaReparsePoint: '路径经过链接',
  protectedEntry: (normalized) => `受保护项：${normalized}`,
  unresolvable: (input, rejection, detail) => ({
    reason: rejection === 'traversal' || rejection === 'outside-project' ? 'outside-project' : 'invalid-path',
    message: `${input}：${detail}`
  })
}

function createProject(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'workbench-write-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'sub'))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'config'), '[core]')
  writeFileSync(join(root, '..foo'), 'legit')
  writeFileSync(join(root, '.gitignore'), 'node_modules')
  return root
}

test('项目根与 .git 元数据不提供写操作', (t) => {
  const root = createProject(t)

  const rootTarget = resolveForWrite(root, '', { mustExist: true, wording })
  assert.equal(rootTarget.ok, false)
  if (!rootTarget.ok) {
    assert.equal(rootTarget.status, 'skipped')
    assert.equal(rootTarget.reason, 'protected-entry')
  }

  const gitConfig = resolveForWrite(root, '.git/config', { mustExist: true, wording })
  assert.equal(gitConfig.ok, false)
  if (!gitConfig.ok) assert.equal(gitConfig.reason, 'protected-entry')
})

test('折叠 .. 后再查受保护项，sub/../.git 同等拒绝', (t) => {
  const root = createProject(t)
  const result = resolveForWrite(root, 'sub/../.git/config', { mustExist: true, wording })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.status, 'skipped')
    assert.equal(result.reason, 'protected-entry')
  }
})

test('合法名字 ..foo 与 .gitignore 不被误判', (t) => {
  const root = createProject(t)

  const dotDotName = resolveForWrite(root, '..foo', { mustExist: true, wording })
  assert.equal(dotDotName.ok, true)

  const gitignore = resolveForWrite(root, '.gitignore', { mustExist: true, wording })
  assert.equal(gitignore.ok, true)
})

test('项目根作为目录目标时允许，作为条目目标时拒绝', (t) => {
  const root = createProject(t)
  const directory = resolveDirectoryForWrite(root, '', wording)
  assert.equal(directory.ok, true)

  const entry = resolveForWrite(root, '.', { mustExist: true, wording })
  assert.equal(entry.ok, false)
})

test('项目外路径与经目录联接的写目标被拒绝', (t) => {
  const root = createProject(t)
  const outside = join(root, '..', 'outside-write-guard')
  mkdirSync(outside, { recursive: true })

  try {
    const traversal = resolveForWrite(root, '../outside-write-guard/file.txt', { mustExist: false, wording })
    assert.equal(traversal.ok, false)
    if (!traversal.ok) assert.equal(traversal.reason, 'outside-project')

    symlinkSync(outside, join(root, 'link'), isWindows ? 'junction' : 'dir')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const viaLink = resolveForWrite(root, 'link/secret.txt', { mustExist: true, wording })
    assert.equal(viaLink.ok, false)
    if (!viaLink.ok) assert.equal(viaLink.status, 'failed')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('文件身份快照能识别删除后重建', (t) => {
  const root = createProject(t)
  const file = join(root, 'identity.txt')
  writeFileSync(file, 'alpha')

  const snapshot = captureFileIdentity(file)
  assert.notEqual(snapshot, null)
  assert.equal(fileIdentityUnchanged(snapshot, file), true)
  assert.equal(sameFileIdentity(snapshot, captureFileIdentity(file)), true)
  assert.equal(fileFingerprintUnchanged(snapshot, file), true)

  rmSync(file)
  writeFileSync(file, 'a different content')
  assert.equal(fileIdentityUnchanged(snapshot, file), false)
  assert.equal(fileFingerprintUnchanged(snapshot, file), false)
})

test('不存在的目标与目录使用各自的身份语义', (t) => {
  const root = createProject(t)
  const missing = join(root, 'missing.txt')

  assert.equal(captureFileIdentity(missing), null)
  assert.equal(sameFileIdentity(null, null), true)

  const directorySnapshot = captureFileIdentity(root)
  assert.notEqual(directorySnapshot, null)
  writeFileSync(join(root, 'new-entry.txt'), 'x')
  assert.equal(fileFingerprintUnchanged(directorySnapshot, root), true)
})

test('执行后复核要求目标仍是同一个物理文件', (t) => {
  const root = createProject(t)
  const file = join(root, 'target.txt')
  writeFileSync(file, 'content')

  assert.equal(writtenTargetIntact(root, 'target.txt', 'file', file), true)

  rmSync(file)
  assert.equal(writtenTargetIntact(root, 'target.txt', 'file', file), false)
})
