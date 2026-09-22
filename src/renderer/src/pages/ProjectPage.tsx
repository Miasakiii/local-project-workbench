import type { GitSnapshot, ProjectPage as ProjectPageName, ProjectSummary, ProjectViewState } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChangesView } from '../components/ChangesView'
import { FileBrowser } from '../components/FileBrowser'
import { SidebarIcon } from '../components/icons'
import { OverviewView } from '../components/OverviewView'
import { ResizeHandle } from '../components/ResizeHandle'
import { TerminalView } from '../components/TerminalView'
import { useModalFocus } from '../hooks/useModalFocus'

interface ProjectPageProps {
  project: ProjectSummary
  /** 是否为当前正在查看的项目；隐藏的项目不应响应全局快捷键 */
  active: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onBack: () => void
  onProjectChange: (project: ProjectSummary) => void
  /** 上报终端会话状态，供侧边栏提示「哪个项目有终端在运行」 */
  onTerminalRunningChange: (projectId: string, running: boolean) => void
}

const NAV_ITEMS: Array<{ key: ProjectPageName; label: string; hint: string }> = [
  { key: 'overview', label: '概览', hint: 'README 与项目信息' },
  { key: 'files', label: '文件', hint: '浏览与只读预览' },
  { key: 'changes', label: '变更', hint: '只读 Git 状态' }
]

/** 一个终端标签对应一个独立会话 */
interface TerminalTab {
  key: number
  /** 启动目录（相对项目根）；空串表示项目根 */
  relativePath: string
  /** 主进程返回的会话 ID；null 表示尚未建立或已结束 */
  sessionId: string | null
  /** 重建会话时递增，用于强制重挂载终端组件 */
  epoch: number
}

const MIN_PANEL_HEIGHT = 120
const DEFAULT_PANEL_HEIGHT = 280
const DEFAULT_PANE_WIDTH = 380
/** 面板高度上限：始终给头部、导航与底部信息留出空间 */
const PANEL_RESERVED_HEIGHT = 220

function clampPanelHeight(value: number): number {
  const max = Math.max(MIN_PANEL_HEIGHT + 60, window.innerHeight - PANEL_RESERVED_HEIGHT)
  return Math.min(Math.max(Math.round(value), MIN_PANEL_HEIGHT), max)
}

/**
 * 项目首页框架（设计稿 2.2，M1-3）。
 *
 * 布局：头部（侧栏开关、返回、标题、**页面分段控件**、状态徽章）+ 内容区 +
 * 可完全收起的终端面板。
 *
 * 页面切换用头部的分段控件而非侧边导航：侧边栏已改为项目切换器，
 * 若页面导航也放在侧边栏里，收起侧边栏就会导致无法切换页面。
 *
 * 会话归属规则（设计稿 6.1）：
 * - 终端由用户明确点击创建；打开项目不自动执行任何命令。
 * - 切换页面、收起面板、**切换项目**都不终止会话——本组件在项目打开期间始终挂载。
 * - 面板上明确显示所属项目与启动目录。
 * - 首次创建终端前先确认项目信任。
 */
