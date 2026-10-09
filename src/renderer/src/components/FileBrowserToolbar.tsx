import type { ContextMenuItem } from './ContextMenu'

/**
 * 文件栏工具栏：面包屑（当前选中项路径）+ 视图级操作与「新建」。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：纯受控组件。
 *
 * 设计约束（界面重构三项·阶段 3）：工具栏只留视图级操作与「新建」，
 * 针对某个条目的动作全部下沉到右键菜单（树行右键，或焦点行按 Shift+F10／Menu 键），
 * 避免十几枚按钮挤占一行。
 */

/** 面包屑的一段：显示名与可达的相对路径。 */
export interface BreadcrumbItem {
  name: string
  relativePath: string
}

interface FileBrowserToolbarProps {
  breadcrumb: BreadcrumbItem[]
  /** 当前选中条目；null 显示「未选择条目」提示 */
  selectedPath: string | null
  /** 当前目标目录（新建的落点）；空串表示项目根 */
  targetDirectory: string
  trusted: boolean
  /** 未信任时写操作的禁用说明；已信任为 undefined */
  writeTitle: string | undefined
  operationBusy: boolean
  /** 已展开的目录数量（「收起全部」的可用性依据） */
  expandedSize: number
  onSelectRoot: () => void
  onSelectCrumb: (relativePath: string) => void
  onCollapseAll: () => void
  onRefreshAll: () => void
  onCreateEntry: (kind: 'file' | 'directory', target: string) => void
  /** 打开「新建」分 split-button 菜单；位置由组件按锚点计算 */
  onOpenCreateMenu: (anchor: HTMLElement, items: ContextMenuItem[]) => void
}

export function FileBrowserToolbar({
  breadcrumb,
  selectedPath,
  targetDirectory,
  trusted,
  writeTitle,
  operationBusy,
  expandedSize,
  onSelectRoot,
  onSelectCrumb,
  onCollapseAll,
  onRefreshAll,
  onCreateEntry,
  onOpenCreateMenu
}: FileBrowserToolbarProps): React.JSX.Element {
  const whereLabel = targetDirectory.length === 0 ? '项目根' : targetDirectory

  return (
    <div className="browser-toolbar">
      <nav className="breadcrumb" aria-label="当前选中项路径">
        <button type="button" onClick={onSelectRoot}>
          项目根
        </button>
        {breadcrumb.map((crumb) => (
          <span key={crumb.relativePath}>
            <span className="sep">/</span>
            <button type="button" onClick={() => onSelectCrumb(crumb.relativePath)} title={crumb.relativePath}>
              {crumb.name}
            </button>
          </span>
        ))}
        {selectedPath === null ? <span className="hint">未选择条目</span> : null}
      </nav>
      {/*
        工具栏只留视图级操作与「新建」。针对某个条目的动作全部下沉到右键菜单
        （树行右键，或焦点行按 Shift+F10／Menu 键），避免十几枚按钮挤占一行。
      */}
      <div className="browser-actions">
        <button type="button" onClick={onCollapseAll} disabled={expandedSize === 0}>
          收起全部
        </button>
        <button type="button" onClick={onRefreshAll} disabled={operationBusy}>
          刷新
        </button>
        <div className="split-button">
          <button
            type="button"
            onClick={() => onCreateEntry('file', targetDirectory)}
            disabled={!trusted || operationBusy}
            title={trusted ? `在「${whereLabel}」中新建空文件` : '请先信任项目，才能执行文件操作'}
          >
            新建文件
          </button>
          <button
            type="button"
            className="split-caret"
            aria-haspopup="menu"
            aria-label="新建选项"
            title="选择新建文件或新建文件夹"
            onClick={(event) => {
              onOpenCreateMenu(event.currentTarget, [
                {
                  id: 'new-file',
                  label: '新建文件',
                  disabled: !trusted,
                  title: writeTitle ?? `在「${whereLabel}」中新建空文件`,
                  onSelect: () => onCreateEntry('file', targetDirectory)
                },
                {
                  id: 'new-directory',
                  label: '新建文件夹',
                  disabled: !trusted,
                  title: writeTitle ?? `在「${whereLabel}」中新建空文件夹`,
                  onSelect: () => onCreateEntry('directory', targetDirectory)
                }
              ])
            }}
          >
            ▾
          </button>
        </div>
      </div>
    </div>
  )
}
