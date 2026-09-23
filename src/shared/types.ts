/**
 * 最小数据对象 — 对应设计稿 8.3。
 *
 * 约定：
 * - 渲染进程不得构造或传递任意绝对路径；路径一律以「项目 ID + 相对路径」表达。
 * - GitSnapshot 与 TerminalSession 不作为永久事实，不长期保存。
 */

/** 项目：已登记的本地目录（C08：不要求是 Git 仓库） */
export interface Project {
  /** 稳定 ID，登记时分配，不随路径变化 */
  id: string
  /** 显示名称，默认为目录名 */
  displayName: string
  /** 用户选择时的原始路径 */
  originalPath: string
  /** 规范化身份，用于去重；不得简单转为小写后比较 */
  normalizedIdentity: string
  /** 用户填写的简介覆盖 */
  descriptionOverride: string | null
  /** 用户指定的介绍文件相对路径 */
  readmePath: string | null
  /** 是否置顶 */
  pinned: boolean
  /** 最近打开时间（ISO 8601） */
  lastOpenedAt: string
  /** 信任状态；不可信项目默认只读浏览 */
  trusted: boolean
  /**
   * 是否为 Git 仓库。
   * C08：这是登记时探测的**可选属性**，不是登记前置条件。
   * null 表示尚未探测或探测失败——界面须与「确定不是仓库」分别表述。
   */
  isGitRepository: boolean | null
  /**
   * 是否允许本项目加载 README 里的网络图片（设计稿 4.3）。
   * 默认关闭；开启后仍只由主进程代理抓取，渲染进程不直接发起网络请求。
   */
  allowNetworkImages: boolean
}

/** 项目首页的三个页面 */
export type ProjectPage = 'overview' | 'files' | 'changes'

/** 项目视图状态：用于重启后恢复视图，不恢复进程 */
export interface ProjectViewState {
  projectId: string
  page: ProjectPage
  relativePath: string
  scrollTop: number
  terminalPanelHeight: number
  /** 文件页左侧树栏宽度（像素） */
  filesPaneWidth: number
  /** 终端面板上次是否展开（界面重构三项·阶段 4）；会话本身不跨重启恢复 */
  terminalOpen: boolean
}

/** Git 变更分组 */
export type GitChangeGroup = 'unstaged' | 'staged' | 'untracked' | 'conflicted'

export interface GitStatusEntry {
  group: GitChangeGroup
  /** 相对项目根目录的路径 */
  relativePath: string
  /** 原路径，仅重命名时有值 */
  originalPath: string | null
}

/**
 * Git 快照：只读，由主进程查询后下发。
 * stale/error 用于区分「没有变化」与「无法判断变化」。
 */
export interface GitSnapshot {
  projectId: string
  /** 查询序号；渲染进程须丢弃小于当前序号的返回 */
  sequence: number
  branch: string | null
  entries: GitStatusEntry[]
  updatedAt: string
  /** 查询失败或结果已过期 */
  stale: boolean
  error: string | null
}

/* ---------- 只读差异（设计稿 5.2） ---------- */

/** 差异的比较对象。未跟踪与冲突文件没有可比基线，各自单独一档。 */
export type DiffScope = 'unstaged' | 'staged' | 'untracked' | 'conflicted'

export type DiffLineKind = 'context' | 'add' | 'remove' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  /** 旧文件行号；新增行与 meta 行为 null */
  oldLine: number | null
  /** 新文件行号；删除行与 meta 行为 null */
  newLine: number | null
  text: string
}

