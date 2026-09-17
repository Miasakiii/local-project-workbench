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
