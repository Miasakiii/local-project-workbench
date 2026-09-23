import type { FileEntry, FileListResult, FileOperationBatchResult, FilePreview } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContextMenuItem, ContextMenuState } from './ContextMenu'
import { ContextMenu } from './ContextMenu'
import { ChevronIcon, FileIcon, FolderIcon } from './icons'
import { PreviewPane } from './PreviewPane'
import { ResizeHandle } from './ResizeHandle'

interface FileBrowserProps {
  projectId: string
  /** 项目是否已被用户信任；未信任时写操作不可用 */
  trusted: boolean
  /** 「用指定编辑器打开」所用的编辑器路径；null=未设置（G3b，设置页承载） */
  editorPath: string | null
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

type ClipboardMode = 'copy' | 'move'

interface ClipboardState {
  mode: ClipboardMode
  paths: string[]
}

interface OperationNotice {
  tone: 'success' | 'error'
  title: string
  details: string[]
}

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

function parentDirectoryOf(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

function operationReport(result: FileOperationBatchResult, action: string): OperationNotice {
  const title = `${action}完成：成功 ${result.ok} 项，失败 ${result.failed} 项，未执行 ${result.skipped} 项`
  const details: string[] = []
  if (result.abortMessage !== null) details.push(result.abortMessage)
  for (const item of result.items) {
    if (item.status === 'ok') continue
    const target =
      item.targetRelativePath === undefined || item.targetRelativePath === null ? '' : ` → ${item.targetRelativePath}`
    details.push(`${item.status === 'skipped' ? '未执行' : '失败'}：${item.relativePath}${target}：${item.message}`)
  }
  return {
    tone: result.failed > 0 || result.skipped > 0 || result.aborted ? 'error' : 'success',
    title,
    details: [...new Set(details)]
  }
}

/** 兼容回退：无 navigator.clipboard 的安全上下文时用 execCommand 复制 */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    document.body.removeChild(area)
  }
  return ok
}

/**
 * 文件树与只读预览（设计稿 4.2，M1-4）。
 *
 * 目录以树形展开，子目录**按需加载**（展开时才列举，不做无边界预读）。
 *
 * 边界：预览仍只读；M3 已加入新建、复制／剪切粘贴、重命名与删除，均限制在当前项目内；
 * Git 忽略的文件照常列出；跨项目／跨卷移动交给系统资源管理器。
 * 目录读取失败、条目截断、不可用条目都在原位说明，不显示空白成功页。
 *
 * 操作入口（界面重构三项·阶段 3）：针对**某个条目**的动作一律走右键上下文菜单
 * （渲染层自绘 `ContextMenu`），工具栏只留视图级操作与「新建」。
 * 树行另有键盘等价键 Shift+F10／Menu：焦点行同样能开出同一套菜单。
 */
