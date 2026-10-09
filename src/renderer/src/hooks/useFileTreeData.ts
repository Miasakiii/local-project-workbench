import type { FileListResult } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Row } from '../components/FileTree'

/**
 * 文件树数据（设计稿 4.2，M1-4）。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：
 * - 目录以树形展开，子目录**按需加载**（展开时才列举，不做无边界预读）；
 * - `generationRef` 作废在途响应：项目切换或批量刷新后，旧请求的返回被丢弃，
 *  避免陈旧数据覆盖新状态；
 * - `expandedRef` 是 `expanded` 的同步镜像：watcher 信号效果不依赖 `expanded`
 *  状态（否则拿到的是效果建立时的旧快照）。
 */

interface DirectoryState {
  status: 'loading' | 'ready' | 'error'
  result: FileListResult | null
  error: string | null
}

export function useFileTreeData({ projectId }: { projectId: string }): {
  dirs: Record<string, DirectoryState>
  expanded: Set<string>
  /** 展开后的扁平行列表（含提示行），顺序即视觉顺序 */
  rows: Row[]
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
  expandedRef: React.RefObject<Set<string>>
  loadDirectory: (relativePath: string) => Promise<FileListResult | null>
  toggleDirectory: (relativePath: string) => void
  collapseAll: () => void
  refreshAll: () => void
  refreshLoadedDirectories: () => Promise<void>
  /** 整树重置：作废在途响应并清空目录与展开状态（项目切换用） */
  resetAll: () => void
} {
  const [dirs, setDirs] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const generationRef = useRef(0)
  const expandedRef = useRef<Set<string>>(new Set())

  /** 加载一个目录并返回结果，便于调用方在同一流程内继续处理 */
  const loadDirectory = useCallback(
    async (relativePath: string): Promise<FileListResult | null> => {
      const generation = generationRef.current
      setDirs((current) => ({
        ...current,
        [relativePath]: {
          status: 'loading',
          result: current[relativePath]?.result ?? null,
          error: null
        }
      }))

      try {
        const result = await window.workbench.file.list({ projectId, relativePath })
        if (generation !== generationRef.current) return null
        setDirs((current) => ({
          ...current,
          [relativePath]: {
            status: result.error === null ? 'ready' : 'error',
            result,
            error: result.error
          }
        }))
        return result
      } catch (error) {
        if (generation !== generationRef.current) return null
        const message = error instanceof Error ? error.message : String(error)
        setDirs((current) => ({
          ...current,
          [relativePath]: { status: 'error', result: null, error: message }
        }))
        return null
      }
    },
    [projectId]
  )

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(relativePath)) {
          next.delete(relativePath)
        } else {
          next.add(relativePath)
          if (dirs[relativePath] === undefined) void loadDirectory(relativePath)
        }
        return next
      })
    },
    [dirs, loadDirectory]
  )

  const collapseAll = useCallback(() => {
    setExpanded(new Set())
  }, [])

  const refreshAll = useCallback(() => {
    void Promise.all(['', ...expanded].map((directory) => loadDirectory(directory)))
  }, [expanded, loadDirectory])

  const refreshLoadedDirectories = useCallback(async () => {
    generationRef.current += 1
    await Promise.all(['', ...expanded].map((directory) => loadDirectory(directory)))
  }, [expanded, loadDirectory])

  /** 整树重置：作废在途响应并清空目录与展开状态（项目切换用） */
  const resetAll = useCallback(() => {
    generationRef.current += 1
    setDirs({})
    setExpanded(new Set())
  }, [])

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  /* ---------- 展开为扁平行列表 ---------- */

  const rows = useMemo(() => {
    const output: Row[] = []
    const walk = (path: string, depth: number): void => {
      const state = dirs[path]
      if (state === undefined) return

      if (state.error !== null && state.result === null) {
        output.push({ kind: 'note', depth, text: state.error, tone: 'error' })
        return
      }
      const result = state.result
      if (result === null) {
        if (state.status === 'loading') output.push({ kind: 'note', depth, text: '正在读取…', tone: 'plain' })
        return
      }
      if (result.entries.length === 0) {
        output.push({ kind: 'note', depth, text: '空目录', tone: 'plain' })
        return
      }

      for (const entry of result.entries) {
        output.push({ kind: 'entry', depth, entry })
        if (entry.kind === 'directory' && expanded.has(entry.relativePath)) {
          walk(entry.relativePath, depth + 1)
        }
      }
      if (result.truncated) {
        output.push({ kind: 'note', depth, text: '条目超过 2000 个，已截断', tone: 'plain' })
      }
    }
    walk('', 0)
    return output
  }, [dirs, expanded])

  return {
    dirs,
    expanded,
    rows,
    setExpanded,
    expandedRef,
    loadDirectory,
    toggleDirectory,
    collapseAll,
    refreshAll,
    refreshLoadedDirectories,
    resetAll
  }
}