export function ProjectPage({
  project,
  active,
  sidebarOpen,
  onToggleSidebar,
  onBack,
  onProjectChange,
  onTerminalRunningChange
}: ProjectPageProps): React.JSX.Element {
  const [page, setPage] = useState<ProjectPageName>('overview')
  const [filePath, setFilePath] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT)
  const [filesPaneWidth, setFilesPaneWidth] = useState(DEFAULT_PANE_WIDTH)
  const [trustPrompt, setTrustPrompt] = useState(false)
  const { dialogRef: trustDialogRef } = useModalFocus(trustPrompt, () => setTrustPrompt(false))
  const [restored, setRestored] = useState(false)
  /** 文件变化信号带来的刷新令牌：递增即触发文件树与变更页重新读取 */
  const [changeToken, setChangeToken] = useState(0)

  /** 终端面板：未创建标签时不渲染，创建后由用户自由开关 */
  const [terminalOpen, setTerminalOpen] = useState(false)
  /** 多标签：每个标签一个独立会话，切换标签不终止其它会话（设计稿 6.1） */
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabKey, setActiveTabKey] = useState<number | null>(null)
  const tabKeyRef = useRef(1)
  /** 新建终端使用的 shell；空串=自动探测（G5） */
  const [selectedShell, setSelectedShell] = useState('')
  /** 头部 Git 状态（G6）：当前分支与变更文件数，只读查询 */
  const [gitSnapshot, setGitSnapshot] = useState<GitSnapshot | null>(null)
  const gitSequenceRef = useRef(0)

  const restoredRef = useRef(false)
  /** 拖拽起点的尺寸快照：拖拽过程中不能读 state，否则会累积误差 */
  const panelHeightOriginRef = useRef(DEFAULT_PANEL_HEIGHT)

  // 恢复视图状态（不恢复进程）
  useEffect(() => {
    restoredRef.current = false
    setRestored(false)
    void window.workbench.viewState.get({ projectId: project.id }).then((state: ProjectViewState | null) => {
      if (state !== null) {
        setPage(state.page)
        setFilePath(state.relativePath)
        setScrollTop(state.scrollTop)
        setPanelHeight(clampPanelHeight(state.terminalPanelHeight))
        setFilesPaneWidth(state.filesPaneWidth)
      }
      restoredRef.current = true
      setRestored(true)
    })
  }, [project.id])

  // 持久化视图状态（去抖）
  useEffect(() => {
    if (!restoredRef.current) return
    const timer = window.setTimeout(() => {
      void window.workbench.viewState.save({
        projectId: project.id,
        page,
        relativePath: filePath,
        scrollTop,
        terminalPanelHeight: panelHeight,
        filesPaneWidth
      })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [project.id, page, filePath, scrollTop, panelHeight, filesPaneWidth])

  // 侧边栏开关：Ctrl/Cmd+B 是同类应用的通用快捷键。仅在当前项目可见时响应，
  // 否则每个已打开的项目都会同时切换一次。
  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        onToggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [active, onToggleSidebar])

  // 订阅文件变化信号。监听只是刷新信号，事实以重新读取与 Git 查询为准。
  useEffect(() => {
    const off = window.workbench.watcher.onChanged((payload) => {
      if (payload.projectId !== project.id) return
      setChangeToken((value) => value + 1)
    })
    return off
  }, [project.id])

  // 头部 Git 状态（G6）：项目头显示当前分支与变更文件数。只读查询，
  // stale/error（无法判断）与「没有变化」严格区分，失败不计作 0 变更。
  const refreshHeaderSnapshot = useCallback(async () => {
    if (project.isGitRepository !== true) {
      setGitSnapshot(null)
      return
    }
    const sequence = ++gitSequenceRef.current
    try {
      const result = await window.workbench.git.snapshot({ projectId: project.id, sequence })
      if (sequence !== gitSequenceRef.current) return
      setGitSnapshot(result)
    } catch {
      // 头部态只作提示，具体错误由变更页呈现；这里保留上一个快照，不显示成 0 变更
    }
  }, [project.id, project.isGitRepository])

  // 切换项目时重置并重查
  useEffect(() => {
    setGitSnapshot(null)
    void refreshHeaderSnapshot()
  }, [refreshHeaderSnapshot])

  // 文件变化信号后刷新头部 Git 状态
  useEffect(() => {
    if (project.isGitRepository !== true) return
    if (changeToken === 0) return
    void refreshHeaderSnapshot()
  }, [changeToken, refreshHeaderSnapshot, project.isGitRepository])

  const runningTabCount = tabs.filter((tab) => tab.sessionId !== null).length
  const terminalMounted = tabs.length > 0
  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? null

  // 上报会话状态：侧边栏据此显示「终端运行中」
  useEffect(() => {
    onTerminalRunningChange(project.id, runningTabCount > 0)
  }, [onTerminalRunningChange, project.id, runningTabCount])

  const updateTab = useCallback((key: number, patch: Partial<TerminalTab>) => {
    setTabs((current) => current.map((tab) => (tab.key === key ? { ...tab, ...patch } : tab)))
  }, [])

  const addTab = useCallback((relativePath: string) => {
    const key = tabKeyRef.current
    tabKeyRef.current += 1
    setTabs((current) => [...current, { key, relativePath, sessionId: null, epoch: 0 }])
    setActiveTabKey(key)
    setTerminalOpen(true)
  }, [])

  const closeTab = useCallback((key: number) => {
    setTabs((current) => {
      const target = current.find((tab) => tab.key === key)
      if (target !== undefined && target.sessionId !== null) {
        void window.workbench.terminal.dispose(target.sessionId)
      }
      const next = current.filter((tab) => tab.key !== key)
      setActiveTabKey((active) => {
        if (active !== key) return active
        const fallback = next[next.length - 1]
        return fallback === undefined ? null : fallback.key
      })
      return next
    })
  }, [])

  /** 头部的「终端」按钮：无标签时先建一个，之后切换面板开关 */
  const toggleTerminal = useCallback(() => {
    if (tabs.length > 0) {
      setTerminalOpen((value) => !value)
      return
    }
    if (!project.trusted) {
      setTrustPrompt(true)
      return
    }
    addTab('')
  }, [addTab, project.trusted, tabs.length])

  const confirmTrust = useCallback(async () => {
    const updated = await window.workbench.project.update({ projectId: project.id, trusted: true })
    setTrustPrompt(false)
    if (updated !== null) onProjectChange(updated)
    addTab('')
  }, [addTab, onProjectChange, project.id])

  const toggleTrust = useCallback(async () => {
    const updated = await window.workbench.project.update({
      projectId: project.id,
      trusted: !project.trusted
    })
    if (updated !== null) onProjectChange(updated)
  }, [onProjectChange, project.id, project.trusted])

  /** 在指定目录新建标签。多标签已支持，不再需要替换现有会话。 */
  const openTerminalAt = useCallback(
    (relativePath: string) => {
      if (!project.trusted) {
        setTrustPrompt(true)
        return
      }
      addTab(relativePath)
    },
    [addTab, project.trusted]
  )

  /** 会话结束后在同一标签内重建（换一个 epoch 触发组件重挂载） */
  const restartTab = useCallback(
    (key: number) => {
      updateTab(key, { sessionId: null, epoch: (tabs.find((tab) => tab.key === key)?.epoch ?? 0) + 1 })
    },
    [tabs, updateTab]
  )

  const endActiveSession = useCallback(() => {
    if (activeTab === null || activeTab.sessionId === null) return
    void window.workbench.terminal.dispose(activeTab.sessionId)
    updateTab(activeTab.key, { sessionId: null })
  }, [activeTab, updateTab])

  const handleNavigateProjectPath = useCallback((relativePath: string) => {
    setFilePath(relativePath)
    setPage('files')
  }, [])

  const terminalStateLabel =
    tabs.length === 0 ? '未创建' : runningTabCount > 0 ? `${runningTabCount} 个会话运行中` : `${tabs.length} 个标签`

  return (
    <div className="project-page">
      <header className="project-header">
        <div className="project-identity">
          <button
            type="button"
            className={sidebarOpen ? 'icon-button active' : 'icon-button'}
            onClick={onToggleSidebar}
            title={sidebarOpen ? '收起项目侧边栏（Ctrl+B）' : '展开项目侧边栏（Ctrl+B）'}
            aria-label={sidebarOpen ? '收起项目侧边栏' : '展开项目侧边栏'}
            aria-expanded={sidebarOpen}
          >
            <SidebarIcon />
          </button>
          <button type="button" className="back" onClick={onBack}>
            ← 项目库
          </button>
          <div className="title-block">
            <h1 title={project.displayName}>{project.displayName}</h1>
            <p className="project-path" title={project.normalizedIdentity}>
              {project.normalizedIdentity}
            </p>
          </div>
        </div>

        <div className="segmented" role="tablist" aria-label="项目页面">
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.key}
              role="tab"
              aria-selected={page === item.key}
              className={page === item.key ? 'active' : undefined}
              onClick={() => setPage(item.key)}
              title={item.hint}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="project-badges">
          {project.isGitRepository === true ? <span className="chip chip-git">Git 仓库</span> : null}
          {project.isGitRepository === false ? <span className="chip">普通目录</span> : null}
          {project.isGitRepository === null ? <span className="chip chip-warn">Git 不可用</span> : null}
          {project.isGitRepository === true && gitSnapshot !== null ? (
            gitSnapshot.stale || gitSnapshot.error !== null ? (
              <span className="chip chip-warn" title={gitSnapshot.error ?? 'Git 状态查询失败或已过期'}>
                Git 状态不可用
              </span>
            ) : (
              <>
                <span
                  className="chip"
                  title={gitSnapshot.branch === null ? '尚无分支提交' : `当前分支：${gitSnapshot.branch}`}
                >
                  分支 {gitSnapshot.branch ?? '（无分支）'}
                </span>
                <span className="chip">
                  变更 {new Set(gitSnapshot.entries.map((entry) => entry.relativePath)).size}
                </span>
              </>
            )
          ) : null}
          <button
            type="button"
            className={project.trusted ? 'chip chip-trusted' : 'chip'}
            onClick={() => void toggleTrust()}
            title="不可信项目默认只读浏览；信任后才允许创建终端与删除等写操作"
          >
            {project.trusted ? '已信任（点击改为只读）' : '只读浏览（点击信任）'}
          </button>
          <button
            type="button"
            className={terminalOpen ? 'chip chip-active' : 'chip'}
            onClick={toggleTerminal}
            title={terminalOpen ? '收起终端面板（不结束会话）' : '打开终端面板'}
          >
            终端 · {terminalStateLabel}
          </button>
          <button type="button" onClick={() => void window.workbench.project.reveal({ projectId: project.id })}>
            在资源管理器中打开
          </button>
        </div>
      </header>

      {!project.available ? <p className="inline-error">{project.unavailableReason ?? '项目目录当前不可用'}</p> : null}

      <main className="project-content" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        {page === 'overview' ? (
          <OverviewView
            projectId={project.id}
            readmePath={project.readmePath}
            allowNetworkImages={project.allowNetworkImages}
            onReadmePathChange={async (next) => {
              const updated = await window.workbench.project.update({
                projectId: project.id,
                readmePath: next
              })
              if (updated !== null) onProjectChange(updated)
            }}
            onAllowNetworkImagesChange={async (next) => {
              const updated = await window.workbench.project.update({
                projectId: project.id,
                allowNetworkImages: next
              })
              if (updated !== null) onProjectChange(updated)
            }}
            onNavigateProjectPath={handleNavigateProjectPath}
          />
        ) : null}

        {page === 'files' && restored ? (
          <FileBrowser
            projectId={project.id}
            trusted={project.trusted}
            initialPath={filePath}
            paneWidth={filesPaneWidth}
            refreshToken={changeToken}
            onPaneWidthChange={setFilesPaneWidth}
            onPathChange={setFilePath}
            onNavigateProjectPath={handleNavigateProjectPath}
            onOpenTerminalAt={openTerminalAt}
          />
        ) : null}

        {page === 'changes' ? (
          <ChangesView projectId={project.id} isGitRepository={project.isGitRepository} refreshToken={changeToken} />
        ) : null}
      </main>

      {terminalMounted ? (
        <section
          className={terminalOpen ? 'terminal-panel' : 'terminal-panel closed'}
          style={terminalOpen ? { height: panelHeight } : undefined}
        >
          {/* 上边缘拖拽调整高度，不使用滑动条 */}
          <ResizeHandle
            axis="y"
            className="terminal-resize"
            ariaLabel="拖拽调整终端面板高度"
            onDragStart={() => {
              panelHeightOriginRef.current = panelHeight
            }}
            onDrag={(delta) => setPanelHeight(clampPanelHeight(panelHeightOriginRef.current - delta))}
            onDragEnd={() => {
              // 高度在拖拽过程中已实时更新，去抖保存会自动落盘
            }}
          />

          <header className="terminal-header">
            <div className="terminal-title">
              <strong>终端</strong>
              <span className="chip">{project.displayName}</span>
              {runningTabCount > 0 ? (
                <span className="badge badge-live">{runningTabCount} 个会话运行中</span>
              ) : (
                <span className="badge">无活动会话</span>
              )}
            </div>
            <div className="terminal-actions">
              {activeTab !== null && activeTab.sessionId === null ? (
                <button type="button" onClick={() => restartTab(activeTab.key)}>
                  重建会话
                </button>
              ) : null}
              <label className="terminal-shell" title="选择新建终端使用的 shell；缺省按本机自动探测">
                <span className="hint">Shell</span>
                <select value={selectedShell} onChange={(event) => setSelectedShell(event.target.value)}>
                  <option value="">自动</option>
                  <option value="pwsh">pwsh</option>
                  <option value="powershell">PowerShell</option>
                  <option value="cmd">cmd</option>
                </select>
              </label>
              <button type="button" onClick={() => openTerminalAt('')}>
                新建标签
              </button>
              <button type="button" onClick={() => setTerminalOpen(false)}>
                收起（不结束会话）
              </button>
              {activeTab !== null && activeTab.sessionId !== null ? (
                <button type="button" className="danger" onClick={endActiveSession}>
                  结束会话
                </button>
              ) : null}
            </div>
          </header>

          {/* 标签条：切换标签不终止其它会话 */}
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
                    onClick={() => setActiveTabKey(tab.key)}
                    title={`启动目录：${label}\n${tab.sessionId !== null ? '会话运行中' : '无活动会话'}`}
                  >
                    <span className={tab.sessionId !== null ? 'tab-dot live' : 'tab-dot'} aria-hidden="true" />
                    {label}
                  </button>
                  <button
                    type="button"
                    className="terminal-tab-close"
                    onClick={() => closeTab(tab.key)}
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
              onClick={() => openTerminalAt('')}
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
                projectId={project.id}
                relativePath={tab.relativePath}
                visible={terminalOpen && tab.key === activeTabKey}
                shell={selectedShell}
                onSessionChange={(sessionId) => updateTab(tab.key, { sessionId })}
              />
            </div>
          ))}
        </section>
      ) : null}

      {trustPrompt ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="trust-project-title">
          <div className="modal" ref={trustDialogRef}>
            <h2 id="trust-project-title">信任「{project.displayName}」？</h2>
            <p>终端具备当前用户的系统权限，可以读写该项目之外的任何位置。请只对你自己控制的目录开启。</p>
            <p className="hint">信任后：可在项目内创建终端、删除文件（发送到系统回收站）。不信任时项目为只读浏览。</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setTrustPrompt(false)}>
                取消
              </button>
              <button type="button" className="primary" onClick={() => void confirmTrust()}>
                信任并创建终端
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
