import type { FileEntry } from '@shared/types'
import { useCallback, useMemo } from 'react'
import type { Row } from '../components/FileTree'
import { parentDirectoryOf } from '../components/file-browser/utils'

/**
 * 文件树的键盘导航（ARIA tree：漫游 tabindex + 方向键）。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：
 * - 可见条目行去掉提示行，顺序即视觉顺序，供 ↑/↓/Home/End 遍历；
 * - → 展开目录或移到第一个子项；← 先收起，文件与已收起目录跳到父目录；
 * - Enter／空格预览文件或展开目录；Shift+F10／Menu 键给焦点行开出同一套右键菜单；
 * - `rowRefs` 按相对路径索引 treeitem DOM，供聚焦与菜单定位使用。
 */

export function useTreeKeyboardNav({
  rows,
  cursorPath,
  setCursorPath,
  expanded,
  selectEntry,
  toggleDirectory,
  openPreview,
  openMenuForKeyboard,
  rowRefs
}: {
  rows: Row[]
  cursorPath: string | null
  setCursorPath: React.Dispatch<React.SetStateAction<string | null>>
  expanded: Set<string>
  selectEntry: (entry: FileEntry, additive: boolean) => void
  toggleDirectory: (relativePath: string) => void
  openPreview: (entry: FileEntry, preserveScroll?: boolean) => void
  openMenuForKeyboard: (entry: FileEntry) => void
  rowRefs: React.RefObject<Map<string, HTMLDivElement>>
}): {
  handleTreeKeyDown: React.KeyboardEventHandler<HTMLDivElement>
  /** 可见的条目行（去掉提示行），顺序即视觉顺序 */
  focusableRows: Extract<Row, { kind: 'entry' }>[]
} {
  /** 可见的条目行（去掉提示行），顺序即视觉顺序，供 ↑/↓/Home/End 遍历 */
  const focusableRows = useMemo(
    () => rows.filter((row): row is Extract<Row, { kind: 'entry' }> => row.kind === 'entry'),
    [rows]
  )

  const handleTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const list = focusableRows
      if (list.length === 0) return
      const currentIndex = cursorPath === null ? -1 : list.findIndex((row) => row.entry.relativePath === cursorPath)

      const focusRow = (index: number): void => {
        const row = list[Math.max(0, Math.min(index, list.length - 1))]
        if (row === undefined) return
        setCursorPath(row.entry.relativePath)
        selectEntry(row.entry, false)
        rowRefs.current.get(row.entry.relativePath)?.focus()
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          focusRow(currentIndex + 1)
          break
        case 'ArrowUp':
          event.preventDefault()
          focusRow(currentIndex - 1)
          break
        case 'Home':
          event.preventDefault()
          focusRow(0)
          break
        case 'End':
          event.preventDefault()
          focusRow(list.length - 1)
          break
        case 'ArrowRight': {
          if (cursorPath === null) {
            event.preventDefault()
            focusRow(0)
            return
          }
          const entry = list[currentIndex]?.entry
          if (entry === undefined) return
          event.preventDefault()
          if (entry.kind === 'directory' && !expanded.has(entry.relativePath)) {
            toggleDirectory(entry.relativePath) // 展开；子项按需异步加载，先保持焦点在本行
          } else if (entry.kind === 'directory') {
            focusRow(currentIndex + 1) // 已展开 → 移到第一个子项
          }
          break
        }
        case 'ArrowLeft': {
          if (cursorPath === null) return
          const entry = list[currentIndex]?.entry
          if (entry === undefined) return
          event.preventDefault()
          if (entry.kind === 'directory' && expanded.has(entry.relativePath)) {
            toggleDirectory(entry.relativePath) // 已展开 → 先收起
            return
          }
          // 文件或已收起的目录 → 跳到父目录
          const parent = parentDirectoryOf(entry.relativePath)
          const parentIndex = list.findIndex((row) => row.entry.relativePath === parent)
          if (parentIndex >= 0) {
            setCursorPath(parent)
            const parentEntry = list[parentIndex]?.entry
            if (parentEntry !== undefined) selectEntry(parentEntry, false)
            rowRefs.current.get(parent)?.focus()
          }
          break
        }
        case 'Enter':
        case ' ': {
          if (cursorPath === null) {
            event.preventDefault()
            focusRow(0)
            return
          }
          const entry = list[currentIndex]?.entry
          if (entry === undefined) return
          event.preventDefault()
          selectEntry(entry, false)
          if (entry.kind === 'directory') toggleDirectory(entry.relativePath)
          else openPreview(entry)
          break
        }
        case 'F10':
        case 'ContextMenu': {
          // Shift+F10／Menu 键是「右键」的键盘等价物：给焦点行开出同一套菜单。
          // 一律阻止默认——否则取不到条目时浏览器会把原生菜单弹出来。
          event.preventDefault()
          const entry = cursorPath === null ? undefined : list[currentIndex]?.entry
          if (entry === undefined) return
          openMenuForKeyboard(entry)
          break
        }
        default:
          break
      }
    },
    [
      cursorPath,
      focusableRows,
      openMenuForKeyboard,
      rowRefs,
      selectEntry,
      setCursorPath,
      toggleDirectory,
      expanded,
      openPreview
    ]
  )

  return { handleTreeKeyDown, focusableRows }
}
