import type { GitSnapshot, ProjectPage as ProjectPageName, ProjectSummary } from '@shared/types'
import { SidebarIcon, TerminalIcon } from './icons'

const NAV_ITEMS: Array<{ key: ProjectPageName; label: string; hint: string }> = [
  { key: 'overview', label: '概览', hint: 'README 与项目信息' },
  { key: 'files', label: '文件', hint: '浏览与只读预览' },
  { key: 'changes', label: '变更', hint: '只读 Git 状态' }
]

interface ProjectHeaderProps {
  project: ProjectSummary
  page: ProjectPageName
  gitSnapshot: GitSnapshot | null
  sidebarOpen: boolean
  terminalOpen: boolean
  terminalStateLabel: string
  runningTabCount: number
  tabCount: number
  onToggleSidebar: () => void
  onBack: () => void
  onPageChange: (page: ProjectPageName) => void
  onToggleTrust: () => void
  onToggleTerminal: () => void
  onReveal: () => void
}

export function ProjectHeader({
  project,
  page,
  gitSnapshot,
  sidebarOpen,
  terminalOpen,
  terminalStateLabel,
  runningTabCount,
  tabCount,
  onToggleSidebar,
  onBack,
  onPageChange,
  onToggleTrust,
  onToggleTerminal,
  onReveal
}: ProjectHeaderProps): React.JSX.Element {
  return (
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
            id={`seg-tab-${item.key}`}
            aria-selected={page === item.key}
            aria-controls="page-panel"
            className={page === item.key ? 'active' : undefined}
            onClick={() => onPageChange(item.key)}
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
              <span className="chip">变更 {new Set(gitSnapshot.entries.map((entry) => entry.relativePath)).size}</span>
            </>
          )
        ) : null}
        <button
          type="button"
          className={project.trusted ? 'chip chip-trusted' : 'chip'}
          onClick={onToggleTrust}
          title="不可信项目默认只读浏览；信任后才允许创建终端与删除等写操作"
        >
          {project.trusted ? '已信任（点击改为只读）' : '只读浏览（点击信任）'}
        </button>
        <button
          type="button"
          className={terminalOpen ? 'terminal-toggle active' : 'terminal-toggle'}
          onClick={onToggleTerminal}
          aria-pressed={terminalOpen}
          title={
            tabCount === 0
              ? project.trusted
                ? '新建终端会话（Ctrl+`）'
                : '创建终端前需要先信任该项目'
              : terminalOpen
                ? '收起终端面板（Ctrl+`，不结束会话）'
                : '展开终端面板（Ctrl+`）'
          }
        >
          <TerminalIcon />
          <span className="terminal-toggle-label">终端</span>
          <span className={runningTabCount > 0 ? 'terminal-badge live' : 'terminal-badge'}>{terminalStateLabel}</span>
        </button>
        <button type="button" onClick={onReveal}>
          在资源管理器中打开
        </button>
      </div>
    </header>
  )
}
