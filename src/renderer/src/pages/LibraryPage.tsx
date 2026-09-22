import type { ProjectSummary } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SidebarIcon } from '../components/icons'

interface LibraryPageProps {
  projects: ProjectSummary[]
  loading: boolean
  sidebarOpen: boolean
  /** 「恢复上次项目」开关（应用级偏好，C09） */
  restoreLastProject: boolean
  onToggleSidebar: () => void
  /** 刷新项目列表；返回最新列表供调用方直接使用，本组件不消费其结果 */
  onRefresh: () => Promise<unknown>
  onOpenProject: (projectId: string) => void
  onRegister: () => Promise<void>
  registerBusy: boolean
  onSetRestoreLastProject: (enabled: boolean) => void
}

/**
 * 项目库首页（设计稿 2.1，M1-2）。
 *
 * 规则：
 * - 默认启动页即本页；「恢复上次项目」为可选开关（C09），默认关闭。
 *   开关只改变启动时去哪里，不改变本页的任何其它行为。
 * - 卡片简介支持用户填写（`descriptionOverride`），其次 README 首段，最后回退路径。
 *   卡片「编辑简介」可填写自定义简介，清空保存即恢复自动提取（`project:update` 已支持）。
 * - 目录不可用时卡片明确标注，仍可移除登记或重新定位。
 * - 移除登记**不删除磁盘文件**，确认框里明确说明。
 */
export function LibraryPage({
  projects,
  loading,
  sidebarOpen,
  restoreLastProject,
  onToggleSidebar,
  onRefresh,
  onOpenProject,
  onRegister,
  registerBusy,
  onSetRestoreLastProject
}: LibraryPageProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pendingRemoval, setPendingRemoval] = useState<ProjectSummary | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [relocatingId, setRelocatingId] = useState<string | null>(null)
  const [editingDescription, setEditingDescription] = useState<ProjectSummary | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [descriptionBusy, setDescriptionBusy] = useState(false)
  const descriptionInputRef = useRef<HTMLTextAreaElement | null>(null)

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

  /**
   * 重新定位：目录可能被移动或重命名，用户可指向新位置。
   * 目录身份一旦变化，主进程会撤销信任，这里必须如实告知，不能只说「已更新」。
   */
  const relocate = useCallback(
    async (project: ProjectSummary) => {
      setRelocatingId(project.id)
      try {
        const result = await window.workbench.project.relocate({ projectId: project.id })
        setNotice(result.message)
        await onRefresh()
      } finally {
        setRelocatingId(null)
      }
    },
    [onRefresh]
  )

  /** 打开简介编辑：已有用户覆盖以其为初值，否则从空开始（清空=恢复自动的直观入口）。 */
  const openDescriptionEditor = useCallback((project: ProjectSummary) => {
    setDescriptionDraft(project.descriptionSource === 'user' ? (project.description ?? '') : '')
    setEditingDescription(project)
  }, [])

  /** 保存简介：trim 后为空 = 恢复自动提取，与主进程 descriptionOverride=null 语义一致。 */
  const saveDescription = useCallback(async () => {
    if (editingDescription === null) return
    setDescriptionBusy(true)
    try {
      const trimmed = descriptionDraft.trim()
      await window.workbench.project.update({
        projectId: editingDescription.id,
        descriptionOverride: trimmed.length === 0 ? null : trimmed
      })
      setEditingDescription(null)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setDescriptionBusy(false)
    }
  }, [editingDescription, descriptionDraft, onRefresh])

  /** 一键恢复自动提取。 */
  const restoreDescription = useCallback(async () => {
    if (editingDescription === null) return
    setDescriptionBusy(true)
    try {
      await window.workbench.project.update({
        projectId: editingDescription.id,
        descriptionOverride: null
      })
      setEditingDescription(null)
      await onRefresh()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setDescriptionBusy(false)
    }
  }, [editingDescription, onRefresh])

  // 打开弹窗时聚焦输入框（可访问性：显式 focus，而非 autoFocus 属性）
  useEffect(() => {
    if (editingDescription !== null) descriptionInputRef.current?.focus()
  }, [editingDescription])

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
          <label
            className="pref-toggle"
            title="开启后启动直接进入上次活跃的项目；目录不可用或已移除登记时停留在项目库并说明原因。默认关闭。"
          >
            <input
              type="checkbox"
              checked={restoreLastProject}
              onChange={(event) => onSetRestoreLastProject(event.target.checked)}
            />
            <span>启动时恢复上次项目</span>
          </label>
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
              {project.descriptionSource === 'user' ? <span className="hint">（自定义）</span> : null}
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
                <button
                  type="button"
                  onClick={() => openDescriptionEditor(project)}
                  title="填写或修改卡片简介；清空保存即恢复自动提取"
                >
                  编辑简介
                </button>
                <button type="button" onClick={() => void togglePinned(project)}>
                  {project.pinned ? '取消置顶' : '置顶'}
                </button>
                <button
                  type="button"
                  onClick={() => void window.workbench.project.reveal({ projectId: project.id })}
                  disabled={!project.available}
                  title="在系统资源管理器中打开该目录"
                >
                  定位
                </button>
                <button
                  type="button"
                  onClick={() => void relocate(project)}
                  disabled={relocatingId === project.id}
                  title={
                    project.available
                      ? '把这条登记指向另一个目录；目录变化后会撤销信任'
                      : '目录已不可用，选择它的新位置以恢复这条登记'
                  }
                >
                  {relocatingId === project.id ? '正在重新定位…' : '重新定位'}
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

      {editingDescription !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>编辑「{editingDescription.displayName}」的简介</h2>
            <label className="field">
              <span>简介</span>
              <textarea
                value={descriptionDraft}
                onChange={(event) => setDescriptionDraft(event.target.value)}
                ref={descriptionInputRef}
                rows={3}
                maxLength={200}
                placeholder="显示在项目卡片上；清空保存即恢复自动提取"
              />
            </label>
            <p className="hint">优先展示你填写的内容；清空并保存则恢复自动提取（README 首段，取不到时显示路径）。</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditingDescription(null)} disabled={descriptionBusy}>
                取消
              </button>
              {editingDescription.descriptionSource === 'user' ? (
                <button
                  type="button"
                  onClick={() => void restoreDescription()}
                  disabled={descriptionBusy}
                  title="恢复为自动提取（README 首段或路径）"
                >
                  恢复自动
                </button>
              ) : null}
              <button
                type="button"
                className="primary"
                onClick={() => void saveDescription()}
                disabled={descriptionBusy}
              >
                {descriptionBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
