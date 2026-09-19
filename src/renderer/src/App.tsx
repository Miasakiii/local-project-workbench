import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, ProjectSummary } from '@shared/types'
import { ProjectSidebar } from './components/ProjectSidebar'
import { LibraryPage } from './pages/LibraryPage'
import { ProjectPage } from './pages/ProjectPage'

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
 * 两个关键约定：
 * - **默认启动页为项目库首页**（C09）。「恢复上次项目」是可选开关，默认关闭，属 M2。
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

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(sidebarOpen))
    } catch {
      // 忽略：偏好写入失败不影响功能
    }
  }, [sidebarOpen])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.workbench.project.list()
      setProjects(list)
      setFatalError(null)
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void window.workbench.app
      .getInfo()
      .then(setInfo)
      .catch(() => setInfo(null))
    void refresh()
  }, [refresh])

  // 只有活动项目被监听（设计稿 5.3）；回到项目库即停止监听
  useEffect(() => {
    void window.workbench.watcher.setActive({ projectId: activeProjectId })
  }, [activeProjectId])

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
    setOpenProjectIds((current) => (current.includes(projectId) ? current : [...current, projectId]))
    setActiveProjectId(projectId)
    const updated = await window.workbench.project.open({ projectId })
    if (updated !== null) {
      setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)))
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

  /** 终端会话状态由项目页上报；只在真正变化时更新，避免无谓重渲染 */
  const handleTerminalRunningChange = useCallback((projectId: string, running: boolean) => {
    setRunningProjects((current) => (current[projectId] === running ? current : { ...current, [projectId]: running }))
  }, [])

  const runningProjectIds = Object.keys(runningProjects).filter((id) => runningProjects[id] === true)
  const runningCount = runningProjectIds.length

  return (
    <div className="app">
      {fatalError !== null ? (
        <p className="inline-error banner" onClick={() => setFatalError(null)}>
          {fatalError}（点击关闭）
        </p>
      ) : null}

      <div className="app-body">
        <ProjectSidebar
          open={sidebarOpen}
          projects={projects}
          activeProjectId={activeProjectId}
          openProjectIds={openProjectIds}
          runningProjectIds={runningProjectIds}
          onActivate={(projectId) => void activateProject(projectId)}
          onClose={requestCloseProject}
          onShowLibrary={() => setActiveProjectId(null)}
        />

        <div className="app-main">
          {activeProjectId === null ? (
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
            const isActive = projectId === activeProjectId
            return (
              <div key={projectId} className={isActive ? 'project-slot' : 'project-slot hidden'}>
                <ProjectPage
                  project={project}
                  active={isActive}
                  sidebarOpen={sidebarOpen}
                  onToggleSidebar={toggleSidebar}
                  onBack={() => setActiveProjectId(null)}
                  onProjectChange={handleProjectChange}
                  onTerminalRunningChange={handleTerminalRunningChange}
                />
              </div>
            )
          })}
        </div>
      </div>

      {pendingCloseProjectId !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>「{projects.find((item) => item.id === pendingCloseProjectId)?.displayName ?? '该项目'}」的终端会话正在运行</h2>
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
