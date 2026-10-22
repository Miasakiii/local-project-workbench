import type { FileEntry, FilePreview } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 文件预览状态（设计稿 4.2，M1-4）。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：
 * - 预览仍只读；二进制、编码不支持、无权限分别说明；
 * - 外部保存后重载保留滚动位置（效果体只读 ref，`preview` 是刻意的触发依赖）；
 * - 「清空预览」与「关闭预览」分开：前者不重置滚动位置（批量操作后保持视野），
 *   后者是用户主动关闭，滚动位置一并归零。
 */

export function useFilePreview({ projectId }: { projectId: string }): {
  preview: FilePreview | null
  loadingPreview: boolean
  previewError: string | null
  /** 预览容器：用于在重载前后保持滚动位置 */
  previewHostRef: React.RefObject<HTMLDivElement | null>
  /** 预览滚动位置；watcher 重载前由调用方捕获、重载后写回 */
  previewScrollRef: React.RefObject<number>
  openPreview: (entry: FileEntry, preserveScroll?: boolean) => void
  /** 清空预览（不重置滚动位置） */
  clearPreview: () => void
  /** 关闭预览并重置滚动位置（用户主动关闭时用） */
  dismissPreview: () => void
} {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  /** 预览请求代次：只有最新一次请求的结果可以落到界面上 */
  const previewRequestRef = useRef(0)
  /** 预览容器：用于在重载前后保持滚动位置 */
  const previewHostRef = useRef<HTMLDivElement>(null)
  const previewScrollRef = useRef(0)

  const openPreview = useCallback(
    (entry: FileEntry, preserveScroll = false) => {
      if (!preserveScroll) previewScrollRef.current = 0
      previewRequestRef.current += 1
      const requestId = previewRequestRef.current
      setLoadingPreview(true)
      setPreviewError(null)
      void window.workbench.file
        .preview({ projectId, relativePath: entry.relativePath })
        .then((next) => {
          // 快速切换文件时，晚到的旧响应不能覆盖当前预览
          if (previewRequestRef.current !== requestId) return
          setPreview(next)
        })
        .catch((error: unknown) => {
          if (previewRequestRef.current !== requestId) return
          setPreview(null)
          setPreviewError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => {
          if (previewRequestRef.current === requestId) setLoadingPreview(false)
        })
    },
    [projectId]
  )

  const clearPreview = useCallback(() => {
    // 作废在途请求，避免清空后旧响应又把预览填回来
    previewRequestRef.current += 1
    setLoadingPreview(false)
    setPreview(null)
  }, [])

  const dismissPreview = useCallback(() => {
    previewRequestRef.current += 1
    setLoadingPreview(false)
    previewScrollRef.current = 0
    setPreview(null)
  }, [])

  // 预览更新后恢复滚动位置（外部保存后重载不应跳回顶部）
  // biome-ignore lint/correctness/useExhaustiveDependencies: preview 是刻意的触发依赖——效果体只读 ref，但必须在预览重载落定后重新写入滚动位置
  useEffect(() => {
    const body = previewHostRef.current?.querySelector('.preview-body')
    if (body === undefined || body === null) return
    body.scrollTop = previewScrollRef.current
  }, [preview])

  return {
    preview,
    loadingPreview,
    previewError,
    previewHostRef,
    previewScrollRef,
    openPreview,
    clearPreview,
    dismissPreview
  }
}
