import type { ProjectSummary } from '@shared/types'
import { useCallback, useMemo, useState } from 'react'
import { SidebarIcon } from '../components/icons'

interface LibraryPageProps {
  projects: ProjectSummary[]
  loading: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onRefresh: () => Promise<void>
  onOpenProject: (projectId: string) => void
  onRegister: () => Promise<void>
  registerBusy: boolean
}

/**
 * 项目库首页（设计稿 2.1，M1-2）。
 *
 * 规则：
 * - 默认启动页即本页；「恢复上次项目」为可选开关（C09），但该开关尚未实现，
 *   因此启动后始终停留在本页。
 * - 卡片简介优先用户填写，其次 README 首段，最后回退路径。
 * - 目录不可用时卡片明确标注，仍可移除登记或重新定位。
 * - 移除登记**不删除磁盘文件**，确认框里明确说明。
 */
export function LibraryPage({
  projects,
  loading,
  sidebarOpen,
  onToggleSidebar,
  onRefresh,
  onOpenProject,
  onRegister,
  registerBusy
}: LibraryPageProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState<ProjectSummary | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (keyword.length === 0) return projects
    return projects.filter((project) => {
      return (
        project.displayName.toLowerCase().includes(keyword) ||
        project.normalizedIdentity.toLowerCase().includes(keyword) ||
        (project.description ?? '').toLowerCase().includes(keyword)
      )
    })
  }, [projects, query])

  const togglePinned = useCallback(
    async (project: ProjectSummary) => {
      await window.workbench.project.update({ projectId: project.id, pinned: !project.pinned })
      await onRefresh()
    },
    [onRefresh]
  )

  const confirmRemoval = useCallback(async () => {
    if (pendingRemoval === null) return
    const result = await window.workbench.project.remove({ projectId: pendingRemoval.id })
    setPendingRemoval(null)
    setNotice(result.message)
    await onRefresh()
  }, [pendingRemoval, onRefresh])

  return (
    <div className="library-page">
      <header className="library-header">
        <div className="library-title">
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
          <div className="title-block">
            <h1>项目库</h1>
            <p className="subtitle">
              共 {projects.length} 个项目
              {projects.some((project) => !project.available) ? ' · 有目录当前不可用' : ''}
            </p>
          </div>
        </div>
        <div className="library-actions">
          <input
            type="search"
            className="search"
            placeholder="按名称、路径或简介搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" onClick={() => void onRefresh()} disabled={loading}>
            刷新
          </button>
          <button type="button" className="primary" onClick={() => void onRegister()} disabled={registerBusy}>
            {registerBusy ? '正在登记…' : '登记新项目'}
          </button>
        </div>
      </header>

      {notice !== null ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: 提示条点击即关闭。改为可聚焦控件会引入新的焦点态，而当前环境无法人工确认视觉效果（见 P4）；键盘可达性一并在 M3 交互专项处理
        <p className="inline-notice" onClick={() => setNotice(null)}>
          {notice}
        </p>
      ) : null}

      {projects.length === 0 && !loading ? (
        <div className="empty-state">
          <h2>还没有登记任何项目</h2>
          <p>项目停留在原来的位置，不会被复制或上传。应用只记录它的位置，用于快速打开、阅读 README 与启动终端。</p>
          <div className="empty-actions">
            <button type="button" className="primary" onClick={() => void onRegister()} disabled={registerBusy}>
              登记第一个项目
            </button>
          </div>
          <p className="hint">普通文件夹即可登记，无需是 Git 仓库。</p>
        </div>
      ) : null}

      {projects.length > 0 && filtered.length === 0 ? (
        <div className="empty-state">
          <p>没有匹配「{query}」的项目。</p>
        </div>
      ) : null}

      <div className="project-grid">
        {filtered.map((project) => (
          <article key={project.id} className={project.available ? 'project-card' : 'project-card unavailable'}>
            <header>
              <div className="card-title">
                <h2 title={project.displayName}>{project.displayName}</h2>
                {project.pinned ? <span className="chip chip-pin">已置顶</span> : null}
              </div>
              <div className="card-badges">
                {project.isGitRepository === true ? <span className="chip chip-git">Git 仓库</span> : null}
                {project.isGitRepository === false ? <span className="chip">普通目录</span> : null}
                {project.isGitRepository === null ? <span className="chip chip-warn">Git 不可用</span> : null}
                {project.trusted ? (
                  <span className="chip chip-trusted">已信任</span>
                ) : (
                  <span className="chip">只读浏览</span>
                )}
              </div>
            </header>

            <p className="card-path" title={project.normalizedIdentity}>
              {project.normalizedIdentity}
            </p>

            <p className="card-description">
              {project.description ?? '暂无简介'}
              {project.descriptionSource === 'readme' ? <span className="hint">（取自 README）</span> : null}
              {project.descriptionSource === 'path' ? <span className="hint">（未提取到简介，显示路径）</span> : null}
            </p>

            {!project.available ? (
              <p className="inline-error">{project.unavailableReason ?? '目录当前不可用'}</p>
            ) : null}

            <footer>
              <span className="hint">
                最近打开 {new Date(project.lastOpenedAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
              <div className="card-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => onOpenProject(project.id)}
                  disabled={!project.available}
                >
                  打开
                </button>
                <button type="button" onClick={() => void togglePinned(project)}>
                  {project.pinned ? '取消置顶' : '置顶'}
                </button>
                <button
                  type="button"
                  onClick={() => void window.workbench.project.reveal({ projectId: project.id })}
                  disabled={!project.available}
                >
                  定位
                </button>
                <button type="button" className="danger" onClick={() => setPendingRemoval(project)}>
                  移除登记
                </button>
              </div>
            </footer>
          </article>
        ))}
      </div>

      {pendingRemoval !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>移除「{pendingRemoval.displayName}」的登记？</h2>
            <p>
              这只会删除应用中的记录。<strong>磁盘上的文件不会被删除、移动或修改。</strong>
            </p>
            <p className="hint">项目路径：{pendingRemoval.normalizedIdentity}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingRemoval(null)}>
                取消
              </button>
              <button type="button" className="danger" onClick={() => void confirmRemoval()}>
                仅移除登记
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
