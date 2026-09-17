import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  AppInfoResult,
  TerminalCreateRequest,
  TerminalResizeRequest,
  TerminalWriteRequest
} from '@shared/ipc'
import { PtySessionManager } from './modules/pty-session'

/**
 * 主进程入口。
 *
 * 安全基线（设计稿 8.2.3）：渲染进程禁用 Node 集成、启用上下文隔离与沙箱；
 * 限制页面导航与窗口创建；外链交给系统浏览器。
 */

const terminals = new PtySessionManager()

const isDev = !app.isPackaged
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '本地项目工作台',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  // 限制窗口创建：一律拒绝，外链交给系统浏览器且仅允许 http/https
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // 限制页面导航：只允许停留在开发服务器或本地打包页面
  window.webContents.on('will-navigate', (event, url) => {
    if (isDev && rendererDevUrl && url.startsWith(rendererDevUrl)) return
    event.preventDefault()
  })

  if (isDev && rendererDevUrl) {
    void window.loadURL(rendererDevUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerIpcHandlers(): void {
  ipcMain.handle(
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

  ipcMain.handle(IpcChannel.dialogSelectDirectory, async (event): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showOpenDialog(owner, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(
    IpcChannel.terminalCreate,
    (event, request: TerminalCreateRequest) => terminals.create(event.sender, request)
  )

  ipcMain.handle(IpcChannel.terminalWrite, (_event, request: TerminalWriteRequest): void => {
    terminals.write(request)
  })

  ipcMain.handle(IpcChannel.terminalResize, (_event, request: TerminalResizeRequest): void => {
    terminals.resize(request)
  })

  ipcMain.handle(IpcChannel.terminalDispose, (_event, sessionId: string): void => {
    terminals.dispose(sessionId)
  })
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.miasakii.local-project-workbench')
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 设计稿 6.1：退出前处理活动会话，不静默遗留
app.on('before-quit', () => {
  if (terminals.activeCount > 0) {
    console.info(`[终端] 退出前清理 ${terminals.activeCount} 个活动会话`)
  }
  terminals.disposeAll()
})
