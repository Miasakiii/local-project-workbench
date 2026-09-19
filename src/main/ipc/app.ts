import type { AppInfoResult } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { app } from 'electron'
import type { IpcContext } from './context'
import { pickDirectory } from './dialogs'

/** 应用信息与通用目录选择。 */
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
}
