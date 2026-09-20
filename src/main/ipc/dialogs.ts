import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, dialog } from 'electron'

export interface PickDirectoryOptions {
  title: string
  buttonLabel: string
}

const REGISTER_DIALOG: PickDirectoryOptions = { title: '选择项目目录', buttonLabel: '登记该项目' }
const RELOCATE_DIALOG: PickDirectoryOptions = { title: '选择项目的新位置', buttonLabel: '重新定位到此目录' }

/**
 * 弹出目录选择框，返回绝对路径；用户取消时返回 null。
 *
 * 「登记项目」与「重新定位」两个通道都要用，因此抽到一处，
 * 避免两处对话框参数漂移（标题、按钮文案、是否以主窗口为宿主）。
 * 文案必须区分：把「重新定位」显示成「登记该项目」会让用户误以为在新增记录。
 */
export async function pickDirectory(
  event: IpcMainInvokeEvent,
  options: PickDirectoryOptions = REGISTER_DIALOG
): Promise<string | null> {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showOpenDialog(owner, {
        title: options.title,
        properties: ['openDirectory'],
        buttonLabel: options.buttonLabel
      })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** 重新定位专用入口，固定使用「选择新位置」文案。 */
export function pickRelocateDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  return pickDirectory(event, RELOCATE_DIALOG)
}
