import type { FileEntry, FileOperationBatchResult } from '@shared/types'
import { useCallback, useRef, useState } from 'react'
import type { ClipboardMode } from '../components/file-browser/menus'
import type { OperationNotice } from '../components/file-browser/utils'
import { operationReport } from '../components/file-browser/utils'

/**
 * 文件写操作（新建／重命名／复制／剪切粘贴／删除）、剪贴板与操作提示。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：
 * - 四类操作统一走 IPC 的逐项结果报告，不给统一成功提示；
 * - 删除只走系统回收站（语义在主进程 file-access），不可回收时整批停止并说明；
 * - 剪贴板刻意用 ref 而非 state：它没有任何渲染依赖，而「复制」与随后的右键
 *   菜单可能落在同一个事件批次里——ref 是同步更新的，菜单据此判断要不要给出
 *   「粘贴」才不会拿到上一次的旧状态。
 */

interface ClipboardState {
  mode: ClipboardMode
  paths: string[]
}

export function useFileOperations({
  projectId,
  trusted,
  selectedPathList,
  selectedEntryRef,
  clearSelection,
  keepFailedSelection,
  resetTree,
  refreshLoadedDirectories,
  revealEntry,
  onPathChange
}: {
  projectId: string
  trusted: boolean
  selectedPathList: () => string[]
  selectedEntryRef: React.RefObject<FileEntry | null>
  clearSelection: () => void
  keepFailedSelection: (result: FileOperationBatchResult) => void
  resetTree: () => void
  refreshLoadedDirectories: () => Promise<void>
  revealEntry: (relativePath: string, select: boolean) => Promise<unknown>
  onPathChange: (relativePath: string) => void
}): {
  operationBusy: boolean
  operationNotice: OperationNotice | null
  setOperationNotice: React.Dispatch<React.SetStateAction<OperationNotice | null>>
  clipboardRef: React.RefObject<ClipboardState | null>
  createNewEntry: (kind: 'file' | 'directory', target: string) => Promise<void>
  renameSelected: (entry: FileEntry) => Promise<void>
  setClipboardFromSelection: (mode: ClipboardMode) => void
  pasteClipboard: (target: string) => Promise<void>
  deleteSelected: () => Promise<void>
} {
  const [operationBusy, setOperationBusy] = useState(false)
  const [operationNotice, setOperationNotice] = useState<OperationNotice | null>(null)
  const clipboardRef = useRef<ClipboardState | null>(null)

  const firstSuccessfulTarget = useCallback((result: FileOperationBatchResult): string | null => {
    for (const item of result.items) {
      if (item.status === 'ok' && item.targetRelativePath !== undefined && item.targetRelativePath !== null) {
        return item.targetRelativePath
      }
    }
    return null
  }, [])

  const revealSuccessfulTarget = useCallback(
    async (result: FileOperationBatchResult) => {
      const target = firstSuccessfulTarget(result)
      if (target === null) return
      await refreshLoadedDirectories()
      await revealEntry(target, true)
      onPathChange(target)
    },
    [firstSuccessfulTarget, onPathChange, refreshLoadedDirectories, revealEntry]
  )

  /** 重命名单个条目。只接受「当前选择就是这一项」，多选时不执行。 */
  const renameSelected = useCallback(
    async (entry: FileEntry) => {
      const selection = selectedPathList()
      if (selection.length !== 1 || selection[0] !== entry.relativePath || operationBusy) return
      const nextName = window.prompt('将项目内条目重命名为：', entry.name)
      if (nextName === null) return

      setOperationBusy(true)
      setOperationNotice(null)
      try {
        const result = await window.workbench.file.rename({
          projectId,
          relativePath: entry.relativePath,
          newName: nextName
        })
        if (result.status !== 'ok' || result.targetRelativePath === null) {
          setOperationNotice({ tone: 'error', title: result.message, details: [] })
          return
        }

        setOperationNotice({ tone: 'success', title: result.message, details: [] })
        resetTree()
        selectedEntryRef.current = null
        clearSelection()
        onPathChange(result.targetRelativePath)
        await revealEntry(result.targetRelativePath, true)
      } catch (error) {
        setOperationNotice({
          tone: 'error',
          title: error instanceof Error ? error.message : String(error),
          details: []
        })
      } finally {
        setOperationBusy(false)
      }
    },
    [clearSelection, onPathChange, operationBusy, projectId, resetTree, revealEntry, selectedEntryRef, selectedPathList]
  )

  /** 新建空文件／空文件夹；`target` 由调用方给出（工具栏用当前目标目录，右键菜单用条目所在目录） */
  const createNewEntry = useCallback(
    async (kind: 'file' | 'directory', target: string) => {
      if (!trusted || operationBusy) return
      const label = kind === 'file' ? '文件' : '文件夹'
      const name = window.prompt(`在「${target.length === 0 ? '项目根' : target}」中新建${label}：`)
      if (name === null) return

      setOperationBusy(true)
      setOperationNotice(null)
      try {
        const result = await window.workbench.file.create({
          projectId,
          parentRelativePath: target,
          name,
          kind
        })
        setOperationNotice(operationReport(result, `新建${label}`))
        await revealSuccessfulTarget(result)
      } catch (error) {
        setOperationNotice({
          tone: 'error',
          title: error instanceof Error ? error.message : String(error),
          details: []
        })
      } finally {
        setOperationBusy(false)
      }
    },
    [operationBusy, projectId, revealSuccessfulTarget, trusted]
  )

  const setClipboardFromSelection = useCallback(
    (mode: ClipboardMode) => {
      const paths = selectedPathList()
      if (paths.length === 0 || !trusted) return
      clipboardRef.current = { mode, paths }
      setOperationNotice({
        tone: 'success',
        title: `${mode === 'copy' ? '已复制' : '已剪切'} ${paths.length} 项，选择目标目录后点击「粘贴」。`,
        details: []
      })
    },
    [selectedPathList, trusted]
  )

  /** 粘贴：`target` 由调用方显式给出（右键哪一行就粘到哪个目录） */
  const pasteClipboard = useCallback(
    async (target: string) => {
      const clipboard = clipboardRef.current
      if (clipboard === null || clipboard.paths.length === 0 || !trusted || operationBusy) return

      setOperationBusy(true)
      setOperationNotice(null)
      try {
        const result = await window.workbench.file.transfer({
          projectId,
          relativePaths: clipboard.paths,
          targetDirectory: target,
          mode: clipboard.mode
        })
        setOperationNotice(operationReport(result, clipboard.mode === 'copy' ? '复制粘贴' : '剪切粘贴'))
        if (clipboard.mode === 'move') {
          const remaining = result.items.filter((item) => item.status !== 'ok').map((item) => item.relativePath)
          clipboardRef.current = remaining.length === 0 ? null : { mode: 'move', paths: remaining }
        }
        if (result.ok > 0) await revealSuccessfulTarget(result)
      } catch (error) {
        setOperationNotice({
          tone: 'error',
          title: error instanceof Error ? error.message : String(error),
          details: []
        })
      } finally {
        setOperationBusy(false)
      }
    },
    [operationBusy, projectId, revealSuccessfulTarget, trusted]
  )

  /** 删除：一律进系统回收站，不可回收时整批停止并说明（语义见主进程 file-access） */
  const deleteSelected = useCallback(async () => {
    const paths = selectedPathList()
    if (paths.length === 0 || !trusted || operationBusy) return
    const previewPaths = paths
      .slice(0, 8)
      .map((path) => `• ${path}`)
      .join('\n')
    const suffix = paths.length > 8 ? `\n…以及另外 ${paths.length - 8} 项` : ''
    if (
      !window.confirm(
        `将所选 ${paths.length} 项发送到系统回收站？\n\n${previewPaths}${suffix}\n\n项目根与 .git 元数据不会被删除。`
      )
    ) {
      return
    }

    setOperationBusy(true)
    setOperationNotice(null)
    try {
      const result = await window.workbench.file.deleteToTrash({ projectId, relativePaths: paths })
      setOperationNotice(operationReport(result, '删除'))
      await refreshLoadedDirectories()
      keepFailedSelection(result)
    } catch (error) {
      setOperationNotice({
        tone: 'error',
        title: error instanceof Error ? error.message : String(error),
        details: []
      })
    } finally {
      setOperationBusy(false)
    }
  }, [keepFailedSelection, operationBusy, projectId, refreshLoadedDirectories, selectedPathList, trusted])

  return {
    operationBusy,
    operationNotice,
    setOperationNotice,
    clipboardRef,
    createNewEntry,
    renameSelected,
    setClipboardFromSelection,
    pasteClipboard,
    deleteSelected
  }
}
