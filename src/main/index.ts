import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  AppInfoResult,
  AssetRequestPayload,
  AssetReadResult,
  DeleteEntriesResult,
  FileDeleteRequest,
  FileDiffRequest,
  FileListRequest,
  FileListResult,
  FilePreview,
  FilePreviewRequest,
  GitSnapshot,
  GitSnapshotRequest,
  OpenExternalRequest,
  OpenPathRequest,
  ProjectRef,
  ProjectRemoveResult,
  ProjectRevealResult,
  ProjectSummary,
  ProjectUpdateRequest,
  RegisterProjectResult,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalResizeRequest,
  TerminalWriteRequest,
  ViewStateRequest,
  ViewStateSaveRequest,
  WatcherSetActiveRequest
} from '@shared/ipc'
import type { FileDiff, ProjectViewState, ReadmeDetection } from '@shared/types'
import { PtySessionManager } from './modules/pty-session'
import { createRegistry, createRegistryStore, toSummary, type ProjectRegistry } from './modules/project-registry'
import { detectRepository, queryGitStatus } from './modules/git-query'
import { fileDiff } from './modules/diff-service'
import { ProjectWatcher } from './modules/file-watcher'
import { detectReadme, extractSummary, readAsset } from './modules/markdown-preview'
import { listDirectory, previewFile, resolveDirectory, resolveEntryPath } from './modules/file-browser'
import { deleteEntries } from './modules/file-access'

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

/* ---------------- 调用来源校验 ---------------- */

/**
 * 只接受来自应用自身页面的调用。
 * 开发服务器地址与打包后的 file:// 页面之外的来源一律拒绝。
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.sender.getURL()
  if (isDev && rendererDevUrl !== undefined && url.startsWith(rendererDevUrl)) return true
  return url.startsWith('file://')
}

type Handler<Args extends unknown[], Result> = (event: IpcMainInvokeEvent, ...args: Args) => Result

function handle<Args extends unknown[], Result>(channel: string, handler: Handler<Args, Result>): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error(`拒绝来自非应用页面的调用：${channel}`)
    }
    return handler(event, ...(args as Args))
  })
}

/* ---------------- 项目库 ---------------- */

function resolveProjectRoot(projectId: string): string {
  const resolved = getRegistry().resolveRoot(projectId)
  if (!resolved.ok) throw new Error(resolved.reason)
  return resolved.root
}

