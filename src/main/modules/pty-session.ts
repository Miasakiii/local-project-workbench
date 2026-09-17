import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { IpcChannel } from '@shared/ipc'
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeRequest,
  TerminalWriteRequest
} from '@shared/ipc'

/**
 * PTY 会话管理（M0-1 原型）。
 *
 * 边界（设计稿第 6 章）：
 * - 会话由用户明确创建，打开目录不自动执行任何命令。
 * - 会话属于创建它的项目；切换项目不终止进程。
 * - 终端具备当前用户权限，项目归属不等于文件系统沙箱。
 * - 会话只在本次应用运行期间有效，不持久化输出。
 */

interface Session {
  id: string
  child: IPty
  shell: string
  cwd: string
}

interface ShellSpec {
  path: string
  args: string[]
}

/** 内存中保留的回滚行数上限，避免高频输出导致无界增长 */
const MAX_BUFFERED_CHUNKS = 5_000
const MIN_DIMENSION = 2
const MAX_DIMENSION = 1_000

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < MIN_DIMENSION) return fallback
  if (rounded > MAX_DIMENSION) return MAX_DIMENSION
  return rounded
}

/** node-pty 要求环境变量值全部为字符串 */
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/**
 * 选择本机已存在的 Shell。
 * 设计稿 6.1：优先 PowerShell 或 cmd；Git Bash 等作为后续适配，不假定存在。
 */
function resolveShell(): ShellSpec {
  if (process.platform !== 'win32') {
    return { path: process.env['SHELL'] ?? '/bin/bash', args: [] }
  }

  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
  const pwsh7 = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  const windowsPowerShell = join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )

  if (existsSync(pwsh7)) return { path: pwsh7, args: [] }
  if (existsSync(windowsPowerShell)) return { path: windowsPowerShell, args: [] }

  const comspec = process.env['COMSPEC'] ?? join(systemRoot, 'System32', 'cmd.exe')
  return { path: comspec, args: [] }
}

export class PtySessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly pendingChunks = new Map<string, string[]>()

  /**
   * 创建会话。
   * 不信任渲染进程传入的启动目录：必须是真实存在且可访问的目录。
   */
  create(sender: WebContents, request: TerminalCreateRequest): TerminalCreateResult {
    const cwd = request.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('启动目录不能为空')
    }
    if (!existsSync(cwd)) {
      throw new Error(`启动目录不存在：${cwd}`)
    }
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`启动目录不是文件夹：${cwd}`)
    }

    const shell = resolveShell()
    const cols = clampDimension(request.cols, 80)
    const rows = clampDimension(request.rows, 24)

    const child = pty.spawn(shell.path, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: buildEnv(),
      ...(process.platform === 'win32' ? { useConpty: true } : {})
    })

    const id = randomUUID()
    this.sessions.set(id, { id, child, shell: shell.path, cwd })
    this.pendingChunks.set(id, [])

    child.onData((data: string) => {
      this.pushChunk(id, data)
      if (sender.isDestroyed()) return
      const payload: TerminalDataEvent = { sessionId: id, data }
      sender.send(IpcChannel.terminalData, payload)
    })

    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
      this.pendingChunks.delete(id)
      if (sender.isDestroyed()) return
      const payload: TerminalExitEvent = { sessionId: id, exitCode, signal: signal ?? null }
      sender.send(IpcChannel.terminalExit, payload)
    })

    return { sessionId: id, shell: shell.path, cwd }
  }

  write(request: TerminalWriteRequest): void {
    const session = this.sessions.get(request.sessionId)
    if (!session) return
    session.child.write(request.data)
  }

  resize(request: TerminalResizeRequest): void {
    const session = this.sessions.get(request.sessionId)
    if (!session) return
    session.child.resize(clampDimension(request.cols, 80), clampDimension(request.rows, 24))
  }

  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.pendingChunks.delete(sessionId)
    try {
      session.child.kill()
    } catch {
      // 会话可能已自行退出，忽略
    }
  }

  /** 退出前统一处理。不承诺清理自行脱离的后台进程（设计稿 6.2）。 */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id)
  }

  /** 仅用于诊断：当前活动会话数量 */
  get activeCount(): number {
    return this.sessions.size
  }

  /** 限制回滚缓冲，防止高频输出导致无界增长 */
  private pushChunk(sessionId: string, data: string): void {
    const chunks = this.pendingChunks.get(sessionId)
    if (!chunks) return
    chunks.push(data)
    if (chunks.length > MAX_BUFFERED_CHUNKS) {
      chunks.splice(0, chunks.length - MAX_BUFFERED_CHUNKS)
    }
  }
}
