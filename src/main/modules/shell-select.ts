import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 终端进程规范：可执行路径与启动参数 */
export interface ShellSpec {
  path: string
  args: string[]
}

/** 渲染层可指定的 shell 白名单（设计稿 6.1：pwsh／PowerShell／cmd，不假定 Git Bash） */
export type ShellChoice = 'pwsh' | 'powershell' | 'cmd'

export const SHELL_CHOICES: readonly ShellChoice[] = ['pwsh', 'powershell', 'cmd']

export interface ResolveShellOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

/**
 * 选择本机已存在的 Shell（设计稿 6.1）。
 *
 * requested 命中白名单且本机存在即用；否则沿用自动探测（pwsh 7 → Windows PowerShell → COMSPEC）。
 * 非 Windows 平台忽略 requested，用 $SHELL。platform/env/exists 可注入，便于纯 Node 测试。
 */
export function resolveShellSpec(requested: string | undefined, options: ResolveShellOptions = {}): ShellSpec {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync

  if (platform !== 'win32') {
    return { path: env['SHELL'] ?? '/bin/bash', args: [] }
  }

  const systemRoot = env['SystemRoot'] ?? 'C:\\Windows'
  const pwsh7 = join(env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const comspec = env['COMSPEC'] ?? join(systemRoot, 'System32', 'cmd.exe')

  if (requested === 'pwsh' || requested === 'powershell' || requested === 'cmd') {
    const choice = { pwsh: pwsh7, powershell: windowsPowerShell, cmd: comspec }[requested]
    if (exists(choice)) return { path: choice, args: [] }
  }

  if (exists(pwsh7)) return { path: pwsh7, args: [] }
  if (exists(windowsPowerShell)) return { path: windowsPowerShell, args: [] }
  return { path: comspec, args: [] }
}
