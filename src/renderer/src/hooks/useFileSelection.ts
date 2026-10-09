import type { FileEntry, FileOperationBatchResult } from '@shared/types'
import { useCallback, useRef, useState } from 'react'

/**
 * 文件栏的选择状态。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）。
 *
 * 关键设计：`selectedPathsRef` / `selectedEntryRef` 是 state 的**同步镜像**——
 * 右键菜单回调刻意读 ref 而非 state：菜单先选中条目、再开菜单，而 React 的状态
 * 更新是异步的，从 state 取目标会拿到选中前的旧值（通常是 null），表现为
 * 「右键后点删除没有反应」。
 *
 * `appliedRef` 保证视图状态恢复（initialPath）只应用一次。
 */

export function useFileSelection({
  onPathChange,
  openPreview,
  clearPreview,
  dismissPreview
}: {
  onPathChange: (relativePath: string) => void
  openPreview: (entry: FileEntry, preserveScroll?: boolean) => void
  clearPreview: () => void
  dismissPreview: () => void
}): {
  selectedPath: string | null
  selectedPaths: Set<string>
  selectedEntry: FileEntry | null
  cursorPath: string | null
  setCursorPath: React.Dispatch<React.SetStateAction<string | null>>
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>
  setSelectedPaths: React.Dispatch<React.SetStateAction<Set<string>>>
  setSelectedEntry: React.Dispatch<React.SetStateAction<FileEntry | null>>
  selectedPathsRef: React.RefObject<Set<string>>
  selectedEntryRef: React.RefObject<FileEntry | null>
  appliedRef: React.RefObject<string | null>
  selectEntry: (entry: FileEntry, additive: boolean) => void
  clearSelection: () => void
  /** 只清空当前条目（不含多选集合与键盘光标）；用户关闭预览时用 */
  clearEntry: () => void
  /** revealEntry 的选中部分：单选并记光标（不标记 initialPath 已应用） */
  applyRevealed: (entry: FileEntry) => void
  keepFailedSelection: (result: FileOperationBatchResult) => void
  /** 项目切换时的选择重置 */
  resetAll: () => void
  selectedPathList: () => string[]
} {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null)
  /** 键盘树导航的「焦点光标」；null 表示尚未进入树，此时首个可见行可被 Tab 聚焦 */
  const [cursorPath, setCursorPath] = useState<string | null>(null)

  const selectedPathsRef = useRef<Set<string>>(new Set())
  const selectedEntryRef = useRef<FileEntry | null>(null)
  const appliedRef = useRef<string | null>(null)

  const selectEntry = useCallback(
    (entry: FileEntry, additive: boolean) => {
      const current = selectedPathsRef.current
      const next = additive ? new Set(current) : new Set<string>()
      if (additive && next.has(entry.relativePath)) {
        next.delete(entry.relativePath)
      } else {
        next.add(entry.relativePath)
      }
      selectedPathsRef.current = next
      setSelectedPaths(next)

      if (!next.has(entry.relativePath)) {
        setSelectedPath(null)
        setSelectedEntry(null)
        selectedEntryRef.current = null
        clearPreview()
        onPathChange('')
        return
      }

      selectedEntryRef.current = entry
      setSelectedPath(entry.relativePath)
      setSelectedEntry(entry)
      setCursorPath(entry.relativePath)
      appliedRef.current = entry.relativePath
      onPathChange(entry.relativePath)
      if (entry.kind === 'file') openPreview(entry)
    },
    [clearPreview, onPathChange, openPreview]
  )

  const clearSelection = useCallback(() => {
    selectedPathsRef.current = new Set()
    setSelectedPaths(new Set())
    setSelectedPath(null)
    setSelectedEntry(null)
    selectedEntryRef.current = null
    dismissPreview()
    setCursorPath(null)
    onPathChange('')
  }, [dismissPreview, onPathChange])

  /** 只清空当前条目（不含多选集合与键盘光标）；用户关闭预览时用 */
  const clearEntry = useCallback(() => {
    selectedEntryRef.current = null
    setSelectedPath(null)
    setSelectedEntry(null)
  }, [])

  /** revealEntry 的选中部分：单选并记光标（不标记 initialPath 已应用） */
  const applyRevealed = useCallback((entry: FileEntry) => {
    const nextSelection = new Set([entry.relativePath])
    selectedPathsRef.current = nextSelection
    setSelectedPaths(nextSelection)
    selectedEntryRef.current = entry
    setSelectedPath(entry.relativePath)
    setSelectedEntry(entry)
    setCursorPath(entry.relativePath)
  }, [])

  const keepFailedSelection = useCallback(
    (result: FileOperationBatchResult) => {
      const remaining = result.items.filter((item) => item.status !== 'ok').map((item) => item.relativePath)
      if (remaining.length === 0) {
        clearSelection()
        return
      }
      const next = new Set(remaining)
      selectedPathsRef.current = next
      setSelectedPaths(next)
      setSelectedPath(remaining[0] ?? null)
      setSelectedEntry(null)
      selectedEntryRef.current = null
      clearPreview()
      onPathChange(remaining[0] ?? '')
    },
    [clearPreview, clearSelection, onPathChange]
  )

  /** 项目切换时的选择重置 */
  const resetAll = useCallback(() => {
    selectedPathsRef.current = new Set()
    setSelectedPaths(new Set())
    setSelectedPath(null)
    setSelectedEntry(null)
    selectedEntryRef.current = null
    setCursorPath(null)
    appliedRef.current = null
  }, [])

  const selectedPathList = useCallback((): string[] => [...selectedPathsRef.current], [])

  return {
    selectedPath,
    selectedPaths,
    selectedEntry,
    cursorPath,
    setCursorPath,
    setSelectedPath,
    setSelectedPaths,
    setSelectedEntry,
    selectedPathsRef,
    selectedEntryRef,
    appliedRef,
    selectEntry,
    clearSelection,
    clearEntry,
    applyRevealed,
    keepFailedSelection,
    resetAll,
    selectedPathList
  }
}
