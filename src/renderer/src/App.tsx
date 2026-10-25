import {
  DEFAULT_SIDEBAR_OPEN,
  LEGACY_SIDEBAR_PREFERENCE_KEY,
  parseLegacySidebarPreference
} from '@shared/sidebar-settings'
import {
  DEFAULT_TERMINAL_PREFERENCES,
  sanitizeTerminalPreferences,
  type TerminalPreferences
} from '@shared/terminal-settings'
import type { AppInfo, ProjectSummary } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppShell } from './components/AppShell'
import { ProjectSidebar } from './components/ProjectSidebar'
import { SessionDialogs } from './components/SessionDialogs'
import { useModalFocus } from './hooks/useModalFocus'
import { LibraryPage } from './pages/LibraryPage'
import { ProjectPage } from './pages/ProjectPage'
import { SettingsPage } from './pages/SettingsPage'

/**
 * 同时打开的项目数上限。
 *
 * 已打开的项目保持挂载（终端会话、文件监听、组件状态都保留），打开过多项目后
 * 内存与文件监听压力会累积。达到上限时自动关闭最久未活动、且没有终端会话在
 * 运行的项目——有会话在跑的项目不会被自动关闭，避免静默中断用户工作。
 */
const MAX_OPEN_PROJECTS = 8

/**
 * 应用入口。
 *
 * 布局：左侧项目侧边栏（应用级）+ 主区域（项目库或某个已打开的项目）+ 底部信息栏。
 *
 * 三个关键约定：
 * - **默认启动页为项目库首页**（C09）。「恢复上次项目」是可选开关，默认关闭；
 *   开启后由主进程判定能否恢复，恢复不了就在项目库说明原因（见 `bootstrap`）。
 * - **恢复的是位置，不是进程**：终端会话不跨启动保留。
 * - **已打开的项目保持挂载**（仅切换可见性），因此切换项目不会终止该项目的终端会话
 *   （设计稿 6.1）。关闭项目才会卸载它并结束其会话。
 */
