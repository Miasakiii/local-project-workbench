import type { IpcMainInvokeEvent } from 'electron'
import { BrowserWindow, dialog } from 'electron'

/**
 * 弹出目录选择框，返回绝对路径；用户取消时返回 null。
 *
 * 「选择目录」与「登记项目」两个通道都要用，因此抽到一处，
 * 避免两处对话框参数漂移（标题、按钮文案、是否以主窗口为宿主）。
 */
export async function pickDirectory(event: IpcMainInvokeEvent): Promise<string | null> {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showOpenDialog(owner, {
        title: '选择项目目录',
        properties: ['openDirectory'],
        buttonLabel: '登记该项目'
      })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })

  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}
