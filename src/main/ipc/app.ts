import type {
  AppInfoResult,
  QuitConfirmRequest,
  SettingsResult,
  StartupViewResult,
  UpdateSettingsRequest
} from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { app } from 'electron'
import { createStartupLookup, decideStartupView } from '../modules/app-settings'
import type { IpcContext } from './context'
import { pickDirectory } from './dialogs'

/** 应用信息、通用目录选择、退出确认与应用级偏好。 */
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

  /**
   * 启动位置：主进程判定，渲染进程只接受结论。
   * 可用性由登记表与磁盘现状决定，判定规则见 `app-settings.ts` 的 `decideStartupView`。
   */
  ctx.handle(IpcChannel.appStartupView, (): StartupViewResult => {
    const settings = ctx.settings().get()
    const view = decideStartupView(settings, createStartupLookup(ctx.registry()))
    return { restoreLastProject: settings.restoreLastProject, projectId: view.projectId, notice: view.notice }
  })

  ctx.handle(IpcChannel.settingsUpdate, (_event, request: UpdateSettingsRequest): SettingsResult => {
    const enabled = request !== null && typeof request === 'object' && request.restoreLastProject === true
    return ctx.settings().setRestoreLastProject(enabled)
  })
}