export interface DiffHunk {
  /** 原始 hunk 标题，例如 `@@ -1,3 +1,4 @@ 说明` */
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'unchanged'

/**
 * 单个文件的只读差异。
 *
 * 失败与「无差异」必须分别表达：`error` 非空表示无法判断，不得呈现为「没有变化」。
 */
export interface FileDiff {
  projectId: string
  relativePath: string
  scope: DiffScope
  status: DiffFileStatus
  /** 二进制文件不提供逐行差异 */
  binary: boolean
  /** 重命名时的原路径 */
  originalPath: string | null
  hunks: DiffHunk[]
  addedLines: number
  removedLines: number
  /** 差异超过行数上限，已截断 */
  truncated: boolean
  /** 未跟踪文件没有 Git 历史基线 */
  noBaseline: boolean
  updatedAt: string
  stale: boolean
  error: string | null
}

/* ---------- 文件变化信号（设计稿 5.1／5.3） ---------- */

/**
 * 文件系统变化信号。
 * 监听只是刷新信号，**不是事实来源**——事实以重新读取与 Git 查询为准。
 */
export interface ProjectChangedEvent {
  projectId: string
  /** 变化涉及的相对路径（最多若干条，用于判断当前预览是否需要重载） */
  paths: string[]
  /** 是否为批量变化（超出上限时只给汇总，不逐条列出） */
  bulk: boolean
  at: string
}

/** 终端会话：只在本次应用运行期间有效 */
export interface TerminalSession {
  sessionId: string
  projectId: string
  shell: string
  /** 启动目录 */
  cwd: string
  running: boolean
}

/** 应用级信息 */
export interface AppInfo {
  name: string
  version: string
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  platform: NodeJS.Platform
}

/* ---------- README 与预览（设计稿 4.1 / 4.2 / 4.3） ---------- */

/** README 的多语言变体，例如 README.zh-CN.md */
export interface ReadmeVariant {
  relativePath: string
  /** 语言标记，例如 zh-CN；无标记时为 null */
  locale: string | null
}

export interface ReadmeDetection {
  /** 被选中的介绍文件相对路径；未找到为 null */
  selected: string | null
  /** 同目录下的多语言变体（不含 selected） */
  variants: ReadmeVariant[]
  /** 探测位置 */
  location: 'root' | 'docs' | '.github' | null
}

/** 内容被阻止的原因码。界面据此解释「为什么没显示」，不呈现为空白成功页。 */
export type BlockedReasonCode =
  | 'unsafe-protocol'
  | 'remote-resource'
  | 'outside-project'
  | 'invalid-path'
  | 'oversized'
  | 'unsupported-format'
  | 'raw-html'
  | 'unreadable'

export interface BlockedNotice {
  kind: 'image' | 'link' | 'tag' | 'comment'
  /** 被阻止的原始目标 */
  target: string
  reason: BlockedReasonCode
  /** 面向用户的中文说明 */
  message: string
}

/** 渲染结果。`html` 已通过白名单净化与自审，`violations` 非空时不得采用。 */
export interface MarkdownDocument {
  projectId: string
  relativePath: string
  html: string
  /** 需按需加载的项目内图片相对路径 */
  assets: string[]
  /** 已获授权的外部图片地址；渲染进程据此决定是否加载 */
  remoteAssets: string[]
  /** 项目内链接（点击后在应用内跳转，不发起导航） */
  projectLinks: string[]
  blocked: BlockedNotice[]
  externalLinkCount: number
  sourceBytes: number
  /** 文件超过文本预览阈值，内容已截断 */
  truncated: boolean
  /** 净化自审违规项；非空表示输出不可信 */
  violations: string[]
}

export type AssetReadStatus = 'ok' | 'too-large' | 'unsupported-format' | 'blocked' | 'unreadable'

export interface AssetReadResult {
  status: AssetReadStatus
  relativePath: string
  mime: string | null
  /** data URL；仅 status 为 ok 时存在 */
  dataUrl: string | null
  bytes: number
  message: string | null
}

/**
 * 网络图片的读取结果（设计稿 4.3）。
 *
 * 与项目内资源分开表达，因为失败原因不同：未授权、协议不支持、指向本机或内网
 * 都是**策略结论**而非读取故障，界面须分别说明，不得合并成「加载失败」。
 */
export type RemoteAssetStatus =
  | 'ok'
  | 'not-authorized'
  | 'unsupported-protocol'
  | 'forbidden-host'
  | 'unsupported-format'
  | 'too-large'
  | 'unreachable'

export interface RemoteAssetResult {
  status: RemoteAssetStatus
  /** 请求的地址（原样回显，便于界面定位是哪一张图） */
  url: string
  mime: string | null
  /** data URL；仅 status 为 ok 时存在。远程内容一律经主进程换取，渲染进程不直连 */
  dataUrl: string | null
  bytes: number
  message: string | null
}

/* ---------- 文件操作（设计稿第 7 章） ---------- */

/** 文件操作失败原因。界面据此给出具体说明，不呈现为统一成功或统一失败。 */
export type FileOperationReason =
  | 'untrusted-project'
  | 'protected-entry'
  | 'outside-project'
  | 'invalid-path'
  | 'name-conflict'
  | 'path-changed'
  | 'not-found'
  | 'permission-denied'
  | 'in-use'
  | 'read-only'
  | 'trash-unavailable'
  | 'io-error'

export type FileOperationStatus = 'ok' | 'failed' | 'skipped'

/** 单项操作结果。批量操作必须逐项给出，避免静默部分失败。 */
export interface FileOperationItem {
  /** 源路径；新建操作中表示新建出的目标路径 */
  relativePath: string
  /** 复制、移动或新建操作的目标路径 */
  targetRelativePath?: string | null
  status: FileOperationStatus
  reason: FileOperationReason | null
  message: string
}

/** 可复用的批量文件操作结果；失败与未执行项必须逐项列出。 */
export interface FileOperationBatchResult {
  items: FileOperationItem[]
  ok: number
  failed: number
  skipped: number
  /** 整批中止（未执行项已标记为 skipped，或操作前即被整体拒绝） */
  aborted: boolean
  abortReason: FileOperationReason | null
  abortMessage: string | null
}

export type DeleteEntriesResult = FileOperationBatchResult
export type CreateEntryResult = FileOperationBatchResult
export type TransferEntriesResult = FileOperationBatchResult

/** 单点重命名结果；源与目标都以项目内相对路径表达。 */
export interface RenameEntryResult {
  relativePath: string
  targetRelativePath: string | null
  status: FileOperationStatus
  reason: FileOperationReason | null
  message: string
}

/* ---------- 项目库与文件浏览（设计稿 2.1 / 2.2 / 4.2） ---------- */

/**
 * 项目摘要：界面使用的项目视图对象。
 * `available` 为运行时判定结果，不是持久化字段——目录可能被移动或删除。
 */
export interface ProjectSummary {
  id: string
  displayName: string
  /** 用户选择时的原始路径 */
  originalPath: string
  /** 规范化身份（真实路径），用于去重与重新定位 */
  normalizedIdentity: string
  /** 简介：用户填写优先，其次 README 首段 */
  description: string | null
  descriptionSource: 'user' | 'readme' | 'path'
  readmePath: string | null
  pinned: boolean
  lastOpenedAt: string
  trusted: boolean
  /** true 是仓库，false 不是，null 表示 Git 不可用或尚未探测 */
  isGitRepository: boolean | null
  /** 本项目是否被允许加载 README 中的网络图片（设计稿 4.3，默认关闭） */
  allowNetworkImages: boolean
  available: boolean
  unavailableReason: string | null
}

export type FileEntryKind = 'file' | 'directory'

export interface FileEntry {
  name: string
  relativePath: string
  kind: FileEntryKind
  size: number
  modifiedAt: string
  /** 符号链接或目录联接 */
  isLink: boolean
}

export interface FileListResult {
  relativePath: string
  /** 面包屑：从项目根到当前目录 */
  breadcrumb: Array<{ name: string; relativePath: string }>
  entries: FileEntry[]
  /** 条目数超过上限，列表已截断 */
  truncated: boolean
  error: string | null
}

export type PreviewKind = 'markdown' | 'text' | 'code' | 'image' | 'unsupported' | 'error'

export interface FilePreview {
  kind: PreviewKind
  relativePath: string
  name: string
  /** 代码语言标识；非代码为 null */
  language: string | null
  /** 纯文本内容（text／code） */
  text: string | null
  /** 高亮后的 HTML（code，已转义） */
  highlightedHtml: string | null
  /** Markdown 渲染结果 */
  markdown: MarkdownDocument | null
  /** 图片资源结果 */
  image: AssetReadResult | null
  size: number
  /** 是否因超过阈值而截断 */
  truncated: boolean
  /** 行数，仅代码／文本有值 */
  lineCount: number | null
  /** 无法预览时的说明 */
  message: string | null
}
