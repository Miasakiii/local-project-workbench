import type { FileEntry } from '@shared/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFileOperations } from '../hooks/useFileOperations'
import { useFilePreview } from '../hooks/useFilePreview'
import { useFileSelection } from '../hooks/useFileSelection'
import { useFileTreeData } from '../hooks/useFileTreeData'
import { useTreeKeyboardNav } from '../hooks/useTreeKeyboardNav'
import type { ContextMenuItem, ContextMenuState } from './ContextMenu'
import { ContextMenu } from './ContextMenu'
import { FileBrowserToolbar } from './FileBrowserToolbar'
import { FileTree } from './FileTree'
import { buildBlankMenu, buildEntryMenu } from './file-browser/menus'
import { ancestorDirectories, legacyCopy, parentDirectoryOf } from './file-browser/utils'
import { OperationNote } from './OperationNote'
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
 *
 * 结构（重构拆分，行为不变）：本文件只做**组合**——状态与逻辑按关注点收在
 * `hooks/` 下，展示层在 `FileTree`／`FileBrowserToolbar`／`OperationNote`，
 * 菜单构建在 `file-browser/menus.ts`：
 * - `useFilePreview`      预览读取、错误态与滚动保持；
 * - `useFileTreeData`     目录按需加载、展开状态与扁平行列表；
 * - `useFileSelection`    选择／键盘光标与 ref 同步镜像；
 * - `useFileOperations`   四类写操作、剪贴板与逐项结果提示；
 * - `useTreeKeyboardNav`  ARIA tree 键盘导航。
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
  const preview = useFilePreview({ projectId })
  const tree = useFileTreeData({ projectId })
  const selection = useFileSelection({
    onPathChange,
    openPreview: preview.openPreview,
    clearPreview: preview.clearPreview,
    dismissPreview: preview.dismissPreview
  })

  const {
    preview: currentPreview,
    loadingPreview,
    previewError,
    previewHostRef,
    previewScrollRef,
    openPreview,
    clearPreview,
    dismissPreview
  } = preview
  const {
    rows,
    expanded,
    setExpanded,
    expandedRef,
    loadDirectory,
    toggleDirectory,
    collapseAll,
    refreshAll,
    refreshLoadedDirectories,
    resetAll: resetTree
  } = tree
  const {
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
    resetAll: resetSelection,
    selectedPathList
  } = selection

  /** 右键上下文菜单（渲染层自绘）；null 表示未打开 */
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const splitRef = useRef<HTMLDivElement>(null)
  /** 拖拽起点的宽度快照 */
  const paneWidthOriginRef = useRef(paneWidth)
  /** 键盘树导航：每个 treeitem 的 DOM 引用，按相对路径索引 */
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  /**
   * 展开并选中某条目（含其祖先目录链）——组合树、选择与预览三个 hook。
   *
   * 选中部分走 `applyRevealed`（不标记 initialPath 已应用）：重命名后
   * 「效果再揭示一次」的原有行为由此保留。
   */
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

      applyRevealed(entry)
      if (entry.kind === 'file') openPreview(entry)
      return entry
    },
    [applyRevealed, loadDirectory, openPreview, setExpanded]
  )

  const operations = useFileOperations({
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
  })

  const { operationBusy, operationNotice, setOperationNotice, clipboardRef } = operations
  const { createNewEntry, renameSelected, setClipboardFromSelection, pasteClipboard, deleteSelected } = operations

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
    [projectId, setOperationNotice]
  )

  /** 复制条目相对路径到系统剪贴板（G3）。相对路径不离开本项目，无需主进程。 */
  const copyPaths = useCallback(
    async (paths: string[]) => {
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
    },
    [setOperationNotice]
  )

  /* ---------- 右键上下文菜单（界面重构三项·阶段 3） ---------- */

  /** 未信任项目的写操作一律禁用，但保留入口，让用户看到「有哪些操作、为什么不能用」 */
  const writeTitle = trusted ? undefined : '请先信任该项目（项目头部可切换），才能执行写操作'
  /** 编辑器未设置时「用指定编辑器打开」不可用；说明写清楚去哪里设置 */
  const editorTitle =
    editorPath === null
      ? '尚未设置编辑器：请在侧边栏「设置」→「编辑器」中选择'
      : `用 ${editorPath.split(/[\\/]/).pop() ?? editorPath} 打开`

  /**
   * 菜单构建委托给 `file-browser/menus.ts` 的纯函数（重构，行为不变）。
   *
   * 这里只负责把组件当前状态组装成 context 快照；剪贴板从 ref 读——「复制」与
   * 随后的右键菜单可能落在同一个事件批次里，ref 是同步更新的，菜单据此判断
   * 要不要给出「粘贴」才不会拿到上一次的旧状态。
   */
  const blankMenu = useCallback(
    (): ContextMenuItem[] =>
      buildBlankMenu({
        targetDirectory:
          selectedEntry === null
            ? ''
            : selectedEntry.kind === 'directory'
              ? selectedEntry.relativePath
              : parentDirectoryOf(selectedEntry.relativePath),
        trusted,
        writeTitle,
        clipboard: clipboardRef.current,
        selectedPathList,
        createNewEntry,
        pasteClipboard,
        refreshAll,
        toggleDirectory,
        openPreview,
        openExternally,
        openWithEditor,
        openTerminalAt: onOpenTerminalAt,
        copyPaths,
        revealInSystem,
        setClipboardFromSelection,
        renameSelected,
        deleteSelected
      }),
    [
      clipboardRef,
      copyPaths,
      createNewEntry,
      deleteSelected,
      onOpenTerminalAt,
      openExternally,
      openPreview,
      openWithEditor,
      pasteClipboard,
      refreshAll,
      renameSelected,
      revealInSystem,
      selectedEntry,
      selectedPathList,
      setClipboardFromSelection,
      toggleDirectory,
      trusted,
      writeTitle
    ]
  )

  const entryMenu = useCallback(
    (entry: FileEntry): ContextMenuItem[] =>
      buildEntryMenu(
        {
          trusted,
          writeTitle,
          editorPath,
          editorTitle,
          expanded,
          selectedCount: selectedPaths.size,
          clipboard: clipboardRef.current,
          selectedPathList,
          createNewEntry,
          pasteClipboard,
          refreshAll,
          toggleDirectory,
          openPreview,
          openExternally,
          openWithEditor,
          openTerminalAt: onOpenTerminalAt,
          copyPaths,
          revealInSystem,
          setClipboardFromSelection,
          renameSelected,
          deleteSelected
        },
        entry
      ),
    [
      clipboardRef,
      copyPaths,
      createNewEntry,
      deleteSelected,
      editorPath,
      editorTitle,
      expanded,
      onOpenTerminalAt,
      openExternally,
      openPreview,
      openWithEditor,
      pasteClipboard,
      refreshAll,
      renameSelected,
      revealInSystem,
      selectedPaths,
      selectedPathList,
      setClipboardFromSelection,
      toggleDirectory,
      trusted,
      writeTitle
    ]
  )

  /** 关闭菜单：稳定引用，让 ContextMenu 的外部交互监听不必随渲染反复增删 */
  const closeMenu = useCallback(() => {
    setMenu(null)
  }, [])

  /** 右键某一行：未选中则改选它（已选中则保留多选，与资源管理器一致），再按光标开菜单 */
  const openMenuForEntry = useCallback(
    (entry: FileEntry, x: number, y: number, returnFocusTo: HTMLElement | null) => {
      if (!selectedPathsRef.current.has(entry.relativePath)) selectEntry(entry, false)
      setMenu({ x, y, items: entryMenu(entry), returnFocusTo })
    },
    [entryMenu, selectEntry, selectedPathsRef]
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

  const keyboardNav = useTreeKeyboardNav({
    rows,
    cursorPath,
    setCursorPath,
    expanded,
    selectEntry,
    toggleDirectory,
    openPreview,
    openMenuForKeyboard,
    rowRefs
  })
  const { handleTreeKeyDown, focusableRows } = keyboardNav

  /**
   * 面包屑「项目根」：清空选择回到根视野。
   *
   * 与 `clearSelection` 的差别是刻意的：这里**不**重置键盘光标与预览滚动位置
   * （点面包屑不等于放弃键盘位置），行为与原内联实现一致。
   */
  const selectRoot = useCallback(() => {
    appliedRef.current = ''
    selectedPathsRef.current = new Set()
    setSelectedPaths(new Set())
    setSelectedPath(null)
    setSelectedEntry(null)
    selectedEntryRef.current = null
    clearPreview()
    onPathChange('')
  }, [
    appliedRef,
    clearPreview,
    onPathChange,
    selectedEntryRef,
    selectedPathsRef,
    setSelectedEntry,
    setSelectedPath,
    setSelectedPaths
  ])

  /** 右键条目：先阻止默认菜单，再按光标位置开该条目的菜单（选中逻辑见 openMenuForEntry） */
  const handleRowContextMenu = useCallback(
    (entry: FileEntry, event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      openMenuForEntry(entry, event.clientX, event.clientY, event.currentTarget)
    },
    [openMenuForEntry]
  )

  /** 右键空白处：落在树行上时放行（由行自己的处理器负责），否则开「当前目录」菜单 */
  const handleBlankContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest('.tree-row') !== null) return
      event.preventDefault()
      openBlankMenu(event.clientX, event.clientY, null)
    },
    [openBlankMenu]
  )

  /** 树行 DOM 引用登记／注销：键盘导航据此聚焦 */
  const handleRowMount = useCallback((relativePath: string, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(relativePath, element)
    else rowRefs.current.delete(relativePath)
  }, [])

  /** 「新建」分 split-button 菜单：位置贴在锚点下方，焦点归还锚点 */
  const openCreateMenu = useCallback((anchor: HTMLElement, items: ContextMenuItem[]) => {
    const rect = anchor.getBoundingClientRect()
    setMenu({ x: Math.round(rect.left), y: Math.round(rect.bottom + 4), returnFocusTo: anchor, items })
  }, [])

  /* ---------- 初始加载与视图状态恢复 ---------- */

  // 项目切换（loadDirectory 身份变化）时整树重置：作废在途响应，清空选择与预览
  useEffect(() => {
    resetTree()
    resetSelection()
    clearPreview()
    void loadDirectory('')
  }, [clearPreview, loadDirectory, resetSelection, resetTree])

  useEffect(() => {
    if (appliedRef.current === initialPath) return
    appliedRef.current = initialPath
    if (initialPath.length === 0) return
    void revealEntry(initialPath, true)
  }, [appliedRef, initialPath, revealEntry])

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
  }, [expandedRef, loadDirectory, openPreview, previewHostRef, previewScrollRef, refreshToken, selectedEntryRef])
  const targetDirectory =
    selectedEntry === null
      ? ''
      : selectedEntry.kind === 'directory'
        ? selectedEntry.relativePath
        : parentDirectoryOf(selectedEntry.relativePath)

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

  /** 拖拽分栏时限制范围：右侧预览区始终保留可用宽度 */
  const clampPaneWidth = useCallback((value: number): number => {
    const container = splitRef.current
    const available = container === null ? 900 : container.clientWidth
    const max = Math.max(280, available - 300)
    return Math.min(Math.max(Math.round(value), 220), max)
  }, [])

  return (
    <div className="file-browser">
      <FileBrowserToolbar
        breadcrumb={breadcrumb}
        selectedPath={selectedPath}
        targetDirectory={targetDirectory}
        trusted={trusted}
        writeTitle={writeTitle}
        operationBusy={operationBusy}
        expandedSize={expanded.size}
        onSelectRoot={selectRoot}
        onSelectCrumb={(relativePath) => void revealEntry(relativePath, true)}
        onCollapseAll={collapseAll}
        onRefreshAll={refreshAll}
        onCreateEntry={(kind, target) => void createNewEntry(kind, target)}
        onOpenCreateMenu={openCreateMenu}
      />

      {operationNotice !== null ? <OperationNote notice={operationNotice} /> : null}

      <div className="browser-split" ref={splitRef}>
        <FileTree
          rows={rows}
          expanded={expanded}
          selectedPaths={selectedPaths}
          cursorPath={cursorPath}
          firstFocusablePath={focusableRows[0]?.entry.relativePath ?? null}
          paneWidth={paneWidth}
          onTreeKeyDown={handleTreeKeyDown}
          onBlankContextMenu={handleBlankContextMenu}
          onRowContextMenu={handleRowContextMenu}
          onRowFocus={setCursorPath}
          onRowMount={handleRowMount}
          onToggleDirectory={toggleDirectory}
          onLabelClick={handleRowClick}
        />

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
              preview={currentPreview}
              loading={loadingPreview}
              onNavigateProjectPath={onNavigateProjectPath}
              onDismiss={() => {
                clearEntry()
                dismissPreview()
              }}
            />
          )}
        </div>
      </div>

      {menu !== null ? <ContextMenu state={menu} onClose={closeMenu} /> : null}
    </div>
  )
}
