import type { FileEntry } from '@shared/types'
import type { ContextMenuItem } from '../ContextMenu'
import { parentDirectoryOf } from './utils'

/**
 * 文件栏的右键上下文菜单构建（界面重构三项·阶段 3）。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：菜单内容是**状态的纯函数**——
 * 打开菜单时由组件组装一份 context 快照传入，构建过程不读任何组件状态。
 * 这样「菜单项Disabled/title 与实际状态一致」不依赖 React 的更新时序。
 *
 * 菜单分三段，顺序与右键本意一致：
 * 1. 只读操作（预览／打开／展开）；
 * 2. 跨对象操作（终端、复制路径、定位）；
 * 3. 写操作（新建、复制、剪切、重命名、删除）。
 */

export type ClipboardMode = 'copy' | 'move'

/** 剪贴板快照；null 表示无待粘贴内容。 */
export interface MenuClipboardState {
  mode: ClipboardMode
  paths: string[]
}

/** 各菜单项触发时的动作回调（由组件装配，均为稳定引用）。 */
interface MenuActions {
  createNewEntry: (kind: 'file' | 'directory', target: string) => void
  pasteClipboard: (target: string) => void
  refreshAll: () => void
  toggleDirectory: (relativePath: string) => void
  openPreview: (entry: FileEntry) => void
  openExternally: (entry: FileEntry) => void
  openWithEditor: (entry: FileEntry) => void
  openTerminalAt: (relativePath: string) => void
  copyPaths: (paths: string[]) => void
  revealInSystem: (entry: FileEntry) => void
  setClipboardFromSelection: (mode: ClipboardMode) => void
  renameSelected: (entry: FileEntry) => void
  deleteSelected: () => void
  selectedPathList: () => string[]
}

/** 空白处（树背景）菜单的输入：作用于当前目标目录。 */
export interface BlankMenuContext extends MenuActions {
  targetDirectory: string
  trusted: boolean
  /** 未信任时写操作的禁用说明；已信任为 undefined */
  writeTitle: string | undefined
  clipboard: MenuClipboardState | null
}

/** 条目菜单的输入。 */
export interface EntryMenuContext extends MenuActions {
  trusted: boolean
  writeTitle: string | undefined
  editorPath: string | null
  editorTitle: string
  /** 当前展开的目录集合（决定「展开/收起」标签） */
  expanded: Set<string>
  selectedCount: number
  clipboard: MenuClipboardState | null
}

/** 空白处（树背景）菜单：新建／粘贴／刷新，作用于当前目标目录。 */
export function buildBlankMenu(context: BlankMenuContext): ContextMenuItem[] {
  const { targetDirectory, trusted, writeTitle, clipboard } = context
  const where = targetDirectory.length === 0 ? '项目根' : targetDirectory
  const create: ContextMenuItem[] = [
    {
      id: 'new-file',
      label: '新建文件',
      disabled: !trusted,
      title: writeTitle ?? `在「${where}」中新建空文件`,
      onSelect: () => context.createNewEntry('file', targetDirectory)
    },
    {
      id: 'new-directory',
      label: '新建文件夹',
      disabled: !trusted,
      title: writeTitle ?? `在「${where}」中新建空文件夹`,
      onSelect: () => context.createNewEntry('directory', targetDirectory)
    }
  ]
  const paste: ContextMenuItem[] =
    clipboard === null || clipboard.paths.length === 0
      ? []
      : [
          {
            id: 'paste',
            label: `粘贴（${clipboard.paths.length}）`,
            disabled: !trusted,
            title: writeTitle ?? `粘贴到${where}`,
            separatorBefore: true,
            onSelect: () => context.pasteClipboard(targetDirectory)
          }
        ]
  return [...create, ...paste, { id: 'refresh', label: '刷新', separatorBefore: true, onSelect: context.refreshAll }]
}

