import { TERMINAL_FONT_SIZE_DEFAULT, type TerminalPreferences } from '@shared/terminal-settings'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useModalFocus } from '../hooks/useModalFocus'
import {
  cycleTabKey,
  EMPTY_SEARCH_RESULTS,
  isOpenableLink,
  isSessionActive,
  matchTerminalShortcut,
  searchCountLabel,
  sessionStatusLabel,
  shellDisplayName,
  tabLabel,
  type TerminalSearchHandle,
  type TerminalSearchResults,
  type TerminalSessionState,
  type TerminalShortcut,
  type TerminalTab
} from '../terminal-model'
import { ResizeHandle } from './ResizeHandle'
import { stepTerminalFontSize } from './terminal-appearance'
import { TerminalView } from './TerminalView'

export type { TerminalTab } from '../terminal-model'

const MIN_PANEL_HEIGHT = 120
const PANEL_RESERVED_HEIGHT = 220

export function clampPanelHeight(value: number): number {
  const max = Math.max(MIN_PANEL_HEIGHT + 60, window.innerHeight - PANEL_RESERVED_HEIGHT)
  return Math.min(Math.max(Math.round(value), MIN_PANEL_HEIGHT), max)
}

interface TerminalPanelProps {
  projectId: string
  projectName: string
  tabs: TerminalTab[]
  activeTabKey: number | null
  terminalOpen: boolean
  terminalMaximized: boolean
  panelHeight: number
  settings: TerminalPreferences
  onPanelHeightChange: (height: number) => void
  onToggleMaximized: () => void
  onClosePanel: () => void
  onNewTab: () => void
  onSelectTab: (key: number) => void
  onRequestCloseTab: (key: number) => void
  onRequestEndSession: (key: number) => void
  onRestartTab: (key: number) => void
  onSettingsChange: (patch: Partial<TerminalPreferences>) => void
  onSessionStateChange: (key: number, state: TerminalSessionState) => void
}

