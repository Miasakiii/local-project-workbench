import type { AppInfoResult, QuitConfirmRequest } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { app } from 'electron'
import type { IpcContext } from './context'
import { pickDirectory } from './dialogs'

/** 应用信息、通用目录选择与退出确认。 */
export function registerAppIpc(ctx: IpcContext): void {
  ctx.handle(
    IpcChannel.appGetInfo,
    (): AppInfoResult => ({
      name: app.getName(),
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      chromeVersion: process.versions.chrome,
      platform: process.platform
    })
  )

  ctx.handle(IpcChannel.dialogSelectDirectory, (event): Promise<string | null> => pickDirectory(event))

  // 退出确认：渲染进程只回传布尔结论，不接触退出流程本身。
  ctx.handle(IpcChannel.appConfirmQuit, (_event, request: QuitConfirmRequest): void => {
    ctx.resolveQuit(request.confirmed === true)
  })
}
