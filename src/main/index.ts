import { join } from 'node:path'
import type { ProjectSummary, QuitRequestedEvent } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import type { Project } from '@shared/types'
import { app, BrowserWindow, shell } from 'electron'
import { createHandle, type IpcContext, registerIpcHandlers } from './ipc'
import { ProjectWatcher } from './modules/file-watcher'
import { detectReadme, extractSummary } from './modules/markdown-preview'
import { createRegistry, createRegistryStore, type ProjectRegistry, toSummary } from './modules/project-registry'
import { PtySessionManager } from './modules/pty-session'
import { createQuitCoordinator } from './modules/quit-coordinator'

/**
 * 主进程入口。
 *
 * 安全基线（设计稿 8.2.3）：
 * - 渲染进程禁用 Node 集成、启用上下文隔离与沙箱。
 * - 预加载层只暴露白名单方法；主进程校验调用来源。
 * - 渲染进程只传「项目 ID + 相对路径」，主进程解析真实路径后复核。
 * - 限制页面导航与窗口创建；外链交给系统浏览器且仅允许 http/https。
 * - 终端输入是独立特权通道，文档预览不接触。
 *
 * 元数据一律写入应用数据目录，不向用户项目写入任何配置文件。
 *
 * 本文件只负责应用生命周期、窗口与进程级服务；IPC 通道按域拆分在
 * `src/main/ipc/` 下（计划 §3.4），新增通道不必回到本文件。
 */

const terminals = new PtySessionManager()
/** 同一时刻最多监听一个项目（设计稿 5.3） */
const watcher = new ProjectWatcher()

const isDev = !app.isPackaged
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']

let registry: ProjectRegistry | null = null

/** 简介缓存：键为项目 ID，值为上次提取所用签名与结果 */
const descriptionCache = new Map<string, { signature: string; text: string | null; source: 'readme' | 'path' }>()

function getRegistry(): ProjectRegistry {
  if (registry === null) {
    registry = createRegistry(createRegistryStore(join(app.getPath('userData'), 'projects.json')))
  }
  return registry
}

/* ---------------- 项目库服务 ---------------- */

function resolveProjectRoot(projectId: string): string {
  const resolved = getRegistry().resolveRoot(projectId)
  if (!resolved.ok) throw new Error(resolved.reason)
  return resolved.root
}

function resolveDescription(project: Project): { text: string | null; source: 'user' | 'readme' | 'path' } {
  if (project.descriptionOverride !== null && project.descriptionOverride.trim().length > 0) {
    return { text: project.descriptionOverride.trim(), source: 'user' }
  }

  const detection = detectReadme(project.normalizedIdentity, project.readmePath)
  const signature = `${detection.selected ?? ''}`
  const cached = descriptionCache.get(project.id)
  if (cached !== undefined && cached.signature === signature) {
    return { text: cached.text, source: cached.source }
  }

  let text: string | null = null
  if (detection.selected !== null) {
    text = extractSummary(project.normalizedIdentity, detection.selected)
  }
  const source: 'readme' | 'path' = text === null ? 'path' : 'readme'
  if (text === null) text = project.normalizedIdentity

  descriptionCache.set(project.id, { signature, text, source })
  return { text, source }
}

function listProjects(): ProjectSummary[] {
  const summaries = getRegistry()
    .list()
    .map((project) => toSummary(project, (item) => resolveDescription(item)))

  // 置顶优先，其次按最近打开时间倒序
  summaries.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return right.lastOpenedAt.localeCompare(left.lastOpenedAt)
  })
  return summaries
}

/* ---------------- 退出协调（设计稿 6.1） ---------------- */

function liveWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((item) => !item.isDestroyed()) ?? null
}

/** 清理进程级服务；可重复调用。 */
function disposeServices(): void {
  terminals.disposeAll()
  watcher.dispose()
}

/**
 * 退出前若仍有活动终端会话，先询问用户，不静默中断正在运行的命令。
 * 判定与状态机在 `quit-coordinator.ts`，本文件只提供 Electron 侧的能力。
 */
const quitCoordinator = createQuitCoordinator({
  activeSessionCount: () => terminals.activeCount,
  canPrompt: () => {
    const window = liveWindow()
    return window !== null && !window.webContents.isDestroyed()
  },
  prompt: (sessionCount) => {
    const window = liveWindow()
    if (window === null) return
    const payload: QuitRequestedEvent = { sessionCount }
    window.webContents.send(IpcChannel.appQuitRequested, payload)
  },
  disposeServices,
  quit: () => app.quit()
})

/* ---------------- 窗口 ---------------- */

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

  // 关闭窗口同样属于「退出」，因此与 before-quit 共用同一套询问逻辑。
  window.on('close', (event) => {
    if (quitCoordinator.requestQuit()) event.preventDefault()
  })

  // 渲染进程崩溃后无人能回应询问：视为无法确认，直接结束，避免应用卡在无法关闭的状态。
  window.webContents.on('render-process-gone', () => {
    quitCoordinator.abandonPrompt()
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
    if (isDev && rendererDevUrl !== undefined && url.startsWith(rendererDevUrl)) return
    event.preventDefault()
  })

  if (isDev && rendererDevUrl !== undefined) {
    void window.loadURL(rendererDevUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/* ---------------- IPC 依赖装配 ---------------- */

/**
 * 把进程级服务装配成 IPC 上下文。
 * 这里是「哪些能力可以被通道使用」的唯一出口。
 */
function createIpcContext(): IpcContext {
  return {
    handle: createHandle({ isDev, rendererDevUrl }),
    registry: getRegistry,
    projectRoot: resolveProjectRoot,
    describe: resolveDescription,
    listProjects,
    invalidateDescription: (projectId) => {
      descriptionCache.delete(projectId)
    },
    terminals,
    watcher,
    resolveQuit: (confirmed) => quitCoordinator.resolve(confirmed)
  }
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(() => {
  app.setAppUserModelId('com.miasakii.local-project-workbench')
  registerIpcHandlers(createIpcContext())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 设计稿 6.1：退出前处理活动会话，不静默遗留
app.on('before-quit', (event) => {
  if (quitCoordinator.requestQuit()) {
    event.preventDefault()
    return
  }
  if (terminals.activeCount > 0) {
    console.info(`[终端] 退出前清理 ${terminals.activeCount} 个活动会话`)
  }
  quitCoordinator.finalize()
})
