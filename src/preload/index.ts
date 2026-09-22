import type {
  AppInfoResult,
  AssetReadResult,
  AssetRequestPayload,
  CreateEntryResult,
  DeleteEntriesResult,
  FileCreateRequest,
  FileDeleteRequest,
  FileDiffRequest,
  FileListRequest,
  FileListResult,
  FilePreview,
  FilePreviewRequest,
  FileRenameRequest,
  FileTransferRequest,
  GitSnapshot,
  GitSnapshotRequest,
  OpenExternalRequest,
  OpenPathRequest,
  ProjectRef,
  ProjectRelocateResult,
  ProjectRemoveResult,
  ProjectRevealResult,
  ProjectSummary,
  ProjectUpdateRequest,
  QuitConfirmRequest,
  QuitRequestedEvent,
  RegisterProjectResult,
  RemoteAssetRequestPayload,
  RemoteAssetResult,
  RenameEntryResult,
  SettingsResult,
  StartupViewResult,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeRequest,
  TerminalWriteRequest,
  TransferEntriesResult,
  UpdateSettingsRequest,
  ViewStateRequest,
  ViewStateSaveRequest,
  WatcherSetActiveRequest
} from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import type { FileDiff, ProjectChangedEvent, ProjectViewState, ReadmeDetection } from '@shared/types'
import { contextBridge, ipcRenderer } from 'electron'

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
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke(IpcChannel.dialogSelectDirectory),

    /**
     * 启动位置：主进程判定本次启动是否直接进入上次项目（C09）。
     * 渲染进程只接受结论——要打开哪个项目、以及为什么没恢复，不参与判定本身。
     */
    startupView: (): Promise<StartupViewResult> => ipcRenderer.invoke(IpcChannel.appStartupView),

    /**
     * 回应「退出前存在活动会话」的询问。
     * confirmed 为 false 时取消本次退出，应用继续运行。
     */
    confirmQuit: (request: QuitConfirmRequest): Promise<void> => ipcRenderer.invoke(IpcChannel.appConfirmQuit, request),

    /** 订阅退出询问；返回取消订阅函数。 */
    onQuitRequested: (listener: (payload: QuitRequestedEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: QuitRequestedEvent): void => listener(payload)
      ipcRenderer.on(IpcChannel.appQuitRequested, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.appQuitRequested, handler)
      }
    }
  },

  settings: {
    /** 只开放界面能表达的那一项偏好；返回主进程实际持久化的值 */
    update: (request: UpdateSettingsRequest): Promise<SettingsResult> =>
      ipcRenderer.invoke(IpcChannel.settingsUpdate, request)
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
    open: (request: ProjectRef): Promise<ProjectSummary | null> => ipcRenderer.invoke(IpcChannel.projectOpen, request),

    /** 在系统资源管理器中打开项目目录 */
    reveal: (request: ProjectRef): Promise<ProjectRevealResult> =>
      ipcRenderer.invoke(IpcChannel.projectReveal, request),

    /**
     * 把登记重新定位到另一个目录。身份变化会撤销信任，需要用户重新确认。
     * 取消选择时返回 status 为 cancelled。
     */
    relocate: (request: ProjectRef): Promise<ProjectRelocateResult> =>
      ipcRenderer.invoke(IpcChannel.projectRelocate, request),

    /** README 识别结果：选中项与多语言变体 */
    readme: (request: ProjectRef): Promise<ReadmeDetection> => ipcRenderer.invoke(IpcChannel.projectReadme, request)
  },

  viewState: {
    get: (request: ViewStateRequest): Promise<ProjectViewState | null> =>
      ipcRenderer.invoke(IpcChannel.viewStateGet, request),

    save: (request: ViewStateSaveRequest): Promise<void> => ipcRenderer.invoke(IpcChannel.viewStateSave, request)
  },

  file: {
    list: (request: FileListRequest): Promise<FileListResult> => ipcRenderer.invoke(IpcChannel.fileList, request),

    preview: (request: FilePreviewRequest): Promise<FilePreview> => ipcRenderer.invoke(IpcChannel.filePreview, request),

    /** 读取项目内图片资源，返回 data URL */
    readAsset: (request: AssetRequestPayload): Promise<AssetReadResult> =>
      ipcRenderer.invoke(IpcChannel.markdownReadAsset, request),

    /**
     * 换取已授权项目的网络图片，由主进程抓取后返回 data URL。
     * 渲染进程不直连远程地址，授权与否也只由主进程按登记记录判定。
     */
    readRemoteAsset: (request: RemoteAssetRequestPayload): Promise<RemoteAssetResult> =>
      ipcRenderer.invoke(IpcChannel.markdownReadRemoteAsset, request),

    /** 删除到系统回收站；不可回收时整批停止并说明 */
    deleteToTrash: (request: FileDeleteRequest): Promise<DeleteEntriesResult> =>
      ipcRenderer.invoke(IpcChannel.fileDelete, request),

    /** 新建空文件或空文件夹，不覆盖同名目标 */
    create: (request: FileCreateRequest): Promise<CreateEntryResult> =>
      ipcRenderer.invoke(IpcChannel.fileCreate, request),

    /** 在同一项目内复制或剪切粘贴，逐项报告结果 */
    transfer: (request: FileTransferRequest): Promise<TransferEntriesResult> =>
      ipcRenderer.invoke(IpcChannel.fileTransfer, request),

    /** 在同一父目录内重命名单个文件或文件夹 */
    rename: (request: FileRenameRequest): Promise<RenameEntryResult> =>
      ipcRenderer.invoke(IpcChannel.fileRename, request)
  },

  git: {
    snapshot: (request: GitSnapshotRequest): Promise<GitSnapshot> =>
      ipcRenderer.invoke(IpcChannel.gitSnapshot, request),

    /** 单个文件的只读差异；失败与「无差异」由 stale/error 区分 */
    fileDiff: (request: FileDiffRequest): Promise<FileDiff> => ipcRenderer.invoke(IpcChannel.gitFileDiff, request)
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

    /** 用「设置编辑器…」里选择的编辑器打开项目内文件；未设置或启动失败时返回可读原因 */
    openWith: (request: OpenPathRequest): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.systemOpenWith, request),

    /** 选择并保存用于打开文件的编辑器（主进程选 exe，持久化到 settings.json）；取消返回 null */
    setEditor: (): Promise<string | null> => ipcRenderer.invoke(IpcChannel.systemSetEditor),

    showInFolder: (request: OpenPathRequest): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.systemShowInFolder, request)
  },

  terminal: {
    create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(IpcChannel.terminalCreate, request),

    write: (request: TerminalWriteRequest): Promise<void> => ipcRenderer.invoke(IpcChannel.terminalWrite, request),

    resize: (request: TerminalResizeRequest): Promise<void> => ipcRenderer.invoke(IpcChannel.terminalResize, request),

    dispose: (sessionId: string): Promise<void> => ipcRenderer.invoke(IpcChannel.terminalDispose, sessionId),

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
