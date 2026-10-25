import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { resolveShellSpec, SHELL_CHOICES } from '../../src/main/modules/shell-select'

const env = {
  ProgramFiles: 'C:\\Program Files',
  SystemRoot: 'C:\\Windows',
  COMSPEC: 'C:\\Windows\\System32\\cmd.exe'
}

const pwsh = join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
const powershell = join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const cmd = 'C:\\Windows\\System32\\cmd.exe'

test('白名单固定为 pwsh / powershell / cmd', () => {
  assert.deepEqual(SHELL_CHOICES, ['pwsh', 'powershell', 'cmd'])
})

test('指定白名单 Shell 且本机存在时优先生效', () => {
  const spec = resolveShellSpec('pwsh', {
    platform: 'win32',
    env,
    exists: (path) => path === pwsh
  })
  assert.equal(spec.path, pwsh)
  assert.deepEqual(spec.args, [])
})

test('指定的 Shell 缺失时回退到自动探测', () => {
  const spec = resolveShellSpec('cmd', {
    platform: 'win32',
    env,
    exists: (path) => path === powershell
  })
  assert.equal(spec.path, powershell)
})

test('都不可用时回退 COMSPEC', () => {
  const spec = resolveShellSpec(undefined, {
    platform: 'win32',
    env,
    exists: () => false
  })
  assert.equal(spec.path, cmd)
})

test('非 Windows 平台使用 $SHELL', () => {
  const spec = resolveShellSpec('cmd', {
    platform: 'linux',
    env: { ...env, SHELL: '/bin/zsh' },
    exists: () => true
  })
  assert.equal(spec.path, '/bin/zsh')
  assert.deepEqual(spec.args, [])
})
