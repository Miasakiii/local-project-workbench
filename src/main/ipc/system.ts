import type { OpenExternalRequest, OpenPathRequest, WatcherSetActiveRequest } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { shell } from 'electron'
import { resolveEntryPath } from '../modules/file-browser'
import type { IpcContext } from './context'

/** 系统集成（外链、打开、定位）与受控文件监听。 */
export function registerSystemIpc(ctx: IpcContext): void {
  /* ---- 受控文件监听（仅活动项目） ---- */

  ctx.handle(IpcChannel.watcherSetActive, (event, request: WatcherSetActiveRequest): boolean => {
    if (request.projectId === null) {
      ctx.watcher.setActive(null, null, event.sender)
      return true
    }
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) {
      ctx.watcher.setActive(null, null, event.sender)
      return false
    }
    ctx.watcher.setActive(request.projectId, resolved.root, event.sender)
    return true
  })

  /* ---- 系统集成 ---- */

  ctx.handle(IpcChannel.systemOpenExternal, async (_event, request: OpenExternalRequest): Promise<boolean> => {
    // 外链仅允许明确支持的协议（设计稿 4.3）
    if (!/^https?:\/\//i.test(request.url)) return false
    await shell.openExternal(request.url)
    return true
  })

  ctx.handle(IpcChannel.systemOpenPath, async (_event, request: OpenPathRequest): Promise<string | null> => {
    const root = ctx.projectRoot(request.projectId)
    const target = resolveEntryPath(root, request.relativePath)
    if (target === null) return '目标不可用或位于项目之外'
    const error = await shell.openPath(target)
    return error.length === 0 ? null : error
  })

  ctx.handle(IpcChannel.systemShowInFolder, (_event, request: OpenPathRequest): boolean => {
    const root = ctx.projectRoot(request.projectId)
    const target = resolveEntryPath(root, request.relativePath)
    if (target === null) return false
    shell.showItemInFolder(target)
    return true
  })
}
