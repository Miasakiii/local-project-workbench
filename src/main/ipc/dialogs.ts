import type { IpcMainInvokeEvent, MessageBoxOptions } from 'electron'
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

/**
 * 选择编辑器可执行文件（用于 G3b「用指定编辑器打开」）。
 * 只返回用户选择的路径（取消返回 null）；是否使用、如何启动由调用方决定。
 */
export async function pickEditorExecutable(event: IpcMainInvokeEvent): Promise<string | null> {
  const filters =
    process.platform === 'win32'
      ? [{ name: '可执行文件', extensions: ['exe', 'bat', 'cmd'] }]
      : [{ name: '可执行文件', extensions: ['*'] }]
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner
    ? await dialog.showOpenDialog(owner, {
        title: '选择编辑器可执行文件',
        properties: ['openFile'],
        filters
      })
    : await dialog.showOpenDialog({ title: '选择编辑器可执行文件', properties: ['openFile'], filters })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

/** 登记子目录位于仓库内时的选择：用所选目录 / 改用仓库根 / 取消 */
export type RepoRootChoice = 'chosen' | 'root' | 'cancelled'

/**
 * 所选目录位于某 Git 仓库内（且不是仓库根本身）时，询问改用仓库根还是仍用所选目录。
 * 绝对路径只在本函数内出现，不回传渲染层；默认「用所选目录」，不擅自扩大范围。
 */
export async function confirmUseRepoRoot(
  event: IpcMainInvokeEvent,
  selected: string,
  repoRoot: string
): Promise<RepoRootChoice> {
  const options: MessageBoxOptions = {
    type: 'question',
    buttons: ['用所选目录', '改用仓库根目录', '取消'],
    defaultId: 0,
    cancelId: 2,
    title: '登记位置',
    message: '所选目录位于一个 Git 仓库内，是否改用仓库根目录登记？',
    detail: `用所选目录：${selected}\n改用仓库根：${repoRoot}\n默认仍用所选目录，不会擅自扩大范围。`
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
  const index = result.response
  if (index === 1) return 'root'
  if (index === 2) return 'cancelled'
  return 'chosen'
}
