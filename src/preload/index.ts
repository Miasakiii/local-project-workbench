import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  AppInfoResult,
  AssetReadResult,
  AssetRequestPayload,
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
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeRequest,
  TerminalWriteRequest,
  ViewStateRequest,
  ViewStateSaveRequest,
  WatcherSetActiveRequest
} from '@shared/ipc'
import type { FileDiff, ProjectChangedEvent, ProjectViewState, ReadmeDetection } from '@shared/types'

/**
 * 预加载层：只暴露白名单方法，不暴露原始 ipcRenderer。
 * 对应设计稿 8.2.3「特权通信」约束。
 *
 * 约定：
 * - 所有文件目标一律以「项目 ID + 相对路径」表达，渲染进程不持有绝对路径。
 * - 订阅类方法只向回调传递数据载荷，不传递 IpcRendererEvent，
 *   避免渲染进程通过 event.sender 接触主进程对象。
 */
const api = {
  app: {
    getInfo: (): Promise<AppInfoResult> => ipcRenderer.invoke(IpcChannel.appGetInfo),

    /** 打开目录选择器；取消时返回 null */
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IpcChannel.dialogSelectDirectory)
  },

  project: {
    list: (): Promise<ProjectSummary[]> => ipcRenderer.invoke(IpcChannel.projectList),

    /** 打开目录选择器并登记；主进程负责去重与 Git 探测 */
    register: (): Promise<RegisterProjectResult> => ipcRenderer.invoke(IpcChannel.projectRegister),

    /** 移除登记；不删除磁盘文件 */
    remove: (request: ProjectRef): Promise<ProjectRemoveResult> =>
      ipcRenderer.invoke(IpcChannel.projectRemove, request),

    update: (request: ProjectUpdateRequest): Promise<ProjectSummary | null> =>
      ipcRenderer.invoke(IpcChannel.projectUpdate, request),

    /** 记录最近打开时间 */
    open: (request: ProjectRef): Promise<ProjectSummary | null> =>
      ipcRenderer.invoke(IpcChannel.projectOpen, request),

    /** 在系统资源管理器中打开项目目录 */
    reveal: (request: ProjectRef): Promise<ProjectRevealResult> =>
      ipcRenderer.invoke(IpcChannel.projectReveal, request),

    /** README 识别结果：选中项与多语言变体 */
    readme: (request: ProjectRef): Promise<ReadmeDetection> =>
      ipcRenderer.invoke(IpcChannel.projectReadme, request)
  },

  viewState: {
    get: (request: ViewStateRequest): Promise<ProjectViewState | null> =>
      ipcRenderer.invoke(IpcChannel.viewStateGet, request),

    save: (request: ViewStateSaveRequest): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.viewStateSave, request)
  },

  file: {
    list: (request: FileListRequest): Promise<FileListResult> =>
      ipcRenderer.invoke(IpcChannel.fileList, request),

    preview: (request: FilePreviewRequest): Promise<FilePreview> =>
      ipcRenderer.invoke(IpcChannel.filePreview, request),

    /** 读取项目内图片资源，返回 data URL */
    readAsset: (request: AssetRequestPayload): Promise<AssetReadResult> =>
      ipcRenderer.invoke(IpcChannel.markdownReadAsset, request),

    /** 删除到系统回收站；不可回收时整批停止并说明 */
    deleteToTrash: (request: FileDeleteRequest): Promise<DeleteEntriesResult> =>
      ipcRenderer.invoke(IpcChannel.fileDelete, request)
  },

  git: {
    snapshot: (request: GitSnapshotRequest): Promise<GitSnapshot> =>
      ipcRenderer.invoke(IpcChannel.gitSnapshot, request),

    /** 单个文件的只读差异；失败与「无差异」由 stale/error 区分 */
    fileDiff: (request: FileDiffRequest): Promise<FileDiff> =>
      ipcRenderer.invoke(IpcChannel.gitFileDiff, request)
  },

  watcher: {
    /** 设置被监听的活动项目；null 表示停止监听 */
    setActive: (request: WatcherSetActiveRequest): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.watcherSetActive, request),

    /** 订阅文件变化信号；返回取消订阅函数。信号只是刷新提示，不是事实来源。 */
    onChanged: (listener: (payload: ProjectChangedEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: ProjectChangedEvent): void => listener(payload)
      ipcRenderer.on(IpcChannel.watcherChanged, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.watcherChanged, handler)
      }
    }
  },

  system: {
    /** 交给系统浏览器；仅接受 http/https */
    openExternal: (request: OpenExternalRequest): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.systemOpenExternal, request),

    /** 用默认程序打开项目内文件或目录 */
    openPath: (request: OpenPathRequest): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.systemOpenPath, request),

    showInFolder: (request: OpenPathRequest): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.systemShowInFolder, request)
  },

  terminal: {
    create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(IpcChannel.terminalCreate, request),

    write: (request: TerminalWriteRequest): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.terminalWrite, request),

    resize: (request: TerminalResizeRequest): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.terminalResize, request),

    dispose: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.terminalDispose, sessionId),

    /** 订阅终端输出；返回取消订阅函数 */
    onData: (listener: (payload: TerminalDataEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: TerminalDataEvent): void => listener(payload)
      ipcRenderer.on(IpcChannel.terminalData, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.terminalData, handler)
      }
    },

    /** 订阅会话结束；返回取消订阅函数 */
    onExit: (listener: (payload: TerminalExitEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: TerminalExitEvent): void => listener(payload)
      ipcRenderer.on(IpcChannel.terminalExit, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.terminalExit, handler)
      }
    }
  }
}

export type WorkbenchApi = typeof api

contextBridge.exposeInMainWorld('workbench', api)