export function FileBrowser({
  projectId,
  trusted,
  editorPath,
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
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set())
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [operationBusy, setOperationBusy] = useState(false)
  /**
   * 剪贴板状态（复制／剪切待粘贴的项目）。
   *
   * 刻意用 ref 而非 state：它**没有任何渲染依赖**（工具栏已不放粘贴按钮），
   * 而「复制」与随后的右键菜单可能落在同一个事件批次里——ref 是同步更新的，
   * 菜单据此判断要不要给出「粘贴」才不会拿到上一次的旧状态。
   */
  const clipboardRef = useRef<ClipboardState | null>(null)
  const [operationNotice, setOperationNotice] = useState<OperationNotice | null>(null)
  /** 键盘树导航的「焦点光标」；null 表示尚未进入树，此时首个可见行可被 Tab 聚焦 */
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  /** 右键上下文菜单（渲染层自绘）；null 表示未打开 */
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

  const generationRef = useRef(0)
  const selectedPathsRef = useRef<Set<string>>(new Set())
  const selectedEntryRef = useRef<FileEntry | null>(null)
  const expandedRef = useRef<Set<string>>(new Set())
  const appliedRef = useRef<string | null>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  /** 拖拽起点的宽度快照 */
  const paneWidthOriginRef = useRef(paneWidth)
  /** 预览容器：用于在重载前后保持滚动位置 */
  const previewHostRef = useRef<HTMLDivElement>(null)
  const previewScrollRef = useRef(0)
  /** 键盘树导航：每个 treeitem 的 DOM 引用，按相对路径索引 */
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

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
    selectedPathsRef.current = new Set()
    setSelectedPaths(new Set())
    setSelectedPath(null)
    setSelectedEntry(null)
    setPreview(null)
    setCursorPath(null)
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

      const nextSelection = new Set([entry.relativePath])
      selectedPathsRef.current = nextSelection
      setSelectedPaths(nextSelection)
      selectedEntryRef.current = entry
      setSelectedPath(entry.relativePath)
      setSelectedEntry(entry)
      setCursorPath(entry.relativePath)
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

  const selectedCount = selectedPaths.size
  const selectedPathList = useCallback((): string[] => [...selectedPathsRef.current], [])

  const clearSelection = useCallback(() => {
    selectedPathsRef.current = new Set()
    setSelectedPaths(new Set())
    setSelectedPath(null)
    setSelectedEntry(null)
    selectedEntryRef.current = null
    setPreview(null)
    previewScrollRef.current = 0
    setCursorPath(null)
    onPathChange('')
  }, [onPathChange])

  const refreshLoadedDirectories = useCallback(async () => {
    generationRef.current += 1
    await Promise.all(['', ...expanded].map((directory) => loadDirectory(directory)))
  }, [expanded, loadDirectory])

  const targetDirectory =
    selectedEntry === null
      ? ''
      : selectedEntry.kind === 'directory'
        ? selectedEntry.relativePath
        : parentDirectoryOf(selectedEntry.relativePath)

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
      setPreview(null)
      onPathChange(remaining[0] ?? '')
    },
    [clearSelection, onPathChange]
  )

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
        generationRef.current += 1
        selectedEntryRef.current = null
        setDirs({})
        setExpanded(new Set())
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
    [clearSelection, onPathChange, operationBusy, projectId, revealEntry, selectedPathList]
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
        setPreview(null)
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
      const additive = event.ctrlKey || event.metaKey
      selectEntry(entry, additive)
      // Ctrl/Cmd-click 用于多选，不改变目录展开状态；普通点击保持资源管理器语义。
      if (!additive && entry.kind === 'directory') toggleDirectory(entry.relativePath)
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

  /* ---------- 针对条目的动作（右键菜单与工具栏共用） ---------- */

  /**
   * 这些回调一律**显式接收目标条目**，不读 `selectedEntry`。
   *
   * 原因：右键菜单先选中条目、再开菜单，而 React 的状态更新是异步的——
   * 若回调从 state 取目标，菜单项触发时拿到的还是选中前的旧值（通常是 null），
   * 表现为「右键后点删除没有反应」。选择数量从 ref 读，那里是同步更新的。
   */

  const openExternally = useCallback(
    async (entry: FileEntry) => {
      await window.workbench.system.openPath({ projectId, relativePath: entry.relativePath })
    },
    [projectId]
  )

  const revealInSystem = useCallback(
    async (entry: FileEntry) => {
      await window.workbench.system.showInFolder({ projectId, relativePath: entry.relativePath })
    },
    [projectId]
  )

  /** 用指定编辑器打开（G3b）；编辑器未设置或启动失败时以可读原因反馈 */
  const openWithEditor = useCallback(
    async (entry: FileEntry) => {
      const error = await window.workbench.system.openWith({ projectId, relativePath: entry.relativePath })
      if (error === null) {
        setOperationNotice({ tone: 'success', title: '已用指定编辑器打开', details: [entry.relativePath] })
      } else {
        setOperationNotice({ tone: 'error', title: '打开失败', details: [error] })
      }
    },
    [projectId]
  )

  /** 复制条目相对路径到系统剪贴板（G3）。相对路径不离开本项目，无需主进程。 */
  const copyPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return
    const text = paths.join('\n')
    const done = (): void =>
      setOperationNotice({ tone: 'success', title: `已复制 ${paths.length} 个路径`, details: paths })
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
        done()
      } else if (legacyCopy(text)) {
        done()
      } else {
        setOperationNotice({ tone: 'error', title: '复制失败', details: ['无法写入系统剪贴板'] })
      }
    } catch {
      if (legacyCopy(text)) done()
      else setOperationNotice({ tone: 'error', title: '复制失败', details: ['无法写入系统剪贴板'] })
    }
  }, [])

  /* ---------- 右键上下文菜单（界面重构三项·阶段 3） ---------- */

  /** 未信任项目的写操作一律禁用，但保留入口，让用户看到「有哪些操作、为什么不能用」 */
  const writeTitle = trusted ? undefined : '请先信任该项目（项目头部可切换），才能执行写操作'
  /** 编辑器未设置时「用指定编辑器打开」不可用；说明写清楚去哪里设置 */
  const editorTitle =
    editorPath === null
      ? '尚未设置编辑器：请在侧边栏「设置」→「编辑器」中选择'
      : `用 ${editorPath.split(/[\\/]/).pop() ?? editorPath} 打开`

  /** 条目的父目录：文件取其所在目录，目录取其自身 */
  const directoryOf = useCallback(
    (entry: FileEntry): string =>
      entry.kind === 'directory' ? entry.relativePath : parentDirectoryOf(entry.relativePath),
    []
  )

  /** 空白处（树背景）菜单：作用于当前目标目录 */
  const whereLabel = targetDirectory.length === 0 ? '项目根' : targetDirectory

  const blankMenu = useCallback((): ContextMenuItem[] => {
    const where = targetDirectory.length === 0 ? '项目根' : targetDirectory
    const create: ContextMenuItem[] = [
      {
        id: 'new-file',
        label: '新建文件',
        disabled: !trusted,
        title: writeTitle ?? `在「${where}」中新建空文件`,
        onSelect: () => void createNewEntry('file', targetDirectory)
      },
      {
        id: 'new-directory',
        label: '新建文件夹',
        disabled: !trusted,
        title: writeTitle ?? `在「${where}」中新建空文件夹`,
        onSelect: () => void createNewEntry('directory', targetDirectory)
      }
    ]
    const paste: ContextMenuItem[] =
      clipboardRef.current === null || clipboardRef.current.paths.length === 0
        ? []
        : [
            {
              id: 'paste',
              label: `粘贴（${clipboardRef.current?.paths.length ?? 0}）`,
              disabled: !trusted,
              title: writeTitle ?? `粘贴到${where}`,
              separatorBefore: true,
              onSelect: () => void pasteClipboard(targetDirectory)
            }
          ]
    return [...create, ...paste, { id: 'refresh', label: '刷新', separatorBefore: true, onSelect: refreshAll }]
  }, [createNewEntry, pasteClipboard, refreshAll, targetDirectory, trusted, writeTitle])

  /**
   * 条目菜单。分三段，顺序与右键本意一致：
   * 1. 只读操作（预览／打开／展开）；
   * 2. 跨对象操作（终端、复制路径、定位）；
   * 3. 写操作（新建、复制、剪切、重命名、删除）。
   */
  const entryMenu = useCallback(
    (entry: FileEntry): ContextMenuItem[] => {
      const isDirectory = entry.kind === 'directory'

      const read: ContextMenuItem[] = isDirectory
        ? [
            {
              id: 'toggle',
              label: expanded.has(entry.relativePath) ? '收起' : '展开',
              onSelect: () => toggleDirectory(entry.relativePath)
            }
          ]
        : [
            {
              id: 'preview',
              label: '预览',
              onSelect: () => openPreview(entry)
            },
            {
              id: 'open-default',
              label: '用默认程序打开',
              onSelect: () => void openExternally(entry)
            },
            {
              id: 'open-editor',
              label: '用指定编辑器打开',
              disabled: editorPath === null,
              title: editorTitle,
              onSelect: () => void openWithEditor(entry)
            }
          ]

      const shared: ContextMenuItem[] = [
        {
          id: 'terminal',
          label: isDirectory ? '在此目录新建终端' : '在所在目录新建终端',
          onSelect: () => onOpenTerminalAt(directoryOf(entry))
        },
        {
          id: 'copy-path',
          label: '复制路径',
          disabled: selectedCount === 0,
          title: selectedCount <= 1 ? '复制该条目相对路径' : `复制所选 ${selectedCount} 个条目相对路径`,
          onSelect: () => void copyPaths(selectedPathList())
        },
        {
          id: 'reveal',
          label: '在资源管理器中定位',
          onSelect: () => void revealInSystem(entry)
        }
      ]

      const createHere: ContextMenuItem[] = isDirectory
        ? [
            {
              id: 'new-file',
              label: '新建文件',
              disabled: !trusted,
              title: writeTitle ?? `在「${entry.relativePath}」中新建空文件`,
              separatorBefore: true,
              onSelect: () => void createNewEntry('file', entry.relativePath)
            },
            {
              id: 'new-directory',
              label: '新建文件夹',
              disabled: !trusted,
              title: writeTitle ?? `在「${entry.relativePath}」中新建空文件夹`,
              onSelect: () => void createNewEntry('directory', entry.relativePath)
            },
            // 剪贴板有内容时才给出「粘贴」，目标就是右键的这个目录
            ...(clipboardRef.current === null || clipboardRef.current.paths.length === 0
              ? []
              : [
                  {
                    id: 'paste',
                    label: `粘贴（${clipboardRef.current?.paths.length ?? 0}）`,
                    disabled: !trusted,
                    title: writeTitle ?? `粘贴到「${entry.relativePath}」`,
                    onSelect: () => void pasteClipboard(entry.relativePath)
                  }
                ])
          ]
        : []

      const write: ContextMenuItem[] = [
        {
          id: 'copy',
          label: '复制',
          disabled: !trusted,
          title: writeTitle ?? '复制所选项目，之后选择目标目录并粘贴',
          separatorBefore: createHere.length === 0,
          onSelect: () => setClipboardFromSelection('copy')
        },
        {
          id: 'cut',
          label: '剪切',
          disabled: !trusted,
          title: writeTitle ?? '剪切所选项目，之后选择目标目录并粘贴',
          onSelect: () => setClipboardFromSelection('move')
        },
        {
          id: 'rename',
          label: '重命名',
          disabled: !trusted || selectedCount !== 1,
          title:
            selectedCount !== 1
              ? '重命名只对单个选中项可用（可先取消多选）'
              : (writeTitle ?? '在同一父目录内重命名该条目'),
          onSelect: () => void renameSelected(entry)
        },
        {
          id: 'delete',
          label: '删除',
          danger: true,
          disabled: !trusted,
          title: writeTitle ?? '将所选项目发送到系统回收站',
          separatorBefore: true,
          onSelect: () => void deleteSelected()
        }
      ]

      return [...read, ...shared, ...createHere, ...write]
    },
    [
      copyPaths,
      createNewEntry,
      deleteSelected,
      directoryOf,
      editorPath,
      editorTitle,
      expanded,
      onOpenTerminalAt,
      openExternally,
      openPreview,
      openWithEditor,
      pasteClipboard,
      renameSelected,
      selectedCount,
      selectedPathList,
      setClipboardFromSelection,
      toggleDirectory,
      trusted,
      writeTitle,
      revealInSystem
    ]
  )

  /** 右键某一行：未选中则改选它（已选中则保留多选，与资源管理器一致），再按光标开菜单 */
  const openMenuForEntry = useCallback(
    (entry: FileEntry, x: number, y: number, returnFocusTo: HTMLElement | null) => {
      if (!selectedPathsRef.current.has(entry.relativePath)) selectEntry(entry, false)
      setMenu({ x, y, items: entryMenu(entry), returnFocusTo })
    },
    [entryMenu, selectEntry]
  )

  /** 右键空白处：作用于当前目标目录（未选中条目时为项目根） */
  const openBlankMenu = useCallback(
    (x: number, y: number, returnFocusTo: HTMLElement | null) => {
      setMenu({ x, y, items: blankMenu(), returnFocusTo })
    },
    [blankMenu]
  )

  /** 键盘等价键：菜单贴在焦点行右侧弹出，位置确定、不依赖指针 */
  const openMenuForKeyboard = useCallback(
    (entry: FileEntry) => {
      const element = rowRefs.current.get(entry.relativePath) ?? null
      const rect = element?.getBoundingClientRect()
      const x = rect === undefined ? 96 : Math.round(rect.left + 28)
      const y = rect === undefined ? 160 : Math.round(rect.bottom)
      openMenuForEntry(entry, x, y, element)
    },
    [openMenuForEntry]
  )

  /* ---------- 键盘树导航（ARIA tree：漫游 tabindex + 方向键） ---------- */

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
          // Shift+F10／Menu 键是「右键」的键盘等价物：给焦点行开出同一套菜单
          const entry = cursorPath === null ? undefined : list[currentIndex]?.entry
          if (entry === undefined) return
          event.preventDefault()
          openMenuForKeyboard(entry)
          break
        }
        default:
          break
      }
    },
    [cursorPath, focusableRows, openMenuForKeyboard, selectEntry, toggleDirectory, expanded, openPreview]
  )

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
              selectedPathsRef.current = new Set()
              setSelectedPaths(new Set())
              setSelectedPath(null)
              setSelectedEntry(null)
              selectedEntryRef.current = null
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
        {/*
          工具栏只留视图级操作与「新建」。针对某个条目的动作全部下沉到右键菜单
          （树行右键，或焦点行按 Shift+F10／Menu 键），避免十几枚按钮挤占一行。
        */}
        <div className="browser-actions">
          <button type="button" onClick={collapseAll} disabled={expanded.size === 0}>
            收起全部
          </button>
          <button type="button" onClick={refreshAll} disabled={operationBusy}>
            刷新
          </button>
          <div className="split-button">
            <button
              type="button"
              onClick={() => void createNewEntry('file', targetDirectory)}
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
                const rect = event.currentTarget.getBoundingClientRect()
                setMenu({
                  x: Math.round(rect.left),
                  y: Math.round(rect.bottom + 4),
                  returnFocusTo: event.currentTarget,
                  items: [
                    {
                      id: 'new-file',
                      label: '新建文件',
                      disabled: !trusted,
                      title: writeTitle ?? `在「${whereLabel}」中新建空文件`,
                      onSelect: () => void createNewEntry('file', targetDirectory)
                    },
                    {
                      id: 'new-directory',
                      label: '新建文件夹',
                      disabled: !trusted,
                      title: writeTitle ?? `在「${whereLabel}」中新建空文件夹`,
                      onSelect: () => void createNewEntry('directory', targetDirectory)
                    }
                  ]
                })
              }}
            >
              ▾
            </button>
          </div>
        </div>
      </div>

      {operationNotice !== null ? (
        <div
          className={operationNotice.tone === 'error' ? 'file-operation-note error' : 'file-operation-note'}
          role="status"
        >
          <strong>{operationNotice.title}</strong>
          {operationNotice.details.length > 0 ? (
            <ul>
              {operationNotice.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="browser-split" ref={splitRef}>
        <div
          className="file-tree"
          role="tree"
          aria-multiselectable="true"
          onKeyDown={handleTreeKeyDown}
          style={{ width: paneWidth }}
          // 右键空白处：开「当前目录」菜单（新建／粘贴／刷新）
          onContextMenu={(event) => {
            if (event.target instanceof Element && event.target.closest('.tree-row') !== null) return
            event.preventDefault()
            openBlankMenu(event.clientX, event.clientY, null)
          }}
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
                ref={(element) => {
                  if (element) rowRefs.current.set(entry.relativePath, element)
                  else rowRefs.current.delete(entry.relativePath)
                }}
                className={isSelected ? 'tree-row selected' : 'tree-row'}
                style={{ paddingLeft: 4 + row.depth * 16 }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={isSelected}
                aria-expanded={entry.kind === 'directory' ? isExpanded : undefined}
                tabIndex={(cursorPath ?? focusableRows[0]?.entry.relativePath) === entry.relativePath ? 0 : -1}
                title={tooltipFor(entry)}
                onFocus={() => setCursorPath(entry.relativePath)}
                // 右键条目：先按需选中，再按光标位置开该条目的菜单
                onContextMenu={(event) => {
                  event.preventDefault()
                  openMenuForEntry(entry, event.clientX, event.clientY, event.currentTarget)
                }}
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

                <button
                  type="button"
                  className="tree-label"
                  tabIndex={-1}
                  onClick={(event) => handleRowClick(event, entry)}
                >
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

      {menu !== null ? <ContextMenu state={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  )
}
