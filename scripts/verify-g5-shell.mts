/**
 * G5 验证：终端可指定 shell（pwsh／powershell／cmd）及其回退（设计稿 6.1）。
 *
 * 纯 Node：platform/env/exists 全部注入，不启动任何进程、不依赖显示会话。
 * 覆盖：白名单命中用指定、指定缺失回落自动探测、非白名单被忽略、缺省走探测、
 *       非 Windows 用 $SHELL、白名单集合本身。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-g5-shell.mts
 */

import { join } from 'node:path'
import { resolveShellSpec, SHELL_CHOICES } from '../src/main/modules/shell-select.ts'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

const env = { SystemRoot: 'SYS', ProgramFiles: 'PF', COMSPEC: 'CMD' }
const pwsh7 = join('PF', 'PowerShell', '7', 'pwsh.exe')
const winps = join('SYS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const comspec = 'CMD'
const only =
  (...present: string[]): ((path: string) => boolean) =>
  (path) =>
    present.includes(path)

{
  const shell = resolveShellSpec('pwsh', { platform: 'win32', env, exists: only(pwsh7) })
  check('指定 pwsh（存在）→ pwsh7', shell.path === pwsh7 && shell.args.length === 0, shell.path)
}
{
  const shell = resolveShellSpec('powershell', { platform: 'win32', env, exists: only(winps) })
  check('指定 powershell（存在）→ WindowsPowerShell', shell.path === winps, shell.path)
}
{
  const shell = resolveShellSpec('cmd', { platform: 'win32', env, exists: only(comspec) })
  check('指定 cmd → COMSPEC', shell.path === comspec, shell.path)
}
{
  // 指定 pwsh 但本机没有：回落自动探测（pwsh/winps 都无 → COMSPEC）
  const shell = resolveShellSpec('pwsh', { platform: 'win32', env, exists: only() })
  check('指定缺失→回落探测(COMSPEC)', shell.path === comspec, shell.path)
}
{
  // 指定 powershell 缺失、pwsh 存在：探测命中 pwsh
  const shell = resolveShellSpec('powershell', { platform: 'win32', env, exists: only(pwsh7) })
  check('指定缺失→探测命中 pwsh', shell.path === pwsh7, shell.path)
}
{
  const shell = resolveShellSpec('gitbash', { platform: 'win32', env, exists: only(winps) })
  check('非白名单值被忽略→探测命中 winps', shell.path === winps, shell.path)
}
{
  const shell = resolveShellSpec(undefined, { platform: 'win32', env, exists: only(pwsh7) })
  check('缺省→探测命中 pwsh', shell.path === pwsh7, shell.path)
}
{
  const shell = resolveShellSpec('cmd', { platform: 'linux', env: { SHELL: '/bin/zsh' }, exists: only(comspec) })
  check('非 win32 忽略指定→$SHELL', shell.path === '/bin/zsh', shell.path)
}
{
  const list = [...SHELL_CHOICES]
  check(
    '白名单 = pwsh/powershell/cmd',
    list.length === 3 && list[0] === 'pwsh' && list[1] === 'powershell' && list[2] === 'cmd',
    list.join(',')
  )
}

let passed = 0
for (const item of checks) {
  if (item.pass) {
    passed += 1
  } else {
    console.error(`  [失败] ${item.name} — ${item.detail}`)
  }
}
console.log(`合计：${passed}/${checks.length} 项通过`)
process.exitCode = passed === checks.length ? 0 : 1
