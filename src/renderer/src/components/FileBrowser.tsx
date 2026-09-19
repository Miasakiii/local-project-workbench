import type { FileEntry, FileListResult, FilePreview } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronIcon, FileIcon, FolderIcon } from './icons'
import { PreviewPane } from './PreviewPane'
import { ResizeHandle } from './ResizeHandle'

interface FileBrowserProps {
  projectId: string
  /** 需要定位并选中的条目（来自视图状态恢复） */
  initialPath: string
  /** 左侧树栏宽度（像素） */
  paneWidth: number
  /** 文件变化信号带来的刷新令牌；递增即重新读取目录并重载当前预览 */
  refreshToken: number
  onPaneWidthChange: (value: number) => void
  onPathChange: (relativePath: string) => void
  onNavigateProjectPath: (relativePath: string) => void
  /** 在指定目录打开终端 */
  onOpenTerminalAt: (relativePath: string) => void
}

interface DirectoryState {
  status: 'loading' | 'ready' | 'error'
  result: FileListResult | null
  error: string | null
}

type Row =
  | { kind: 'entry'; depth: number; entry: FileEntry }
  | { kind: 'note'; depth: number; text: string; tone: 'plain' | 'error' }

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(iso: string): string {
  if (iso.startsWith('1970-01-01')) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 悬浮提示：优先显示完整名称，被省略号截断时尤其需要 */
function tooltipFor(entry: FileEntry): string {
  const lines = [entry.name]
  if (entry.relativePath !== entry.name) lines.push(entry.relativePath)
  if (entry.isLink) lines.push('符号链接或目录联接')
  lines.push(entry.kind === 'directory' ? '单击展开或收起' : '单击预览')
  return lines.join('\n')
}

/** 拆分路径，返回从根到父级的目录链（不含自身） */
function ancestorDirectories(relativePath: string): string[] {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  const trail: string[] = []
  let accumulated = ''
  for (let index = 0; index < segments.length - 1; index += 1) {
    accumulated = accumulated.length === 0 ? (segments[index] as string) : `${accumulated}/${segments[index]}`
    trail.push(accumulated)
  }
  return trail
}

/**
 * 文件树与只读预览（设计稿 4.2，M1-4）。
 *
 * 目录以树形展开，子目录**按需加载**（展开时才列举，不做无边界预读）。
 *
 * 边界：只读，没有新建／重命名／删除入口（属 M3）；Git 忽略的文件照常列出；
 * 目录读取失败、条目截断、不可用条目都在原位说明，不显示空白成功页。
 */
export function FileBrowser({
  projectId,
  initialPath,
  paneWidth,
  refreshToken,
  onPaneWidthChange,
  onPathChange,
  onNavigateProjectPath,
  onOpenTerminalAt
}: FileBrowserProps): React.JSX.Element {
  const [dirs, setDirs] = useState<Record<string, DirectoryState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const generationRef = useRef(0)
  const selectedEntryRef = useRef<FileEntry | null>(null)
  const expandedRef = useRef<Set<string>>(new Set())
  const appliedRef = useRef<string | null>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  /** 拖拽起点的宽度快照 */
  const paneWidthOriginRef = useRef(paneWidth)
  /** 预览容器：用于在重载前后保持滚动位置 */
  const previewHostRef = useRef<HTMLDivElement>(null)
  const previewScrollRef = useRef(0)

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

  const openPreview = useCallback(
    (entry: FileEntry, preserveScroll = false) => {
      if (!preserveScroll) previewScrollRef.current = 0
      setLoadingPreview(true)
      setPreviewError(null)
      void window.workbench.file
        .preview({ projectId, relativePath: entry.relativePath })
        .then(setPreview)
        .catch((error: unknown) => {
          setPreview(null)
          setPreviewError(error instanceof Error ? error.message : String(error))
        })
        .finally(() => setLoadingPreview(false))
    },
    [projectId]
  )

  /* ---------- 初始加载与视图状态恢复 ---------- */

  useEffect(() => {
    generationRef.current += 1
    setDirs({})
    setExpanded(new Set())
    setSelectedPath(null)
    setSelectedEntry(null)
    setPreview(null)
    appliedRef.current = null
    void loadDirectory('')
  }, [loadDirectory])

  /** 展开并选中某条目（含其祖先目录链） */
  const revealEntry = useCallback(
    async (relativePath: string, select: boolean) => {
      const ancestors = ancestorDirectories(relativePath)
      setExpanded((current) => {
        const next = new Set(current)
        for (const directory of ancestors) next.add(directory)
        return next
      })

      const chain = ['', ...ancestors]
      const results = await Promise.all(chain.map((directory) => loadDirectory(directory)))
      const parentResult = results[results.length - 1]
      const entry = parentResult?.entries.find((item) => item.relativePath === relativePath) ?? null
      if (entry === null || !select) return entry

      setSelectedPath(entry.relativePath)
      setSelectedEntry(entry)
      if (entry.kind === 'file') openPreview(entry)
      return entry
    },
    [loadDirectory, openPreview]
  )

  useEffect(() => {
    if (appliedRef.current === initialPath) return
    appliedRef.current = initialPath
    if (initialPath.length === 0) return
    void revealEntry(initialPath, true)
  }, [initialPath, revealEntry])

  // 预览更新后恢复滚动位置（外部保存后重载不应跳回顶部）
  // biome-ignore lint/correctness/useExhaustiveDependencies: preview 是刻意的触发依赖——效果体只读 ref，但必须在预览重载落定后重新写入滚动位置
  useEffect(() => {
    const body = previewHostRef.current?.querySelector('.preview-body')
    if (body === undefined || body === null) return
    body.scrollTop = previewScrollRef.current
  }, [preview])

  // 文件变化信号：重新读取已加载的目录，并在当前预览的文件被改动时重载预览
  useEffect(() => {
    if (refreshToken === 0) return
    const captured = previewScrollRef.current
    const current = selectedEntryRef.current

    void (async () => {
      await Promise.all(['', ...expandedRef.current].map((directory) => loadDirectory(directory)))
      if (current === null) return

      const body = previewHostRef.current?.querySelector('.preview-body')
      previewScrollRef.current = body?.scrollTop ?? captured
      openPreview(current, true)
    })()
  }, [loadDirectory, openPreview, refreshToken])

  /* ---------- 展开与收起 ---------- */

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

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])

  const collapseAll = useCallback(() => {
    setExpanded(new Set())
  }, [])

  const refreshAll = useCallback(() => {
    void Promise.all(['', ...expanded].map((directory) => loadDirectory(directory)))
  }, [expanded, loadDirectory])

  /* ---------- 选择 ---------- */

  const selectEntry = useCallback(
    (entry: FileEntry) => {
      selectedEntryRef.current = entry
      setSelectedPath(entry.relativePath)
      setSelectedEntry(entry)
      appliedRef.current = entry.relativePath
      onPathChange(entry.relativePath)
      if (entry.kind === 'file') openPreview(entry)
    },
    [onPathChange, openPreview]
  )

  /**
   * 行点击：与资源管理器一致——点击文件夹即展开／收起，不需要瞄准箭头。
   *
   * `event.detail > 1` 是双击产生的第二次点击，直接忽略：
   * 否则一次双击会「展开又收起」，视觉上等于没有反应。
   */
  const handleRowClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, entry: FileEntry) => {
      if (event.detail > 1) return
      selectEntry(entry)
      if (entry.kind === 'directory') toggleDirectory(entry.relativePath)
    },
    [selectEntry, toggleDirectory]
  )

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

  /* ---------- 面包屑：定位到当前选中项 ---------- */

  const breadcrumb = useMemo(() => {
    if (selectedPath === null) return []
    const segments = selectedPath.split('/').filter((segment) => segment.length > 0)
    const trail: Array<{ name: string; relativePath: string }> = []
    let accumulated = ''
    for (const segment of segments) {
      accumulated = accumulated.length === 0 ? segment : `${accumulated}/${segment}`
      trail.push({ name: segment, relativePath: accumulated })
    }
    return trail
  }, [selectedPath])

  /* ---------- 工具栏动作 ---------- */

  const openExternally = useCallback(async () => {
    if (selectedEntry === null) return
    await window.workbench.system.openPath({ projectId, relativePath: selectedEntry.relativePath })
  }, [projectId, selectedEntry])

  const revealInSystem = useCallback(async () => {
    if (selectedEntry === null) return
    await window.workbench.system.showInFolder({ projectId, relativePath: selectedEntry.relativePath })
  }, [projectId, selectedEntry])

  const terminalDirectory = selectedEntry?.kind === 'directory' ? selectedEntry.relativePath : ''

  /** 拖拽分栏时限制范围：右侧预览区始终保留可用宽度 */
  const clampPaneWidth = useCallback((value: number): number => {
    const container = splitRef.current
    const available = container === null ? 900 : container.clientWidth
    const max = Math.max(280, available - 300)
    return Math.min(Math.max(Math.round(value), 220), max)
  }, [])

  return (
    <div className="file-browser">
      <div className="browser-toolbar">
        <nav className="breadcrumb" aria-label="当前选中项路径">
          <button
            type="button"
            onClick={() => {
              appliedRef.current = ''
              setSelectedPath(null)
              setSelectedEntry(null)
              setPreview(null)
              onPathChange('')
            }}
          >
            项目根
          </button>
          {breadcrumb.map((crumb) => (
            <span key={crumb.relativePath}>
              <span className="sep">/</span>
              <button
                type="button"
                onClick={() => void revealEntry(crumb.relativePath, true)}
                title={crumb.relativePath}
              >
                {crumb.name}
              </button>
            </span>
          ))}
          {selectedPath === null ? <span className="hint">未选择条目</span> : null}
        </nav>
        <div className="browser-actions">
          <button type="button" onClick={collapseAll} disabled={expanded.size === 0}>
            收起全部
          </button>
          <button type="button" onClick={refreshAll}>
            刷新
          </button>
          <button type="button" onClick={() => void openExternally()} disabled={selectedEntry === null}>
            用默认程序打开
          </button>
          <button type="button" onClick={() => void revealInSystem()} disabled={selectedEntry === null}>
            在资源管理器中定位
          </button>
          <button type="button" onClick={() => onOpenTerminalAt(terminalDirectory)}>
            在此目录新建终端
          </button>
        </div>
      </div>

      <div className="browser-split" ref={splitRef}>
        <div className="file-tree" role="tree" style={{ width: paneWidth }}>
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
            const isSelected = selectedPath === entry.relativePath

            return (
              // biome-ignore lint/a11y/useFocusableInteractive: 文件树行由整行点击驱动；键盘树导航（方向键）属 M3 交互专项，届时统一补 tabIndex 与完整 role 语义
              <div
                key={entry.relativePath}
                className={isSelected ? 'tree-row selected' : 'tree-row'}
                style={{ paddingLeft: 4 + row.depth * 16 }}
                role="treeitem"
                aria-expanded={entry.kind === 'directory' ? isExpanded : undefined}
                title={tooltipFor(entry)}
              >
                {entry.kind === 'directory' ? (
                  <button
                    type="button"
                    className={isExpanded ? 'twisty expanded' : 'twisty'}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleDirectory(entry.relativePath)
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

                <button type="button" className="tree-label" onClick={(event) => handleRowClick(event, entry)}>
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

        {/* 分隔线拖拽调整左右宽度，不使用固定比例 */}
        <ResizeHandle
          axis="x"
          className="split-resize"
          ariaLabel="拖拽调整文件树宽度"
          onDragStart={() => {
            paneWidthOriginRef.current = paneWidth
          }}
          onDrag={(delta) => onPaneWidthChange(clampPaneWidth(paneWidthOriginRef.current + delta))}
          onDragEnd={() => {
            // 宽度在拖拽过程中已实时更新，去抖保存会自动落盘
          }}
        />

        <div className="preview-host" ref={previewHostRef}>
          {previewError !== null ? (
            <div className="preview-pane">
              <div className="preview-empty">
                <p>无法预览该文件</p>
                <p className="hint">{previewError}</p>
              </div>
            </div>
          ) : (
            <PreviewPane
              projectId={projectId}
              preview={preview}
              loading={loadingPreview}
              onNavigateProjectPath={onNavigateProjectPath}
              onDismiss={() => {
                selectedEntryRef.current = null
                setSelectedPath(null)
                setSelectedEntry(null)
                setPreview(null)
                previewScrollRef.current = 0
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
