import type { AppInfo, ProjectSummary } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectSidebar } from './components/ProjectSidebar'
import { useModalFocus } from './hooks/useModalFocus'
import { LibraryPage } from './pages/LibraryPage'
import { ProjectPage } from './pages/ProjectPage'
import { SettingsPage } from './pages/SettingsPage'

const SIDEBAR_PREFERENCE_KEY = 'workbench.sidebarOpen'

function readSidebarPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) !== 'false'
  } catch {
    return true
  }
}

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
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarPreference)
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
  /** 终端默认 Shell；空串=按本机自动探测（界面重构三项·阶段 2，设置页承载） */
  const [defaultShell, setDefaultShell] = useState('')
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

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(sidebarOpen))
    } catch {
      // 忽略：偏好写入失败不影响功能
    }
  }, [sidebarOpen])

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

  const activateProject = useCallback(async (projectId: string) => {
    setStartupNotice(null)
    setOpenProjectIds((current) => (current.includes(projectId) ? current : [...current, projectId]))
    setActiveProjectId(projectId)
    const updated = await window.workbench.project.open({ projectId })
    if (updated !== null) {
      setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)))
    }
  }, [])

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

    const view = await window.workbench.app.startupView()
    setRestoreLastProject(view.restoreLastProject)
    setEditorPath(view.editorPath)
    setDefaultShell(view.defaultShell)
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
   * 局部更新应用偏好：只提交动过的那一项，其余字段由主进程保持原值。
   * 落盘值以主进程返回为准（白名单与序列化都在主进程）。
   */
  const updateSettings = useCallback(async (patch: { restoreLastProject?: boolean; defaultShell?: string }) => {
    try {
      const saved = await window.workbench.settings.update(patch)
      setRestoreLastProject(saved.restoreLastProject)
      setDefaultShell(saved.defaultShell)
    } catch (error) {
      // 偏好写不进去必须说出来：否则开关会在界面上「假生效」，下次启动又回到旧值
      setFatalError(`设置保存失败：${error instanceof Error ? error.message : String(error)}`)
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

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((value) => !value)
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
    <div className="app">
      {fatalError !== null ? (
        <div className="inline-error banner banner-dismissible" role="alert">
          <span className="banner-text">{fatalError}</span>
          <button type="button" className="banner-dismiss" onClick={() => setFatalError(null)} aria-label="关闭提示">
            ×
          </button>
        </div>
      ) : null}

      {startupNotice !== null ? <p className="inline-notice banner">{startupNotice}</p> : null}

      <div className="app-body">
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

        <div className="app-main">
          {settingsOpen ? (
            <SettingsPage
              info={info}
              sidebarOpen={sidebarOpen}
              restoreLastProject={restoreLastProject}
              editorPath={editorPath}
              defaultShell={defaultShell}
              onToggleSidebar={toggleSidebar}
              onSetRestoreLastProject={(enabled) => void updateSettings({ restoreLastProject: enabled })}
              onConfigureEditor={() => void configureEditor()}
              onClearEditor={() => void clearEditor()}
              onDefaultShellChange={(shell) => void updateSettings({ defaultShell: shell })}
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
                  defaultShell={defaultShell}
                  editorPath={editorPath}
                />
              </div>
            )
          })}
        </div>
      </div>

      {pendingCloseProjectId !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="close-sessions-title">
          <div className="modal" ref={closeDialogRef}>
            <h2 id="close-sessions-title">
              「{projects.find((item) => item.id === pendingCloseProjectId)?.displayName ?? '该项目'}
              」的终端会话正在运行
            </h2>
            <p>关闭项目会结束该项目的终端会话，正在其中运行的命令会被中断。</p>
            <p className="hint">不承诺恢复原来的进程；重新打开项目后需要重新执行命令。</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingCloseProjectId(null)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  closeProject(pendingCloseProjectId)
                  setPendingCloseProjectId(null)
                }}
              >
                结束会话并关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingQuit !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="quit-sessions-title">
          <div className="modal" ref={quitDialogRef}>
            <h2 id="quit-sessions-title">还有 {pendingQuit} 个终端会话正在运行</h2>
            <p>退出应用会结束这些会话，正在其中运行的命令会被中断。</p>
            <p className="hint">不承诺恢复原来的进程；下次启动后需要重新执行命令。</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingQuit(null)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setPendingQuit(null)
                  void window.workbench.app.confirmQuit({ confirmed: true })
                }}
              >
                结束会话并退出
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <footer className="app-footer">
        <span>
          {info === null
            ? '本地项目工作台'
            : `Electron ${info.electronVersion} · Chromium ${info.chromeVersion} · Node ${info.nodeVersion}`}
        </span>
        <span className="hint">
          {openProjectIds.length > 0 ? `已打开 ${openProjectIds.length} 个项目 · ` : ''}
          {runningCount > 0 ? `${runningCount} 个终端运行中 · ` : ''}
          项目停留在原位置，不复制、不上传源码
        </span>
      </footer>
    </div>
  )
}