/**
 * 条目菜单。
 *
 * 这些回调一律**显式接收目标条目**，不读组件的 `selectedEntry`：
 * 右键菜单先选中条目、再开菜单，而 React 的状态更新是异步的——
 * 若回调从 state 取目标，菜单项触发时拿到的还是选中前的旧值（通常是 null），
 * 表现为「右键后点删除没有反应」。选择数量从 context 快照读，打开菜单时已同步。
 */
export function buildEntryMenu(context: EntryMenuContext, entry: FileEntry): ContextMenuItem[] {
  const isDirectory = entry.kind === 'directory'
  const { trusted, writeTitle, editorPath, editorTitle, expanded, selectedCount, clipboard } = context

  const read: ContextMenuItem[] = isDirectory
    ? [
        {
          id: 'toggle',
          label: expanded.has(entry.relativePath) ? '收起' : '展开',
          onSelect: () => context.toggleDirectory(entry.relativePath)
        }
      ]
    : [
        {
          id: 'preview',
          label: '预览',
          onSelect: () => context.openPreview(entry)
        },
        {
          id: 'open-default',
          label: '用默认程序打开',
          onSelect: () => context.openExternally(entry)
        },
        {
          id: 'open-editor',
          label: '用指定编辑器打开',
          disabled: editorPath === null,
          title: editorTitle,
          onSelect: () => context.openWithEditor(entry)
        }
      ]

  const terminalDirectory = isDirectory ? entry.relativePath : parentDirectoryOf(entry.relativePath)
  const shared: ContextMenuItem[] = [
    {
      id: 'terminal',
      label: isDirectory ? '在此目录新建终端' : '在所在目录新建终端',
      title: !trusted
        ? '创建终端前需要先信任该项目（项目头部可切换）'
        : `在该目录新建一个终端标签（${terminalDirectory === '' ? '项目根' : terminalDirectory}）`,
      onSelect: () => context.openTerminalAt(terminalDirectory)
    },
    {
      id: 'copy-path',
      label: '复制路径',
      disabled: selectedCount === 0,
      title: selectedCount <= 1 ? '复制该条目相对路径' : `复制所选 ${selectedCount} 个条目相对路径`,
      onSelect: () => context.copyPaths(context.selectedPathList())
    },
    {
      id: 'reveal',
      label: '在资源管理器中定位',
      onSelect: () => context.revealInSystem(entry)
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
          onSelect: () => context.createNewEntry('file', entry.relativePath)
        },
        {
          id: 'new-directory',
          label: '新建文件夹',
          disabled: !trusted,
          title: writeTitle ?? `在「${entry.relativePath}」中新建空文件夹`,
          onSelect: () => context.createNewEntry('directory', entry.relativePath)
        },
        // 剪贴板有内容时才给出「粘贴」，目标就是右键的这个目录
        ...(clipboard === null || clipboard.paths.length === 0
          ? []
          : [
              {
                id: 'paste',
                label: `粘贴（${clipboard.paths.length}）`,
                disabled: !trusted,
                title: writeTitle ?? `粘贴到「${entry.relativePath}」`,
                onSelect: () => context.pasteClipboard(entry.relativePath)
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
      onSelect: () => context.setClipboardFromSelection('copy')
    },
    {
      id: 'cut',
      label: '剪切',
      disabled: !trusted,
      title: writeTitle ?? '剪切所选项目，之后选择目标目录并粘贴',
      onSelect: () => context.setClipboardFromSelection('move')
    },
    {
      id: 'rename',
      label: '重命名',
      disabled: !trusted || selectedCount !== 1,
      title:
        selectedCount !== 1 ? '重命名只对单个选中项可用（可先取消多选）' : (writeTitle ?? '在同一父目录内重命名该条目'),
      onSelect: () => context.renameSelected(entry)
    },
    {
      id: 'delete',
      label: '删除',
      danger: true,
      disabled: !trusted,
      title: writeTitle ?? '将所选项目发送到系统回收站',
      separatorBefore: true,
      onSelect: () => context.deleteSelected()
    }
  ]

  return [...read, ...shared, ...createHere, ...write]
}
