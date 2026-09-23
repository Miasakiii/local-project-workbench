import type { AppInfo } from '@shared/types'
import { useCallback } from 'react'
import { SidebarIcon } from '../components/icons'

/**
 * 设置页（界面重构三项·阶段 2）。
 *
 * 把散落各处的**应用级**设置收拢到一处，替代原先项目库里的编辑器配置与启动开关、
 * 以及终端工具栏里那只不持久化的 shell 下拉：
 * - 编辑器：「用指定编辑器打开」所用的可执行文件；
 * - 终端：默认 Shell（应用级偏好，写入 settings.json）；
 * - 启动：「恢复上次项目」开关（C09）；
 * - 关于：运行时的 Electron／Chromium／Node 版本，只读。
 *
 * 边界：这里**不放** per-project 设置（信任、允许网络图片、README、简介）——
 * 那些本来就属于某个项目，放在项目页里才不会在切换项目时误导用户。
 *
 * 本页是非模态主区域视图，因此不用 `useModalFocus`，Esc 也不关闭它；
 * 分组用 `<section aria-labelledby>` + h2，让读屏用户可以按标题在分组间跳转。
 */

export interface SettingsPageProps {
  info: AppInfo | null
  sidebarOpen: boolean
  /** 「恢复上次项目」开关（应用级偏好，默认关闭，C09） */
  restoreLastProject: boolean
  /** 「用指定编辑器打开」所用的编辑器路径；null=未设置（G3b） */
  editorPath: string | null
  /** 终端默认 Shell；空串=按本机自动探测 */
  defaultShell: string
  onToggleSidebar: () => void
  onSetRestoreLastProject: (enabled: boolean) => void
  onConfigureEditor: () => void
  onClearEditor: () => void
  onDefaultShellChange: (shell: string) => void
}

/** 与主进程 `shell-select.ts` 的白名单一致；空串=自动探测 */
const SHELL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '自动探测' },
  { value: 'pwsh', label: 'pwsh（PowerShell 7）' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'cmd', label: '命令提示符（cmd）' }
]

function editorLabel(editorPath: string | null): string {
  if (editorPath === null) return '未设置'
  return editorPath.split(/[\\/]/).pop() ?? editorPath
}

export function SettingsPage({
  info,
  sidebarOpen,
  restoreLastProject,
  editorPath,
  defaultShell,
  onToggleSidebar,
  onSetRestoreLastProject,
  onConfigureEditor,
  onClearEditor,
  onDefaultShellChange
}: SettingsPageProps): React.JSX.Element {
  const handleShellChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onDefaultShellChange(event.target.value)
    },
    [onDefaultShellChange]
  )

  return (
    <div className="settings-page">
      <header className="settings-header">
        <div className="settings-title">
          <button
            type="button"
            className={sidebarOpen ? 'icon-button active' : 'icon-button'}
            onClick={onToggleSidebar}
            title={sidebarOpen ? '收起项目侧边栏（Ctrl+B）' : '展开项目侧边栏（Ctrl+B）'}
            aria-label={sidebarOpen ? '收起项目侧边栏' : '展开项目侧边栏'}
            aria-expanded={sidebarOpen}
          >
            <SidebarIcon />
          </button>
          <div className="title-block">
            <h1>设置</h1>
            <p className="subtitle">应用级偏好，保存在应用数据目录；不会写入任何被登记的项目。</p>
          </div>
        </div>
      </header>

      <section className="settings-group" aria-labelledby="settings-editor-title">
        <h2 id="settings-editor-title">编辑器</h2>
        <p className="hint">
          用于文件树右键菜单里的「用指定编辑器打开」。未设置时该项不可用，「用默认程序打开」不受影响。
        </p>
        <div className="settings-row">
          <span className="settings-value" title={editorPath ?? undefined}>
            {editorLabel(editorPath)}
          </span>
          <button type="button" onClick={onConfigureEditor}>
            {editorPath === null ? '设置编辑器…' : '更换…'}
          </button>
          {editorPath !== null ? (
            <button
              type="button"
              className="editor-clear"
              onClick={onClearEditor}
              title="清空已设置的编辑器，回到未设置（「用默认程序打开」不受影响）"
            >
              清空
            </button>
          ) : null}
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-terminal-title">
        <h2 id="settings-terminal-title">终端</h2>
        <p className="hint">新建终端时使用的 Shell；选择本机不存在的程序时按自动探测的顺序回退。</p>
        {info !== null && info.platform !== 'win32' ? (
          <p className="hint">当前平台不是 Windows，Shell 选择本机不适用，终端按 $SHELL 启动。</p>
        ) : null}
        <div className="settings-row">
          <label className="field">
            <span>默认 Shell</span>
            <select value={defaultShell} onChange={handleShellChange}>
              {SHELL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-startup-title">
        <h2 id="settings-startup-title">启动</h2>
        <label
          className="pref-toggle"
          title="开启后启动直接进入上次活跃的项目；目录不可用或已移除登记时停留在项目库并说明原因。默认关闭。"
        >
          <input
            type="checkbox"
            checked={restoreLastProject}
            onChange={(event) => onSetRestoreLastProject(event.target.checked)}
          />
          <span>启动时恢复上次项目</span>
        </label>
        <p className="hint">恢复的是浏览位置，不恢复进程，也不附带写权限（未信任项目仍以只读浏览打开）。</p>
      </section>

      <section className="settings-group" aria-labelledby="settings-about-title">
        <h2 id="settings-about-title">关于</h2>
        <div className="settings-row">
          <span className="settings-value">
            {info === null
              ? '本地项目工作台'
              : `Electron ${info.electronVersion} · Chromium ${info.chromeVersion} · Node ${info.nodeVersion}`}
          </span>
        </div>
        <p className="hint">项目停留在原位置，不复制、不上传源码。</p>
      </section>
    </div>
  )
}
