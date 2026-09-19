import { registerAppIpc } from './app'
import type { IpcContext } from './context'
import { registerFileIpc } from './files'
import { registerGitIpc } from './git'
import { registerProjectIpc } from './projects'
import { registerSystemIpc } from './system'
import { registerTerminalIpc } from './terminal'

/**
 * 注册全部 IPC 通道。
 *
 * 通道按域拆分在 `src/main/ipc/` 下的各文件中（计划 §3.4）：
 * 新增通道时只改对应域文件，不必回到主进程入口。
 */
export function registerIpcHandlers(ctx: IpcContext): void {
  registerAppIpc(ctx)
  registerProjectIpc(ctx)
  registerFileIpc(ctx)
  registerGitIpc(ctx)
  registerSystemIpc(ctx)
  registerTerminalIpc(ctx)
}

export type { IpcContext } from './context'
export type { HandleFn, Handler, TrustOptions } from './guard'
export { createHandle, isTrustedSender } from './guard'
