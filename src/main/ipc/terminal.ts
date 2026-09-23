import type {
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalResizeRequest,
  TerminalWriteRequest
} from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { resolveDirectory } from '../modules/file-browser'
import type { IpcContext } from './context'

/**
 * 终端通道。
 *
 * 终端输入是独立特权通道（设计稿 8.2.3）：这里只做会话寻址与工作目录落定，
 * 输入内容不做解释，直接交给 pty。
 *
 * 信任门在**主进程**复核：`resolved.project.trusted` 来自登记表，渲染层声明的任何
 * 字段都不参与判定。界面侧同样有门（头部主按钮、Ctrl+`、文件栏右键三处），
 * 这里是纵深防御，保证新增入口漏检时也不会开出特权会话。
 */
export function registerTerminalIpc(ctx: IpcContext): void {
  ctx.handle(IpcChannel.terminalCreate, (event, request: TerminalCreateRequest): TerminalCreateResult => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) throw new Error(resolved.reason)
    const cwd = resolveDirectory(resolved.root, request.relativePath) ?? resolved.root
    return ctx.terminals.create(event.sender, request, cwd, resolved.project.trusted === true)
  })

  ctx.handle(IpcChannel.terminalWrite, (_event, request: TerminalWriteRequest): void => {
    ctx.terminals.write(request)
  })

  ctx.handle(IpcChannel.terminalResize, (_event, request: TerminalResizeRequest): void => {
    ctx.terminals.resize(request)
  })

  ctx.handle(IpcChannel.terminalDispose, (_event, sessionId: string): void => {
    ctx.terminals.dispose(sessionId)
  })
}
