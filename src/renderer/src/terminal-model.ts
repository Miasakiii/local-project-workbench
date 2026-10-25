import type { TerminalDirectoryMode } from '@shared/terminal-settings'

/** 会话状态机：idle → starting → running → exited / failed，重建后回到 idle。 */
export type TerminalSessionStatus = 'idle' | 'starting' | 'running' | 'exited' | 'failed'

export interface TerminalSessionState {
  status: TerminalSessionStatus
  sessionId: string | null
  /** 实际启动的 shell 可执行路径；启动前与失败时为 null */
  shell: string | null
  exitCode: number | null
  error: string | null
}

export interface TerminalTab extends TerminalSessionState {
  key: number
  /** 启动目录（相对项目根）；空串表示项目根 */
  relativePath: string
  /** 换一个 epoch 触发终端视图重挂载，用于在同一标签内重建会话 */
  epoch: number
}

export interface TerminalSearchResults {
  resultIndex: number
  resultCount: number
}

export const EMPTY_SEARCH_RESULTS: TerminalSearchResults = { resultIndex: 0, resultCount: 0 }

export interface TerminalSearchHandle {
  findNext(term: string, incremental?: boolean): boolean
  findPrevious(term: string): boolean
  clear(): void
}

export type TerminalShortcut =
  | 'new-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'close-tab'
  | 'search'
  | 'font-increase'
  | 'font-decrease'
  | 'font-reset'

/** 只依赖键盘事件里用到的字段，便于在 Node 单元测试与 xterm 处理器之间共用。 */
export interface TerminalKeyChord {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * 终端面板内生效的快捷键。与浏览器/系统冲突的组合（Ctrl+W、Ctrl+F）刻意不用：
 * 关闭标签要求 Ctrl+Shift+W，搜索要求 Ctrl+Shift+F。
 */
export function matchTerminalShortcut(event: TerminalKeyChord): TerminalShortcut | null {
  if (!event.ctrlKey && !event.metaKey) return null
  const key = event.key.toLowerCase()
  if (event.shiftKey && key === 'f') return 'search'
  if (event.shiftKey && key === 't') return 'new-tab'
  if (event.shiftKey && key === 'w') return 'close-tab'
  if (event.key === 'Tab') return event.shiftKey ? 'prev-tab' : 'next-tab'
  if (event.key === '=' || event.key === '+') return 'font-increase'
  if (event.key === '-' || event.key === '_') return 'font-decrease'
  if (event.key === '0') return 'font-reset'
  return null
}

export function isSessionActive(status: TerminalSessionStatus): boolean {
  return status === 'starting' || status === 'running'
}

export function sessionStatusLabel(status: TerminalSessionStatus, exitCode: number | null = null): string {
  switch (status) {
    case 'idle':
      return '未启动'
    case 'starting':
      return '启动中'
    case 'running':
      return '运行中'
    case 'exited':
      return exitCode === null ? '已退出' : `已退出（退出码 ${exitCode}）`
    case 'failed':
      return '启动失败'
  }
}

/** 头部／面板共用的会话摘要；启动中与运行中分开计数，不把两者混成一句。 */
export function summarizeSessions(tabs: readonly Pick<TerminalTab, 'status'>[]): string {
  if (tabs.length === 0) return '未创建'
  let running = 0
  let starting = 0
  for (const tab of tabs) {
    if (tab.status === 'running') running += 1
    else if (tab.status === 'starting') starting += 1
  }
  if (running > 0 && starting > 0) return `${running} 运行中 · ${starting} 启动中`
  if (starting > 0) return `${starting} 个会话启动中`
  if (running > 0) return `${running} 个会话运行中`
  return `${tabs.length} 个标签`
}

export function tabLabel(relativePath: string): string {
  return relativePath.length > 0 ? relativePath : '项目根目录'
}

/**
 * 「当前目录」的落点：当前预览文件所在目录；没有可定位文件时退回项目根。
 * 只接受项目内相对路径，不在这里做任何绝对路径拼接。
 */
export function resolveStartupDirectory(mode: TerminalDirectoryMode, filePath: string): string {
  if (mode !== 'current') return ''
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '' : normalized.slice(0, index)
}

/** 循环切换标签；没有标签时返回 null，活动标签不在列表中时从头／尾开始。 */
export function cycleTabKey(
  tabs: readonly Pick<TerminalTab, 'key'>[],
  activeKey: number | null,
  direction: 1 | -1
): number | null {
  if (tabs.length === 0) return null
  const index = tabs.findIndex((tab) => tab.key === activeKey)
  if (index === -1) return (direction === 1 ? tabs[0] : tabs[tabs.length - 1])?.key ?? null
  const next = (index + direction + tabs.length) % tabs.length
  return tabs[next]?.key ?? null
}

/** 只有 http/https 才允许进入主进程的外部打开通道。 */
export function isOpenableLink(uri: string): boolean {
  try {
    const parsed = new URL(uri)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function shellDisplayName(shellPath: string | null, configuredShell: string): string {
  if (shellPath !== null && shellPath.length > 0) {
    const name = shellPath.split(/[\\/]/).pop()
    return name !== undefined && name.length > 0 ? name : shellPath
  }
  return configuredShell.length > 0 ? configuredShell : '自动探测'
}

export function searchCountLabel(term: string, results: TerminalSearchResults): string {
  if (term.length === 0) return '输入以搜索'
  if (results.resultCount === 0) return '无结果'
  if (results.resultIndex < 0) return `${results.resultCount} 个匹配`
  return `${results.resultIndex + 1}/${results.resultCount}`
}
