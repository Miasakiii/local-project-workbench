import type { FileEntry } from '@shared/types'
import { formatBytes, formatTime, tooltipFor } from './file-browser/utils'
import { ChevronIcon, FileIcon, FolderIcon } from './icons'

/**
 * 文件树：目录以树形展开，子目录**按需加载**（展开时才列举，不做无边界预读）。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：纯受控展示组件——
 * 选中、展开、键盘光标全部由 props 传入，DOM 引用经 `onRowMount` 上报给
 * 父组件的键盘导航用；本组件不持有任何目录数据状态。
 *
 * 边界：Git 忽略的文件照常列出；目录读取失败、条目截断、不可用条目都在原位说明，
 * 不显示空白成功页。
 */

/** 树的一行：要么是条目，要么是原位提示（加载中／空目录／截断／错误）。 */
export type Row =
  | { kind: 'entry'; depth: number; entry: FileEntry }
  | { kind: 'note'; depth: number; text: string; tone: 'plain' | 'error' }

interface FileTreeProps {
  rows: Row[]
  /** 已展开的目录集合 */
  expanded: Set<string>
  /** 已选中的条目集合（多选） */
  selectedPaths: Set<string>
  /** 键盘导航的「焦点光标」；null 表示尚未进入树 */
  cursorPath: string | null
  /** 漫游 tabindex 的入口行（首个可见条目）；null 表示无可见条目 */
  firstFocusablePath: string | null
  /** 左侧树栏宽度（像素） */
  paneWidth: number
  onTreeKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  /** 右键空白处：开「当前目录」菜单（新建／粘贴／刷新） */
  onBlankContextMenu: React.MouseEventHandler<HTMLDivElement>
  /** 右键条目：先按需选中，再按光标位置开该条目的菜单 */
  onRowContextMenu: (entry: FileEntry, event: React.MouseEvent<HTMLDivElement>) => void
  onRowFocus: (relativePath: string) => void
  /** 树行 DOM 引用登记／注销，供键盘导航聚焦使用 */
  onRowMount: (relativePath: string, element: HTMLDivElement | null) => void
  onToggleDirectory: (relativePath: string) => void
  /** 行点击：与资源管理器一致——点击文件夹即展开／收起 */
  onLabelClick: (event: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) => void
}

export function FileTree({
  rows,
  expanded,
  selectedPaths,
  cursorPath,
  firstFocusablePath,
  paneWidth,
  onTreeKeyDown,
  onBlankContextMenu,
  onRowContextMenu,
  onRowFocus,
  onRowMount,
  onToggleDirectory,
  onLabelClick
}: FileTreeProps): React.JSX.Element {
  return (
    <div
      className="file-tree"
      role="tree"
      aria-multiselectable="true"
      onKeyDown={onTreeKeyDown}
      style={{ width: paneWidth }}
      // 右键空白处：开「当前目录」菜单（新建／粘贴／刷新）
      onContextMenu={onBlankContextMenu}
    >
      <div className="tree-head">
        <span className="col-name">名称</span>
        <span className="col-size">大小</span>
        <span className="col-time">修改时间</span>
      </div>

      {rows.map((row, index) => {
        if (row.kind === 'note') {
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 提示行由视图动态合成，同一目录下可能重复出现相同文案，索引参与复合键是唯一可靠选择
              key={`note-${index}`}
              className={row.tone === 'error' ? 'tree-note error' : 'tree-note'}
              style={{ paddingLeft: 50 + row.depth * 16 }}
            >
              {row.text}
            </div>
          )
        }

        const entry = row.entry
        const isExpanded = expanded.has(entry.relativePath)
        const isSelected = selectedPaths.has(entry.relativePath)

        return (
          <div
            key={entry.relativePath}
            ref={(element) => onRowMount(entry.relativePath, element)}
            className={isSelected ? 'tree-row selected' : 'tree-row'}
            style={{ paddingLeft: 4 + row.depth * 16 }}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={isSelected}
            aria-expanded={entry.kind === 'directory' ? isExpanded : undefined}
            tabIndex={(cursorPath ?? firstFocusablePath) === entry.relativePath ? 0 : -1}
            title={tooltipFor(entry)}
            onFocus={() => onRowFocus(entry.relativePath)}
            // 右键条目：先按需选中，再按光标位置开该条目的菜单
            onContextMenu={(event) => onRowContextMenu(entry, event)}
          >
            {entry.kind === 'directory' ? (
              <button
                type="button"
                className={isExpanded ? 'twisty expanded' : 'twisty'}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleDirectory(entry.relativePath)
                }}
                title={isExpanded ? '收起' : '展开'}
                aria-label={isExpanded ? '收起' : '展开'}
                tabIndex={-1}
              >
                <ChevronIcon className="chevron" />
              </button>
            ) : (
              <span className="twisty placeholder" />
            )}

            <button type="button" className="tree-label" tabIndex={-1} onClick={(event) => onLabelClick(event, entry)}>
              {entry.kind === 'directory' ? <FolderIcon className="glyph" /> : <FileIcon className="glyph" />}
              <span className="name">
                {entry.name}
                {entry.isLink ? <span className="chip chip-link">链接</span> : null}
              </span>
              <span className="size">{entry.kind === 'directory' ? '—' : formatBytes(entry.size)}</span>
              <span className="time">{formatTime(entry.modifiedAt)}</span>
            </button>
          </div>
        )
      })}

      {rows.length === 0 ? <div className="tree-note">正在读取目录…</div> : null}
    </div>
  )
}
