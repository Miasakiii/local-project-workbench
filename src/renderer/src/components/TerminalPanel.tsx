import { useRef } from 'react'
import { ResizeHandle } from './ResizeHandle'
import { TerminalView } from './TerminalView'

export interface TerminalTab {
  key: number
  relativePath: string
  sessionId: string | null
  epoch: number
}

const MIN_PANEL_HEIGHT = 120
const PANEL_RESERVED_HEIGHT = 220

export function clampPanelHeight(value: number): number {
  const max = Math.max(MIN_PANEL_HEIGHT + 60, window.innerHeight - PANEL_RESERVED_HEIGHT)
  return Math.min(Math.max(Math.round(value), MIN_PANEL_HEIGHT), max)
}

interface TerminalPanelProps {
  projectId: string
  projectName: string
  defaultShell: string
  tabs: TerminalTab[]
  activeTabKey: number | null
  terminalOpen: boolean
  terminalMaximized: boolean
  panelHeight: number
  runningTabCount: number
  onPanelHeightChange: (height: number) => void
  onToggleMaximized: () => void
  onClosePanel: () => void
  onOpenTerminalAt: (relativePath: string) => void
  onRestartTab: (key: number) => void
  onEndActiveSession: () => void
  onSelectTab: (key: number) => void
  onCloseTab: (key: number) => void
  onSessionChange: (key: number, sessionId: string | null) => void
}

export function TerminalPanel({
  projectId,
  projectName,
  defaultShell,
  tabs,
  activeTabKey,
  terminalOpen,
  terminalMaximized,
  panelHeight,
  runningTabCount,
  onPanelHeightChange,
  onToggleMaximized,
  onClosePanel,
  onOpenTerminalAt,
  onRestartTab,
  onEndActiveSession,
  onSelectTab,
  onCloseTab,
  onSessionChange
}: TerminalPanelProps): React.JSX.Element {
  const panelHeightOriginRef = useRef(panelHeight)
  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? null

  return (
    <section
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
          ) : (
            <span className="badge">无活动会话</span>
          )}
        </div>
        <div className="terminal-actions">
          {activeTab !== null && activeTab.sessionId === null ? (
            <button type="button" onClick={() => onRestartTab(activeTab.key)} title="在当前标签内重新建立会话">
              重建会话
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onOpenTerminalAt('')}
            title="新建一个终端标签（每个标签一个独立会话）"
            aria-label="新建终端标签"
          >
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
          {activeTab !== null && activeTab.sessionId !== null ? (
            <button
              type="button"
              className="danger"
              onClick={onEndActiveSession}
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
          const label = tab.relativePath.length > 0 ? tab.relativePath : '项目根目录'
          return (
            <div key={tab.key} className={isActive ? 'terminal-tab active' : 'terminal-tab'}>
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="terminal-tab-label"
                onClick={() => onSelectTab(tab.key)}
                title={`启动目录：${label}\n${tab.sessionId !== null ? '会话运行中' : '无活动会话'}`}
              >
                <span className={tab.sessionId !== null ? 'tab-dot live' : 'tab-dot'} aria-hidden="true" />
                {label}
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                onClick={() => onCloseTab(tab.key)}
                title="关闭标签（会结束该会话）"
                aria-label={`关闭标签 ${label}`}
              >
                ×
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="terminal-tab-add"
          onClick={() => onOpenTerminalAt('')}
          title="新建标签"
          aria-label="新建标签"
        >
          +
        </button>
      </div>

      {tabs.map((tab) => (
        <div
          key={`${tab.key}-${tab.epoch}`}
          className={terminalOpen && tab.key === activeTabKey ? 'terminal-host-wrap' : 'terminal-host-wrap hidden'}
        >
          <TerminalView
            projectId={projectId}
            relativePath={tab.relativePath}
            visible={terminalOpen && tab.key === activeTabKey}
            shell={defaultShell}
            onSessionChange={(sessionId) => onSessionChange(tab.key, sessionId)}
          />
        </div>
      ))}
    </section>
  )
}