export default function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [registerBusy, setRegisterBusy] = useState(false)
  const [fatalError, setFatalError] = useState<string | null>(null)

  /** 已打开（保持挂载）的项目，顺序即打开顺序 */
  const [openProjectIds, setOpenProjectIds] = useState<string[]>([])
  /** 当前正在查看的项目；null 表示停留在项目库 */
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  /** 项目最近一次被激活的顺序号：打开上限驱逐时据此找「最久未活动」的项目 */
  const activationOrderRef = useRef(new Map<string, number>())
  const activationTickRef = useRef(0)
  /** 侧栏开合偏好（P2-7 迁入应用设置）；启动时以主进程落盘值为准，落盘前按默认展开渲染 */
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(DEFAULT_SIDEBAR_OPEN)
  /** 开合值的同步镜像：连续快速点击时据此计算下一个状态，不依赖可能过期的闭包 */
  const sidebarOpenRef = useRef(DEFAULT_SIDEBAR_OPEN)
  /** 待确认关闭的项目：该项目有终端会话在运行 */
  const [pendingCloseProjectId, setPendingCloseProjectId] = useState<string | null>(null)
  /** 哪些项目有终端会话正在运行；用于在侧边栏上给出提示 */
  const [runningProjects, setRunningProjects] = useState<Record<string, boolean>>({})
  /** 待确认退出：主进程在退出前发现有活动会话 */
  const [pendingQuit, setPendingQuit] = useState<number | null>(null)

  /** 「恢复上次项目」开关（应用级偏好，默认关闭，C09） */
  const [restoreLastProject, setRestoreLastProject] = useState(false)
  /** 「用指定编辑器打开」所用的编辑器路径；null=未设置（G3b） */
  const [editorPath, setEditorPath] = useState<string | null>(null)
  /** 终端偏好（P4）：设置页与终端面板共用；外观即时生效，Shell／目录只影响新会话 */
  const [terminalSettings, setTerminalSettings] = useState<TerminalPreferences>(DEFAULT_TERMINAL_PREFERENCES)
  const terminalSettingsRef = useRef<TerminalPreferences>(DEFAULT_TERMINAL_PREFERENCES)
  /** 字号滚轮等连续操作会高频触发，落盘做 300ms 合并；退出确认前强制冲刷 */
  const terminalSaveTimerRef = useRef<number | null>(null)
  /** 设置页是否为当前主区域视图；打开项目仍保持挂载，设置与项目可随时来回切换 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { dialogRef: closeDialogRef } = useModalFocus(pendingCloseProjectId !== null, () =>
    setPendingCloseProjectId(null)
  )
  const { dialogRef: quitDialogRef } = useModalFocus(pendingQuit !== null, () => setPendingQuit(null))
  /** 开关已开启但没能恢复时的说明；打开任一项目后消失 */
  const [startupNotice, setStartupNotice] = useState<string | null>(null)
  /** 启动位置只在首次加载时应用一次 */
  const bootstrapped = useRef(false)

  const refresh = useCallback(async (): Promise<ProjectSummary[]> => {
    setLoading(true)
    try {
      const list = await window.workbench.project.list()
      setProjects(list)
      setFatalError(null)
      return list
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error))
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  // 只有活动项目被监听（设计稿 5.3）；回到项目库即停止监听
  useEffect(() => {
    void window.workbench.watcher.setActive({ projectId: activeProjectId })
  }, [activeProjectId])

  // 退出询问：主进程已阻止退出，这里负责让用户明确选择（设计稿 6.1）。
  // 会话仍在运行，取消后应用继续可用，不产生任何副作用。
  useEffect(() => {
    return window.workbench.app.onQuitRequested((payload) => {
      setPendingQuit(payload.sessionCount)
    })
  }, [])

  // 项目被移除登记后，同步从「已打开」集合中清掉，避免留下悬空引用
  useEffect(() => {
    const known = new Set(projects.map((project) => project.id))
    setOpenProjectIds((current) => {
      const next = current.filter((id) => known.has(id))
      return next.length === current.length ? current : next
    })
    setActiveProjectId((current) => (current !== null && !known.has(current) ? null : current))
  }, [projects])

  const activateProject = useCallback(
    async (projectId: string) => {
      setStartupNotice(null)
      activationTickRef.current += 1
      activationOrderRef.current.set(projectId, activationTickRef.current)
      setOpenProjectIds((current) => {
        if (current.includes(projectId)) return current
        // 达到上限时，自动关闭最久未活动且没有终端会话在运行的项目。
        // 有会话在跑的项目不会被自动关闭——避免静默中断用户工作。
        if (current.length >= MAX_OPEN_PROJECTS) {
          const evictable = current.filter((id) => runningProjects[id] !== true)
          if (evictable.length > 0) {
            let toEvict = evictable[0] as string
            let oldestOrder = activationOrderRef.current.get(toEvict) ?? 0
            for (const id of evictable.slice(1)) {
              const order = activationOrderRef.current.get(id) ?? 0
              if (order < oldestOrder) {
                oldestOrder = order
                toEvict = id
              }
            }
            return [...current.filter((id) => id !== toEvict), projectId]
          }
          // 全部有会话在运行：不驱逐，允许临时超出上限
          return [...current, projectId]
        }
        return [...current, projectId]
      })
      setActiveProjectId(projectId)
      const updated = await window.workbench.project.open({ projectId })
      if (updated !== null) {
        setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)))
      }
    },
    [runningProjects]
  )

  /**
   * 首帧加载：列表 + 启动位置。
   *
   * 恢复与否由主进程判定（它才掌握登记表与磁盘现状），这里只照做：
   * 要打开哪个项目就直接打开，打不开时把原因显示出来，不静默停在项目库。
   */
  const bootstrap = useCallback(async () => {
    void window.workbench.app
      .getInfo()
      .then(setInfo)
      .catch(() => setInfo(null))

    const list = await refresh()
    if (bootstrapped.current) return
    bootstrapped.current = true

    // P2-7：旧 localStorage 键一次性迁入应用设置——先经设置通道写入，成功后才清除该键，
    // 失败则保留键留待下次启动重试；键不存在时不产生任何读写。
    try {
      const legacy = window.localStorage.getItem(LEGACY_SIDEBAR_PREFERENCE_KEY)
      const migrated = parseLegacySidebarPreference(legacy)
      if (migrated !== null) {
        await window.workbench.settings.update({ sidebarOpen: migrated })
        window.localStorage.removeItem(LEGACY_SIDEBAR_PREFERENCE_KEY)
      }
    } catch {
      // 迁移失败不阻断启动：界面回落到设置里的当前值，键保留、下次启动重试
    }

    const view = await window.workbench.app.startupView()
    setRestoreLastProject(view.restoreLastProject)
    setEditorPath(view.editorPath)
    setTerminalSettings(view.terminal)
    terminalSettingsRef.current = view.terminal
    sidebarOpenRef.current = view.sidebarOpen
    setSidebarOpen(view.sidebarOpen)
    const target = view.projectId
    if (target !== null && list.some((project) => project.id === target)) {
      await activateProject(target)
      return
    }
    if (view.notice !== null) setStartupNotice(view.notice)
  }, [activateProject, refresh])

  useEffect(() => {
    // 取不到启动位置时停留项目库——这正是 C09 的默认行为，无需打扰用户
    bootstrap().catch(() => undefined)
  }, [bootstrap])

  /**
   * 「恢复上次项目」开关：立即提交，落盘值以主进程返回为准。
   */
  const updateSettings = useCallback(async (patch: { restoreLastProject?: boolean }) => {
    try {
      const saved = await window.workbench.settings.update(patch)
      setRestoreLastProject(saved.restoreLastProject)
    } catch (error) {
      // 偏好写不进去必须说出来：否则开关会在界面上「假生效」，下次启动又回到旧值
      setFatalError(`设置保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  /**
   * 终端偏好局部更新：先做与主进程同源的校验，立即反映到界面，再合并落盘。
   * 校验失败不会把非法值写进状态；主进程仍会独立复核一次。
   */
  const applyTerminalSettings = useCallback((patch: Partial<TerminalPreferences>) => {
    const next = sanitizeTerminalPreferences({ ...terminalSettingsRef.current, ...patch })
    terminalSettingsRef.current = next
    setTerminalSettings(next)
    if (terminalSaveTimerRef.current !== null) window.clearTimeout(terminalSaveTimerRef.current)
    terminalSaveTimerRef.current = window.setTimeout(() => {
      terminalSaveTimerRef.current = null
      void window.workbench.settings.update({ terminal: terminalSettingsRef.current }).catch((error: unknown) => {
        setFatalError(`终端设置保存失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }, 300)
  }, [])

  /** 退出确认前把尚在去抖窗口里的终端偏好落盘，避免最后一次调整丢失。 */
  const flushTerminalSettings = useCallback(async () => {
    if (terminalSaveTimerRef.current !== null) {
      window.clearTimeout(terminalSaveTimerRef.current)
      terminalSaveTimerRef.current = null
    }
    try {
      await window.workbench.settings.update({ terminal: terminalSettingsRef.current })
    } catch (error) {
      setFatalError(`终端设置保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  /** 打开主进程编辑器选择器并持久化；返回的即最新 editorPath（取消为 null=未设置） */
  const configureEditor = useCallback(async () => {
    try {
      setEditorPath(await window.workbench.system.setEditor())
    } catch (error) {
      setFatalError(`选择编辑器失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  /** 清空编辑器，回到未设置 */
  const clearEditor = useCallback(async () => {
    try {
      await window.workbench.system.clearEditor()
      setEditorPath(null)
    } catch (error) {
      setFatalError(`清空编辑器失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const closeProject = useCallback(
    (projectId: string) => {
      const remaining = openProjectIds.filter((id) => id !== projectId)
      setOpenProjectIds(remaining)
      setActiveProjectId((current) => {
        if (current !== projectId) return current
        return remaining.length > 0 ? (remaining[remaining.length - 1] ?? null) : null
      })
    },
    [openProjectIds]
  )

  /** 关闭项目：有活动会话时先提示，避免静默中断用户的工作（设计稿 6.1） */
  const requestCloseProject = useCallback(
    (projectId: string) => {
      if (runningProjects[projectId] === true) {
        setPendingCloseProjectId(projectId)
        return
      }
      closeProject(projectId)
    },
    [closeProject, runningProjects]
  )

  const register = useCallback(async () => {
    setRegisterBusy(true)
    try {
      const result = await window.workbench.project.register()
      if (result.status === 'unavailable') {
        setFatalError(result.message ?? '登记失败')
      } else if (result.status === 'existing') {
        setFatalError(result.message ?? '该目录已登记')
      }
      await refresh()
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error))
    } finally {
      setRegisterBusy(false)
    }
  }, [refresh])

  const handleProjectChange = useCallback((updated: ProjectSummary) => {
    setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)))
  }, [])

  /**
   * 侧栏开合：界面立即翻转并经设置通道持久化（P2-7）。
   * 写失败必须说出来，否则开关「假生效」、下次启动又回到旧值——与「恢复上次项目」同一约定。
   */
  const toggleSidebar = useCallback(() => {
    const next = !sidebarOpenRef.current
    sidebarOpenRef.current = next
    setSidebarOpen(next)
    void window.workbench.settings.update({ sidebarOpen: next }).catch((error: unknown) => {
      setFatalError(`设置保存失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }, [])

  /** 打开设置页：主区域切到设置，但已打开的项目保持挂载（终端会话不受影响） */
  const showSettings = useCallback(() => {
    setStartupNotice(null)
    setSettingsOpen(true)
  }, [])

  /** 离开设置页：回到项目库或上次查看的项目 */
  const leaveSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [])

  /** 终端会话状态由项目页上报；只在真正变化时更新，避免无谓重渲染 */
  const handleTerminalRunningChange = useCallback((projectId: string, running: boolean) => {
    setRunningProjects((current) => (current[projectId] === running ? current : { ...current, [projectId]: running }))
  }, [])

  const runningProjectIds = Object.keys(runningProjects).filter((id) => runningProjects[id] === true)
  const runningCount = runningProjectIds.length

  return (
    <AppShell
      fatalError={fatalError}
      startupNotice={startupNotice}
      info={info}
      openProjectCount={openProjectIds.length}
      runningCount={runningCount}
      onDismissFatalError={() => setFatalError(null)}
      sidebar={
        <ProjectSidebar
          open={sidebarOpen}
          projects={projects}
          activeProjectId={activeProjectId}
          openProjectIds={openProjectIds}
          runningProjectIds={runningProjectIds}
          settingsOpen={settingsOpen}
          onActivate={(projectId) => {
            leaveSettings()
            void activateProject(projectId)
          }}
          onClose={requestCloseProject}
          onShowLibrary={() => {
            leaveSettings()
            setActiveProjectId(null)
          }}
          onShowSettings={() => void showSettings()}
        />
      }
      dialogs={
        <SessionDialogs
          closeProjectName={
            pendingCloseProjectId === null
              ? null
              : (projects.find((item) => item.id === pendingCloseProjectId)?.displayName ?? '该项目')
          }
          pendingQuit={pendingQuit}
          closeDialogRef={closeDialogRef}
          quitDialogRef={quitDialogRef}
          onCancelClose={() => setPendingCloseProjectId(null)}
          onConfirmClose={() => {
            if (pendingCloseProjectId !== null) closeProject(pendingCloseProjectId)
            setPendingCloseProjectId(null)
          }}
          onCancelQuit={() => setPendingQuit(null)}
          onConfirmQuit={() => {
            setPendingQuit(null)
            void flushTerminalSettings().then(() => window.workbench.app.confirmQuit({ confirmed: true }))
          }}
        />
      }
    >
      {settingsOpen ? (
        <SettingsPage
          info={info}
          sidebarOpen={sidebarOpen}
          restoreLastProject={restoreLastProject}
          editorPath={editorPath}
          terminal={terminalSettings}
          onToggleSidebar={toggleSidebar}
          onSetRestoreLastProject={(enabled) => void updateSettings({ restoreLastProject: enabled })}
          onConfigureEditor={() => void configureEditor()}
          onClearEditor={() => void clearEditor()}
          onTerminalChange={applyTerminalSettings}
        />
      ) : null}

      {activeProjectId === null && !settingsOpen ? (
        <LibraryPage
          projects={projects}
          loading={loading}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          onRefresh={refresh}
          onOpenProject={(projectId) => void activateProject(projectId)}
          onRegister={register}
          registerBusy={registerBusy}
        />
      ) : null}

      {openProjectIds.map((projectId) => {
        const project = projects.find((item) => item.id === projectId)
        if (project === undefined) return null
        // 设置页是独立主区域视图：项目保持挂载但退出活动态，
        // 因此其快捷键不响应、终端面板也不与设置页同时可见。
        const isActive = !settingsOpen && projectId === activeProjectId
        return (
          <div key={projectId} className={isActive ? 'project-slot' : 'project-slot hidden'}>
            <ProjectPage
              project={project}
              active={isActive}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
              onBack={() => {
                leaveSettings()
                setActiveProjectId(null)
              }}
              onProjectChange={handleProjectChange}
              onTerminalRunningChange={handleTerminalRunningChange}
              terminalSettings={terminalSettings}
              onTerminalSettingsChange={applyTerminalSettings}
              editorPath={editorPath}
            />
          </div>
        )
      })}
    </AppShell>
  )
}