function resolveDescription(project: {
  id: string
  normalizedIdentity: string
  descriptionOverride: string | null
  readmePath: string | null
}): { text: string | null; source: 'user' | 'readme' | 'path' } {
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

/* ---------------- IPC 注册 ---------------- */

function registerIpcHandlers(): void {
  handle(IpcChannel.appGetInfo, (): AppInfoResult => ({
    name: app.getName(),
    version: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome,
    platform: process.platform
  }))

  handle(IpcChannel.dialogSelectDirectory, async (event): Promise<string | null> => {
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
  })

  /* ---- 项目登记 ---- */

  handle(IpcChannel.projectList, (): ProjectSummary[] => listProjects())

  handle(IpcChannel.projectRegister, async (event): Promise<RegisterProjectResult> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const picked = owner
      ? await dialog.showOpenDialog(owner, {
          title: '选择项目目录',
          properties: ['openDirectory'],
          buttonLabel: '登记该项目'
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })

    if (picked.canceled || picked.filePaths.length === 0) {
      return { status: 'cancelled', project: null, message: null }
    }

    const directory = picked.filePaths[0] as string
    const outcome = getRegistry().register(directory)

    if (outcome.project === null) {
      return { status: 'unavailable', project: null, message: outcome.message }
    }

    // Git 是可选探测属性（C08）：失败或不可用不影响登记结果
    if (outcome.status === 'added') {
      const detected = await detectRepository(outcome.project.normalizedIdentity)
      getRegistry().update(outcome.project.id, { isGitRepository: detected })
    }

    const refreshed = getRegistry().get(outcome.project.id)
    const summary =
      refreshed === null ? null : toSummary(refreshed, (item) => resolveDescription(item))

    return { status: outcome.status, project: summary, message: outcome.message }
  })

  handle(IpcChannel.projectRemove, (_event, request: ProjectRef): ProjectRemoveResult => {
    const removed = getRegistry().remove(request.projectId)
    descriptionCache.delete(request.projectId)
    return {
      removed,
      message: removed ? '已移除登记。磁盘上的文件未受影响。' : '该项目不在登记列表中。',
      diskUntouched: true
    }
  })

  handle(IpcChannel.projectUpdate, (_event, request: ProjectUpdateRequest): ProjectSummary | null => {
    const patch: Parameters<ProjectRegistry['update']>[1] = {}
    if (request.pinned !== undefined) patch.pinned = request.pinned
    if (request.trusted !== undefined) patch.trusted = request.trusted
    if (request.displayName !== undefined) patch.displayName = request.displayName
    if (request.readmePath !== undefined) patch.readmePath = request.readmePath
    if (request.descriptionOverride !== undefined) patch.descriptionOverride = request.descriptionOverride

    const updated = getRegistry().update(request.projectId, patch)
    if (updated === null) return null
    descriptionCache.delete(request.projectId)
    return toSummary(updated, (item) => resolveDescription(item))
  })

  handle(IpcChannel.projectOpen, (_event, request: ProjectRef): ProjectSummary | null => {
    const touched = getRegistry().touch(request.projectId)
    if (touched === null) return null
    return toSummary(touched, (item) => resolveDescription(item))
  })

  handle(IpcChannel.projectReveal, async (_event, request: ProjectRef): Promise<ProjectRevealResult> => {
    const resolved = getRegistry().resolveRoot(request.projectId)
    if (!resolved.ok) return { opened: false, message: resolved.reason }
    const error = await shell.openPath(resolved.root)
    return { opened: error.length === 0, message: error.length === 0 ? null : error }
  })

  handle(IpcChannel.projectReadme, (_event, request: ProjectRef): ReadmeDetection => {
    const resolved = getRegistry().resolveRoot(request.projectId)
    if (!resolved.ok) return { selected: null, variants: [], location: null }
    return detectReadme(resolved.root, resolved.project.readmePath)
  })

  /* ---- 视图状态 ---- */

  handle(IpcChannel.viewStateGet, (_event, request: ViewStateRequest): ProjectViewState | null =>
    getRegistry().getViewState(request.projectId)
  )

  handle(IpcChannel.viewStateSave, (_event, request: ViewStateSaveRequest): void => {
    getRegistry().saveViewState({
      projectId: request.projectId,
      page: request.page,
      relativePath: request.relativePath,
      scrollTop: Number.isFinite(request.scrollTop) ? request.scrollTop : 0,
      terminalPanelHeight: Number.isFinite(request.terminalPanelHeight) ? request.terminalPanelHeight : 280,
      filesPaneWidth: Number.isFinite(request.filesPaneWidth) ? request.filesPaneWidth : 380
    })
  })

  /* ---- 文件浏览与预览 ---- */

  handle(IpcChannel.fileList, (_event, request: FileListRequest): FileListResult =>
    listDirectory({
      projectRoot: resolveProjectRoot(request.projectId),
      relativePath: request.relativePath
    })
  )

  handle(IpcChannel.filePreview, (_event, request: FilePreviewRequest): FilePreview =>
    previewFile({
      projectRoot: resolveProjectRoot(request.projectId),
      relativePath: request.relativePath
    })
  )

  handle(
    IpcChannel.markdownReadAsset,
    (_event, request: AssetRequestPayload): AssetReadResult =>
      readAsset({
        projectRoot: resolveProjectRoot(request.projectId),
        relativePath: request.relativePath,
        allowOversized: request.allowOversized === true
      })
  )

  handle(IpcChannel.fileDelete, async (_event, request: FileDeleteRequest): Promise<DeleteEntriesResult> => {
    const resolved = getRegistry().resolveRoot(request.projectId)
    if (!resolved.ok) throw new Error(resolved.reason)
    return deleteEntries({
      projectRoot: resolved.root,
      relativePaths: request.relativePaths,
      trusted: resolved.project.trusted,
      trash: (absolutePath) => shell.trashItem(absolutePath)
    })
  })

  /* ---- 只读 Git ---- */

  handle(IpcChannel.gitSnapshot, async (_event, request: GitSnapshotRequest): Promise<GitSnapshot> => {
    const resolved = getRegistry().resolveRoot(request.projectId)
    if (!resolved.ok) {
      return {
        projectId: request.projectId,
        sequence: request.sequence,
        branch: null,
        entries: [],
        updatedAt: new Date().toISOString(),
        stale: true,
        error: resolved.reason
      }
    }
    return queryGitStatus(request.projectId, resolved.root, request.sequence)
  })

  handle(IpcChannel.gitFileDiff, async (_event, request: FileDiffRequest): Promise<FileDiff> => {
    const resolved = getRegistry().resolveRoot(request.projectId)
    if (!resolved.ok) {
      return {
        projectId: request.projectId,
        relativePath: request.relativePath,
        scope: request.scope,
        status: 'unchanged',
        binary: false,
        originalPath: null,
        hunks: [],
        addedLines: 0,
        removedLines: 0,
        truncated: false,
        noBaseline: request.scope === 'untracked',
        updatedAt: new Date().toISOString(),
        stale: true,
        error: resolved.reason
      }
    }
    return fileDiff({
      projectId: request.projectId,
      projectRoot: resolved.root,
      relativePath: request.relativePath,
      scope: request.scope,
      originalPath: request.originalPath ?? null
    })
  })

  /* ---- 受控文件监听（仅活动项目） ---- */

  handle(IpcChannel.watcherSetActive, (event, request: WatcherSetActiveRequest): boolean => {
    if (request.projectId === null) {
      watcher.setActive(null, null, event.sender)
      return true
    }
    const resolved = getRegistry().resolveRoot(request.projectId)
    if (!resolved.ok) {
      watcher.setActive(null, null, event.sender)
      return false
    }
    watcher.setActive(request.projectId, resolved.root, event.sender)
    return true
  })

  /* ---- 系统集成 ---- */

  handle(IpcChannel.systemOpenExternal, async (_event, request: OpenExternalRequest): Promise<boolean> => {
    // 外链仅允许明确支持的协议（设计稿 4.3）
    if (!/^https?:\/\//i.test(request.url)) return false
    await shell.openExternal(request.url)
    return true
  })

  handle(IpcChannel.systemOpenPath, async (_event, request: OpenPathRequest): Promise<string | null> => {
    const root = resolveProjectRoot(request.projectId)
    const target = resolveEntryPath(root, request.relativePath)
    if (target === null) return '目标不可用或位于项目之外'
    const error = await shell.openPath(target)
    return error.length === 0 ? null : error
  })

  handle(IpcChannel.systemShowInFolder, (_event, request: OpenPathRequest): boolean => {
    const root = resolveProjectRoot(request.projectId)
    const target = resolveEntryPath(root, request.relativePath)
    if (target === null) return false
    shell.showItemInFolder(target)
    return true
  })

  /* ---- 终端 ---- */

  handle(
    IpcChannel.terminalCreate,
    (event, request: TerminalCreateRequest): TerminalCreateResult => {
      const root = resolveProjectRoot(request.projectId)
      const cwd = resolveDirectory(root, request.relativePath) ?? root
      return terminals.create(event.sender, request, cwd)
    }
  )

  handle(IpcChannel.terminalWrite, (_event, request: TerminalWriteRequest): void => {
    terminals.write(request)
  })

  handle(IpcChannel.terminalResize, (_event, request: TerminalResizeRequest): void => {
    terminals.resize(request)
  })

  handle(IpcChannel.terminalDispose, (_event, sessionId: string): void => {
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
  watcher.dispose()
})
