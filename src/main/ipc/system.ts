import { spawn } from 'node:child_process'
import type { OpenExternalRequest, OpenPathRequest, WatcherSetActiveRequest } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { shell } from 'electron'
import { resolveEntryPath } from '../modules/file-browser'
import type { IpcContext } from './context'
import { pickEditorExecutable } from './dialogs'

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

  /* ---- 用指定编辑器打开（G3b）---- */

  // 选择并持久化编辑器。编辑器路径只存 settings.json，不进渲染层传参链路。
  ctx.handle(IpcChannel.systemSetEditor, async (event): Promise<string | null> => {
    const chosen = await pickEditorExecutable(event)
    if (chosen === null) return null
    return ctx.settings().setEditorPath(chosen).editorPath
  })

  // 用已设置的编辑器打开项目内文件。返回 null 表示已启动，否则返回用户可读原因。
  ctx.handle(IpcChannel.systemOpenWith, async (_event, request: OpenPathRequest): Promise<string | null> => {
    const root = ctx.projectRoot(request.projectId)
    const target = resolveEntryPath(root, request.relativePath)
    if (target === null) return '目标不可用或位于项目之外'
    const editor = ctx.settings().get().editorPath
    if (editor === null || editor.length === 0) {
      return '尚未设置编辑器。请先用工具栏「设置编辑器…」选择。'
    }
    // 编辑器独立于本进程启动；只等「是否成功拉起」，不等它退出。
    const child = spawn(editor, [target], { detached: true, stdio: 'ignore', windowsHide: true })
    const outcome = await new Promise<string | null>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) => {
        resolve(
          error.code === 'ENOENT'
            ? '找不到所选编辑器，请在「设置编辑器…」中重新选择'
            : error.message || '编辑器启动失败'
        )
      })
      child.once('spawn', () => resolve(null))
    })
    child.unref()
    return outcome
  })
}
