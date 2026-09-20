import type { ProjectSummary } from '@shared/ipc'
import type { Project } from '@shared/types'
import type { ProjectWatcher } from '../modules/file-watcher'
import type { ProjectRegistry } from '../modules/project-registry'
import type { PtySessionManager } from '../modules/pty-session'
import type { HandleFn } from './guard'

/**
 * 主进程 IPC 处理器所需的全部外部依赖。
 *
 * 显式传入而不是在各域模块里直接引用模块级单例，有两个目的：
 * 一是让 `src/main/ipc/` 下每个文件只依赖这一个接口，通道可按域独立阅读；
 * 二是把「哪个域能碰终端、哪个域能碰文件系统」的权限面写成显式签名。
 */
export interface IpcContext {
  /** 带来源校验的通道注册函数 */
  handle: HandleFn
  registry(): ProjectRegistry
  /** 解析项目根目录；项目不可用时抛出 */
  projectRoot(projectId: string): string
  describe(project: Project): { text: string | null; source: 'user' | 'readme' | 'path' }
  listProjects(): ProjectSummary[]
  /** 项目元数据变更后失效简介缓存 */
  invalidateDescription(projectId: string): void
  terminals: PtySessionManager
  watcher: ProjectWatcher
  /**
   * 渲染进程对「退出前存在活动会话」询问的回应。
   * confirmed 为 true 时结束会话并退出；为 false 时取消本次退出。
   */
  resolveQuit(confirmed: boolean): void
}
