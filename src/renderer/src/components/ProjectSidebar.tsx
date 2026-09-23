import type { ProjectSummary } from '@shared/types'
import { useMemo, useState } from 'react'
import { GearIcon } from './icons'

interface ProjectSidebarProps {
  open: boolean
  projects: ProjectSummary[]
  /** 当前正在查看的项目；null 表示停留在项目库 */
  activeProjectId: string | null
  /** 已打开（保持挂载）的项目，切换时不会丢失其终端会话 */
  openProjectIds: string[]
  /** 有终端会话正在运行的项目 */
  runningProjectIds: string[]
  /** 设置页是否为当前主区域视图；用于点亮左下角的「设置」入口 */
  settingsOpen: boolean
  onActivate: (projectId: string) => void
  onClose: (projectId: string) => void
  onShowLibrary: () => void
  onShowSettings: () => void
}

/** 项目数超过该值时显示筛选框，避免列表过长时找不到目标 */
const FILTER_THRESHOLD = 6

function tooltipFor(project: ProjectSummary, isOpen: boolean, isRunning: boolean): string {
  const lines = [project.displayName, project.normalizedIdentity]
  if (!project.available) lines.push(project.unavailableReason ?? '目录当前不可用')
  if (isRunning) lines.push('该项目的终端会话正在运行')
  lines.push(isOpen ? '已打开：切换不会中断该项目的终端会话' : '单击打开该项目')
  return lines.join('\n')
}

/**
 * 项目侧边栏（设计稿 2.1 / 6.1）。
 *
 * 职责是**切换项目**，不承担页面导航——页面切换由项目页头部的分段控件负责，
 * 这样收起侧边栏不会导致无法切换页面。
 *
 * 会话归属（设计稿 6.1）：已打开的项目保持挂载，切换项目**不终止**其终端进程；
 * 关闭项目会卸载它并结束其终端会话，因此关闭按钮上明确写出这一后果。
 *
 * 状态点含义：空心＝未打开，实心灰＝已打开但无会话，绿色脉冲＝终端会话运行中。
 * 运行中的终端必须一眼可见，否则用户不知道后台还有进程在跑。
 */
export function ProjectSidebar({
  open,
  projects,
  activeProjectId,
  openProjectIds,
  runningProjectIds,
  settingsOpen,
  onActivate,
  onClose,
  onShowLibrary,
  onShowSettings
}: ProjectSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (keyword.length === 0) return projects
    return projects.filter(
      (project) =>
        project.displayName.toLowerCase().includes(keyword) ||
        project.normalizedIdentity.toLowerCase().includes(keyword)
    )
  }, [projects, query])

  return (
    <aside className={open ? 'sidebar' : 'sidebar collapsed'} aria-hidden={!open} aria-label="项目列表">
      <div className="sidebar-head">
        <span className="sidebar-title">项目</span>
        <span className="chip">{projects.length}</span>
      </div>

      {runningProjectIds.length > 0 ? (
        <div className="sidebar-running" title="这些项目有终端会话正在运行">
          <span className="sidebar-summary-dot" aria-hidden="true" />
          <span>{runningProjectIds.length} 个终端运行中</span>
        </div>
      ) : null}

      {projects.length > FILTER_THRESHOLD ? (
        <div className="sidebar-filter">
          <input
            type="search"
            placeholder="筛选项目"
            aria-label="筛选项目"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            tabIndex={open ? 0 : -1}
          />
        </div>
      ) : null}

      <div className="sidebar-list">
        {filtered.map((project) => {
          const isActive = project.id === activeProjectId
          const isOpen = openProjectIds.includes(project.id)
          const isRunning = runningProjectIds.includes(project.id)
          const dotClass = isRunning ? 'sidebar-dot running' : isOpen ? 'sidebar-dot on' : 'sidebar-dot'
          return (
            <div key={project.id} className={isActive ? 'sidebar-item active' : 'sidebar-item'}>
              <button
                type="button"
                className="sidebar-item-main"
                onClick={() => onActivate(project.id)}
                title={tooltipFor(project, isOpen, isRunning)}
                tabIndex={open ? 0 : -1}
                aria-current={isActive}
              >
                <span className={dotClass} aria-hidden="true" />
                <span className="sidebar-item-name">{project.displayName}</span>
                {isRunning ? <span className="sidebar-mark live">终端</span> : null}
                {!project.available ? <span className="sidebar-mark">不可用</span> : null}
                {project.isGitRepository === true ? <span className="sidebar-mark">Git</span> : null}
              </button>
              {isOpen ? (
                <button
                  type="button"
                  className="sidebar-item-close"
                  onClick={() => onClose(project.id)}
                  title="关闭项目（会结束该项目的终端会话）"
                  aria-label={`关闭项目 ${project.displayName}`}
                  tabIndex={open ? 0 : -1}
                >
                  ×
                </button>
              ) : null}
            </div>
          )
        })}

        {projects.length === 0 ? <p className="sidebar-empty">还没有登记任何项目。可在项目库中登记。</p> : null}
        {projects.length > 0 && filtered.length === 0 ? (
          <p className="sidebar-empty">没有匹配「{query}」的项目。</p>
        ) : null}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={activeProjectId === null && !settingsOpen ? 'sidebar-library active' : 'sidebar-library'}
          onClick={onShowLibrary}
          tabIndex={open ? 0 : -1}
        >
          项目库
        </button>
        <button
          type="button"
          className={settingsOpen ? 'sidebar-settings active' : 'sidebar-settings'}
          onClick={onShowSettings}
          title="应用级设置：编辑器、终端默认 Shell、启动位置与关于"
          aria-label="打开设置"
          tabIndex={open ? 0 : -1}
        >
          <GearIcon className="gear" />
          设置
        </button>
      </div>
    </aside>
  )
}
