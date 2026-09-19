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
 */
export function registerTerminalIpc(ctx: IpcContext): void {
  ctx.handle(IpcChannel.terminalCreate, (event, request: TerminalCreateRequest): TerminalCreateResult => {
    const root = ctx.projectRoot(request.projectId)
    const cwd = resolveDirectory(root, request.relativePath) ?? root
    return ctx.terminals.create(event.sender, request, cwd)
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
