import type {
  AppInfo,
  AssetReadResult,
  CreateEntryResult,
  DeleteEntriesResult,
  DiffScope,
  FileDiff,
  FileListResult,
  FileOperationBatchResult,
  FileOperationItem,
  FilePreview,
  GitSnapshot,
  MarkdownDocument,
  ProjectChangedEvent,
  ProjectPage,
  ProjectSummary,
  ReadmeDetection,
  RemoteAssetResult,
  RemoteAssetStatus,
  RenameEntryResult,
  TransferEntriesResult
} from './types'

/**
 * IPC 通道名与契约。
 *
 * 安全约定（设计稿 8.1 / 8.2.3）：
 * - 渲染进程不得直接接触 ipcRenderer，只能调用预加载层暴露的白名单方法。
 * - 主进程须校验调用来源，不信任渲染进程传入的任意绝对路径。
 * - 渲染进程一律以「项目 ID + 相对路径」表达目标，主进程负责解析真实路径。
 * - 终端输入是独立特权通道，不得开放给文档预览。
 */
export const IpcChannel = {
  appGetInfo: 'app:get-info',
  appConfirmQuit: 'app:confirm-quit',
  appQuitRequested: 'app:quit-requested',
  appStartupView: 'app:startup-view',
  settingsUpdate: 'settings:update',
  dialogSelectDirectory: 'dialog:select-directory',

  projectList: 'project:list',
  projectRegister: 'project:register',
  projectRemove: 'project:remove',
  projectUpdate: 'project:update',
  projectOpen: 'project:open',
  projectReveal: 'project:reveal',
  projectRelocate: 'project:relocate',
  projectReadme: 'project:readme',

  viewStateGet: 'view-state:get',
  viewStateSave: 'view-state:save',

  fileList: 'file:list',
  filePreview: 'file:preview',
  fileDelete: 'file:delete',
  fileCreate: 'file:create',
  fileRename: 'file:rename',
  fileTransfer: 'file:transfer',
  markdownReadAsset: 'markdown:read-asset',
  markdownReadRemoteAsset: 'markdown:read-remote-asset',

  gitSnapshot: 'git:snapshot',
  gitFileDiff: 'git:file-diff',

  watcherSetActive: 'watcher:set-active',
  watcherChanged: 'watcher:changed',

  systemOpenExternal: 'system:open-external',
  systemOpenPath: 'system:open-path',
  systemShowInFolder: 'system:show-in-folder',
  systemOpenWith: 'system:open-with',
  systemSetEditor: 'system:set-editor',
  systemClearEditor: 'system:clear-editor',

  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalDispose: 'terminal:dispose',

  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export type AppInfoResult = AppInfo

/* ---------- 项目库 ---------- */

export type RegisterStatus = 'added' | 'existing' | 'cancelled' | 'unavailable'

export interface RegisterProjectResult {
  status: RegisterStatus
  project: ProjectSummary | null
  message: string | null
}

export interface ProjectRef {
  projectId: string
}

export interface ProjectUpdateRequest {
  projectId: string
  pinned?: boolean
  trusted?: boolean
  displayName?: string
  /** 用户指定的介绍文件相对路径；null 表示恢复自动识别 */
  readmePath?: string | null
  /** 用户填写的简介；null 表示恢复自动提取 */
  descriptionOverride?: string | null
  /** 「允许本项目加载网络图片」开关（设计稿 4.3） */
  allowNetworkImages?: boolean
}

export interface ProjectRemoveResult {
  removed: boolean
  message: string
  /** 明确告知磁盘文件未受影响 */
  diskUntouched: true
}

export interface ProjectRevealResult {
  opened: boolean
  message: string | null
}

export interface ProjectRelocateResult {
  status: 'relocated' | 'unchanged' | 'unavailable' | 'duplicate' | 'not-found' | 'cancelled'
  project: ProjectSummary | null
  message: string
  /** 是否因目录身份变化而撤销了信任，界面据此提示用户重新确认 */
  trustReset: boolean
}

/* ---------- 退出确认 ---------- */

/** 主进程 → 渲染进程：退出前存在活动终端会话，需要用户确认 */
export interface QuitRequestedEvent {
  /** 正在运行的终端会话数量 */
  sessionCount: number
}

export interface QuitConfirmRequest {
  /** true 表示确认退出（会话将被结束）；false 表示取消退出 */
  confirmed: boolean
}

/* ---------- 启动视图与应用偏好（C09 / 验收场景 10） ---------- */

export interface StartupViewResult {
  /** 「恢复上次项目」开关当前状态；界面用它渲染开关初始值 */
  restoreLastProject: boolean
  /** 启动时应直接打开的项目；null 表示停留项目库 */
  projectId: string | null
  /** 开关已开启但未能恢复时的说明；其余情况为 null */
  notice: string | null
  /** 「用指定编辑器打开」所用的编辑器路径；null=未设置（G3b），供设置页显示 */
  editorPath: string | null
  /** 终端默认 Shell；空串=按本机自动探测（界面重构三项·阶段 2） */
  defaultShell: string
}

export interface UpdateSettingsRequest {
  /** 「恢复上次项目」开关；缺省表示本次不改动该项 */
  restoreLastProject?: boolean
  /** 终端默认 Shell（''=自动／pwsh／powershell／cmd，主进程白名单校验）；缺省表示不改动 */
  defaultShell?: string
}

/**
 * 应用级偏好。同时是 `settings.json` 的持久化形态（`app-settings.ts`），
 * 因此这里的字段都是可恢复的启动位置信息，不是界面临时状态。
 */
export interface SettingsResult {
  /** 「恢复上次项目」开关；默认关闭（C09） */
  restoreLastProject: boolean
  /** 上次活跃的项目 ID；从未打开过为 null */
  lastProjectId: string | null
  /** 「用指定编辑器打开」所用的编辑器可执行路径；null=尚未设置（设计稿 4.2，G3b） */
  editorPath: string | null
  /** 终端默认 Shell；空串=自动探测（界面重构三项·阶段 2，设置页承载） */
  defaultShell: string
}

/* ---------- 视图状态 ---------- */

export interface ViewStateRequest {
  projectId: string
}

export interface ViewStateSaveRequest {
  projectId: string
  page: ProjectPage
  relativePath: string
  scrollTop: number
  terminalPanelHeight: number
  filesPaneWidth: number
}

/* ---------- 文件浏览与预览 ---------- */

export interface FileListRequest {
  projectId: string
  relativePath: string
}

export interface FilePreviewRequest {
  projectId: string
  relativePath: string
}

export interface FileDeleteRequest {
  projectId: string
  relativePaths: string[]
}

export interface FileCreateRequest {
  projectId: string
  /** 新建目标所在的项目内目录；空串表示项目根 */
  parentRelativePath: string
  name: string
  kind: 'file' | 'directory'
}

export interface FileRenameRequest {
  projectId: string
  relativePath: string
  /** 同一父目录内的新名称；不接受路径分隔符 */
  newName: string
}

export interface FileTransferRequest {
  projectId: string
  /** 复制/剪切的项目内源路径；由主进程去重并逐项报告 */
  relativePaths: string[]
  /** 粘贴目标目录；空串表示项目根 */
  targetDirectory: string
  mode: 'copy' | 'move'
}

export interface AssetRequestPayload {
  projectId: string
  relativePath: string
  allowOversized?: boolean
}

/**
 * 网络图片换取请求。
 *
 * 地址只接受「该项目上一次渲染结果里由主进程自己标记的 `data-remote` 值」，
 * 主进程仍会独立复核协议、域名授权、体积与响应类型，不信任渲染进程传入的内容。
 */
export interface RemoteAssetRequestPayload {
  projectId: string
  url: string
}

export interface GitSnapshotRequest {
  projectId: string
  sequence: number
}

export interface FileDiffRequest {
  projectId: string
  relativePath: string
  scope: DiffScope
  /** 重命名时的原路径（来自状态条目） */
  originalPath?: string | null
}

export interface WatcherSetActiveRequest {
  /** null 表示不再监听任何项目 */
  projectId: string | null
}

export interface OpenExternalRequest {
  url: string
}

export interface OpenPathRequest {
  projectId: string
  relativePath: string
}

/* ---------- 终端 ---------- */

export interface TerminalCreateRequest {
  /** 启动目录。主进程须校验其存在且为目录，不直接信任传入值。 */
  projectId: string
  /** 相对项目根目录的启动路径；空串表示项目根 */
  relativePath: string
  cols: number
  rows: number
  /** 可选：指定 shell（pwsh／powershell／cmd）；缺省或未命中时按本机自动探测 */
  shell?: string
}

export interface TerminalCreateResult {
  sessionId: string
  shell: string
  cwd: string
}

export interface TerminalWriteRequest {
  sessionId: string
  data: string
}

export interface TerminalResizeRequest {
  sessionId: string
  cols: number
  rows: number
}

/** 主进程 → 渲染进程：终端输出 */
export interface TerminalDataEvent {
  sessionId: string
  data: string
}

/** 主进程 → 渲染进程：会话结束 */
export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  signal: number | null
}

export type {
  AssetReadResult,
  CreateEntryResult,
  DeleteEntriesResult,
  DiffScope,
  FileDiff,
  FileListResult,
  FileOperationBatchResult,
  FileOperationItem,
  FilePreview,
  GitSnapshot,
  MarkdownDocument,
  ProjectChangedEvent,
  ProjectPage,
  ProjectSummary,
  ReadmeDetection,
  RemoteAssetResult,
  RemoteAssetStatus,
  RenameEntryResult,
  TransferEntriesResult
}