export function TerminalPanel({
  projectId,
  projectName,
  tabs,
  activeTabKey,
  terminalOpen,
  terminalMaximized,
  panelHeight,
  settings,
  onPanelHeightChange,
  onToggleMaximized,
  onClosePanel,
  onNewTab,
  onSelectTab,
  onRequestCloseTab,
  onRequestEndSession,
  onRestartTab,
  onSettingsChange,
  onSessionStateChange
}: TerminalPanelProps): React.JSX.Element {
  const panelHeightOriginRef = useRef(panelHeight)
  const panelRef = useRef<HTMLElement>(null)
  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? null
  const runningTabCount = tabs.filter((tab) => tab.status === 'running').length
  const startingTabCount = tabs.filter((tab) => tab.status === 'starting').length

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<TerminalSearchResults>(EMPTY_SEARCH_RESULTS)
  const [, setSearchHandleVersion] = useState(0)
  const searchHandlesRef = useRef(new Map<number, TerminalSearchHandle>())
  const searchInputRef = useRef<HTMLInputElement>(null)
  const previousActiveRef = useRef<number | null>(activeTabKey)

  const [linkPrompt, setLinkPrompt] = useState<string | null>(null)
  const { dialogRef: linkDialogRef } = useModalFocus(linkPrompt !== null, () => setLinkPrompt(null))

  const registerSearch = useCallback((key: number, handle: TerminalSearchHandle | null) => {
    if (handle === null) {
      searchHandlesRef.current.delete(key)
      return
    }
    searchHandlesRef.current.set(key, handle)
    setSearchHandleVersion((value) => value + 1)
  }, [])

  const activeSearchHandle = activeTabKey === null ? null : (searchHandlesRef.current.get(activeTabKey) ?? null)

  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
    searchInputRef.current?.select()
  }, [searchOpen])

  // 切换标签时清掉旧标签的高亮；搜索词保留，新标签会重新执行一次查找。
  useEffect(() => {
    const previous = previousActiveRef.current
    if (previous !== null && previous !== activeTabKey) {
      searchHandlesRef.current.get(previous)?.clear()
    }
    previousActiveRef.current = activeTabKey
    setSearchResults(EMPTY_SEARCH_RESULTS)
  }, [activeTabKey])

  useEffect(() => {
    if (!searchOpen) return
    if (activeSearchHandle === null) return
    if (searchTerm.length === 0) {
      activeSearchHandle.clear()
      setSearchResults(EMPTY_SEARCH_RESULTS)
      return
    }
    activeSearchHandle.findNext(searchTerm, true)
  }, [activeSearchHandle, searchOpen, searchTerm])

  const runSearch = useCallback(
    (direction: 1 | -1) => {
      if (activeSearchHandle === null || searchTerm.length === 0) return
      if (direction === 1) activeSearchHandle.findNext(searchTerm, false)
      else activeSearchHandle.findPrevious(searchTerm)
    },
    [activeSearchHandle, searchTerm]
  )

  const closeSearch = useCallback(() => {
    activeSearchHandle?.clear()
    setSearchOpen(false)
    setSearchTerm('')
    setSearchResults(EMPTY_SEARCH_RESULTS)
  }, [activeSearchHandle])

  const handleLinkOpen = useCallback(
    (uri: string) => {
      if (!isOpenableLink(uri)) return
      if (settings.linkOpenBehavior === 'off') return
      if (settings.linkOpenBehavior === 'always') {
        void window.workbench.system.openExternal({ url: uri })
        return
      }
      setLinkPrompt(uri)
    },
    [settings.linkOpenBehavior]
  )

  const confirmLink = useCallback(() => {
    const uri = linkPrompt
    setLinkPrompt(null)
    if (uri !== null) void window.workbench.system.openExternal({ url: uri })
  }, [linkPrompt])

  const runShortcut = useCallback(
    (shortcut: TerminalShortcut) => {
      switch (shortcut) {
        case 'search':
          setSearchOpen(true)
          return
        case 'new-tab':
          onNewTab()
          return
        case 'close-tab':
          if (activeTabKey !== null) onRequestCloseTab(activeTabKey)
          return
        case 'next-tab':
        case 'prev-tab': {
          const nextKey = cycleTabKey(tabs, activeTabKey, shortcut === 'next-tab' ? 1 : -1)
          if (nextKey !== null) onSelectTab(nextKey)
          return
        }
        case 'font-increase':
          onSettingsChange({ fontSize: stepTerminalFontSize(settings.fontSize, 1) })
          return
        case 'font-decrease':
          onSettingsChange({ fontSize: stepTerminalFontSize(settings.fontSize, -1) })
          return
        case 'font-reset':
          onSettingsChange({ fontSize: TERMINAL_FONT_SIZE_DEFAULT })
      }
    },
    [activeTabKey, onNewTab, onRequestCloseTab, onSelectTab, onSettingsChange, settings.fontSize, tabs]
  )

  /**
   * 面板空白处的快捷键入口。终端宿主内的按键由 xterm 的
   * `attachCustomKeyEventHandler` 处理，这里跳过以免同一次按键执行两遍。
   *
   * 用原生监听而不是 JSX onKeyDown：面板本身不是交互元素，挂合成事件会
   * 触发静态元素可交互性告警，而且这里只需要冒泡到面板边界的按键。
   */
  useEffect(() => {
    const node = panelRef.current
    if (node === null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('.terminal-host') !== null) return
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault()
        closeSearch()
        return
      }
      const shortcut = matchTerminalShortcut(event)
      if (shortcut === null) return
      event.preventDefault()
      runShortcut(shortcut)
    }
    node.addEventListener('keydown', handleKeyDown)
    return () => node.removeEventListener('keydown', handleKeyDown)
  }, [closeSearch, runShortcut, searchOpen])

  const searchCount = searchCountLabel(searchTerm, searchResults)
  const hasMatches = searchResults.resultCount > 0

  return (
    <section
      ref={panelRef}
      className={
        terminalOpen ? (terminalMaximized ? 'terminal-panel maximized' : 'terminal-panel') : 'terminal-panel closed'
      }
      style={terminalOpen && !terminalMaximized ? { height: panelHeight } : undefined}
    >
      {terminalMaximized ? null : (
        <ResizeHandle
          axis="y"
          className="terminal-resize"
          ariaLabel="拖拽调整终端面板高度"
          onDragStart={() => {
            panelHeightOriginRef.current = panelHeight
          }}
          onDrag={(delta) => onPanelHeightChange(clampPanelHeight(panelHeightOriginRef.current - delta))}
          onDragEnd={() => undefined}
        />
      )}

      <header className="terminal-header">
        <div className="terminal-title">
          <strong>终端</strong>
          <span className="chip">{projectName}</span>
          {runningTabCount > 0 ? (
            <span className="badge badge-live">{runningTabCount} 个会话运行中</span>
          ) : startingTabCount > 0 ? (
            <span className="badge">{startingTabCount} 个会话启动中</span>
          ) : (
            <span className="badge">无活动会话</span>
          )}
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            aria-pressed={searchOpen}
            title="搜索回滚缓冲区（Ctrl+Shift+F）"
          >
            搜索
          </button>
          {activeTab !== null &&
          (activeTab.status === 'idle' || activeTab.status === 'exited' || activeTab.status === 'failed') ? (
            <button type="button" onClick={() => onRestartTab(activeTab.key)} title="在当前标签内重新建立会话">
              重建会话
            </button>
          ) : null}
          <button type="button" onClick={onNewTab} title="新建一个终端标签（Ctrl+Shift+T）">
            新建标签
          </button>
          <button
            type="button"
            onClick={onToggleMaximized}
            title={terminalMaximized ? '还原为面板' : '全屏：终端吃满主区域'}
            aria-pressed={terminalMaximized}
          >
            {terminalMaximized ? '还原' : '全屏'}
          </button>
          <button type="button" onClick={onClosePanel} title="收起终端面板，会话继续在后台运行">
            收起
          </button>
          {activeTab !== null && isSessionActive(activeTab.status) ? (
            <button
              type="button"
              className="danger"
              onClick={() => onRequestEndSession(activeTab.key)}
              title="结束当前标签的会话（其中的命令会被中断）"
            >
              结束会话
            </button>
          ) : null}
        </div>
      </header>

      <div className="terminal-tabs" role="tablist" aria-label="终端标签">
        {tabs.map((tab) => {
          const isActive = tab.key === activeTabKey
          const label = tabLabel(tab.relativePath)
          const dotClass = tab.status === 'running' ? 'tab-dot live' : `tab-dot ${tab.status}`
          return (
            <div key={tab.key} className={isActive ? 'terminal-tab active' : 'terminal-tab'}>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="terminal-tab-label"
                onClick={() => onSelectTab(tab.key)}
                title={`${label}\n状态：${sessionStatusLabel(tab.status, tab.exitCode)}\nShell：${shellDisplayName(
                  tab.shell,
                  settings.defaultShell
                )}`}
              >
                <span className={dotClass} aria-hidden="true" />
                {label}
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                onClick={() => onRequestCloseTab(tab.key)}
                title="关闭标签（运行中的会话会先确认）"
                aria-label={`关闭标签 ${label}`}
              >
                ×
              </button>
            </div>
          )
        })}
        <button type="button" className="terminal-tab-add" onClick={onNewTab} title="新建标签" aria-label="新建标签">
          +
        </button>
      </div>

      {searchOpen ? (
        <search className="terminal-search">
          <input
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                runSearch(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeSearch()
              }
            }}
            placeholder="搜索终端输出"
            aria-label="搜索终端输出"
            spellCheck={false}
          />
          <span className="terminal-search-count" aria-live="polite">
            {searchCount}
          </span>
          <button type="button" onClick={() => runSearch(-1)} disabled={!hasMatches} title="上一个匹配（Shift+Enter）">
            上一个
          </button>
          <button type="button" onClick={() => runSearch(1)} disabled={!hasMatches} title="下一个匹配（Enter）">
            下一个
          </button>
          <button type="button" className="terminal-search-close" onClick={closeSearch} aria-label="关闭搜索">
            ×
          </button>
        </search>
      ) : null}

      {tabs.map((tab) => (
        <div
          key={`${tab.key}-${tab.epoch}`}
          className={terminalOpen && tab.key === activeTabKey ? 'terminal-host-wrap' : 'terminal-host-wrap hidden'}
        >
          <TerminalView
            projectId={projectId}
            relativePath={tab.relativePath}
            visible={terminalOpen && tab.key === activeTabKey}
            shell={settings.defaultShell.length > 0 ? settings.defaultShell : undefined}
            settings={settings}
            onSessionStateChange={(state) => onSessionStateChange(tab.key, state)}
            onSearchReady={(handle) => registerSearch(tab.key, handle)}
            onSearchResults={(results) => {
              if (tab.key === activeTabKey) setSearchResults(results)
            }}
            onShortcut={runShortcut}
            onFontSizeChange={(size) => onSettingsChange({ fontSize: size })}
            onLinkOpen={handleLinkOpen}
          />
        </div>
      ))}

      <footer className="terminal-statusbar">
        <span className={`session-dot ${activeTab?.status ?? 'idle'}`} aria-hidden="true" />
        <span className="terminal-status-state">
          {activeTab === null ? '无活动标签' : sessionStatusLabel(activeTab.status, activeTab.exitCode)}
        </span>
        {activeTab?.error !== null && activeTab?.error !== undefined ? (
          <span className="terminal-status-error" title={activeTab.error}>
            {activeTab.error}
          </span>
        ) : null}
        <span className="terminal-status-meta">
          Shell {shellDisplayName(activeTab?.shell ?? null, settings.defaultShell)}
        </span>
        <span className="terminal-status-meta">目录 {activeTab === null ? '—' : tabLabel(activeTab.relativePath)}</span>
        <span className="terminal-status-hint">Ctrl+Shift+F 搜索</span>
      </footer>

      {linkPrompt !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="terminal-link-title">
          <div className="modal" ref={linkDialogRef}>
            <h2 id="terminal-link-title">打开外部链接？</h2>
            <p className="terminal-link-url">{linkPrompt}</p>
            <p className="hint">链接将在系统浏览器中打开；终端不会执行链接中的任何命令。</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setLinkPrompt(null)}>
                取消
              </button>
              <button type="button" className="primary" onClick={confirmLink}>
                打开链接
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
