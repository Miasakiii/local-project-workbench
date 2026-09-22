import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeRequest,
  TerminalWriteRequest
} from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import type { WebContents } from 'electron'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'
import { resolveShellSpec } from './shell-select'

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
  projectId: string
  child: IPty
  shell: string
  cwd: string
  /** 累计接收字节数，仅用于诊断，不保存输出内容 */
  bytesReceived: number
}

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

export class PtySessionManager {
  private readonly sessions = new Map<string, Session>()

  /**
   * 创建会话。
   *
   * 启动目录由主进程解析后传入（渲染进程只提供「项目 ID + 相对路径」），
   * 此处再做一次存在性与类型复核，作为纵深防御。
   */
  create(sender: WebContents, request: TerminalCreateRequest, resolvedCwd: string): TerminalCreateResult {
    const cwd = resolvedCwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('启动目录不能为空')
    }
    if (!existsSync(cwd)) {
      throw new Error(`启动目录不存在：${cwd}`)
    }
    if (!statSync(cwd).isDirectory()) {
      throw new Error(`启动目录不是文件夹：${cwd}`)
    }

    const shell = resolveShellSpec(request.shell)
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
    const session: Session = {
      id,
      projectId: request.projectId,
      child,
      shell: shell.path,
      cwd,
      bytesReceived: 0
    }
    this.sessions.set(id, session)

    // 输出直接转发给渲染进程，主进程不保留输出内容。
    // 回滚缓冲由渲染进程的终端组件负责（设计稿 6.2：限制内存中的回滚行数）。
    // 主进程持有输出副本会在大输出场景下造成无界增长。
    child.onData((data: string) => {
      session.bytesReceived += data.length
      if (sender.isDestroyed()) return
      const payload: TerminalDataEvent = { sessionId: id, data }
      sender.send(IpcChannel.terminalData, payload)
    })

    child.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
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

  /** 仅用于诊断：指定会话累计接收的字节数 */
  bytesReceived(sessionId: string): number {
    return this.sessions.get(sessionId)?.bytesReceived ?? 0
  }
}
