import type { TerminalPreferences } from '@shared/terminal-settings'
import type { AppInfo } from '@shared/types'
import { SidebarIcon } from '../components/icons'

export interface SettingsPageProps {
  info: AppInfo | null
  sidebarOpen: boolean
  restoreLastProject: boolean
  editorPath: string | null
  terminal: TerminalPreferences
  onToggleSidebar: () => void
  onSetRestoreLastProject: (enabled: boolean) => void
  onConfigureEditor: () => void
  onClearEditor: () => void
  onTerminalChange: (patch: Partial<TerminalPreferences>) => void
}

interface SelectOption {
  value: string
  label: string
}

const SHELL_OPTIONS: SelectOption[] = [
  { value: '', label: '自动探测' },
  { value: 'pwsh', label: 'pwsh（PowerShell 7）' },
  { value: 'powershell', label: 'Windows PowerShell' },
  { value: 'cmd', label: '命令提示符（cmd）' }
]

const STARTUP_OPTIONS: SelectOption[] = [
  { value: 'root', label: '项目根目录' },
  { value: 'current', label: '当前文件所在目录' }
]

const FONT_OPTIONS: SelectOption[] = [
  { value: 'default', label: '默认（Cascadia → Consolas → 中文回退）' },
  { value: 'cascadia', label: 'Cascadia Mono' },
  { value: 'consolas', label: 'Consolas' }
]

const CURSOR_OPTIONS: SelectOption[] = [
  { value: 'bar', label: '竖线' },
  { value: 'block', label: '方块' },
  { value: 'underline', label: '下划线' }
]

const LINK_OPTIONS: SelectOption[] = [
  { value: 'ask', label: '每次询问' },
  { value: 'always', label: '直接打开' },
  { value: 'off', label: '不打开' }
]

const FONT_SIZE_VALUES = Array.from({ length: 15 }, (_, index) => 10 + index)
const LINE_HEIGHT_VALUES = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2]
const LETTER_SPACING_VALUES = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.5, 2]
const CONTRAST_VALUES = [1, 3, 4.5, 7, 10, 15, 21]
const SCROLLBACK_VALUES = [2000, 5000, 10000, 20000, 50000, 100000]

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/** 把当前值并入候选，防止手改配置得到的合法非预设值在下拉框里显示为空。 */
function numberOptions(values: readonly number[], current: number, suffix = ''): SelectOption[] {
  const merged = [...new Set([...values, current])].sort((left, right) => left - right)
  return merged.map((value) => ({ value: String(value), label: `${formatDecimal(value)}${suffix}` }))
}

function SettingsSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function SettingsToggle({
  label,
  checked,
  title,
  onChange
}: {
  label: string
  checked: boolean
  title: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="pref-toggle" title={title}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function editorLabel(editorPath: string | null): string {
  if (editorPath === null) return '未设置'
  return editorPath.split(/[\\/]/).pop() ?? editorPath
}

export function SettingsPage({
  info,
  sidebarOpen,
  restoreLastProject,
  editorPath,
  terminal,
  onToggleSidebar,
  onSetRestoreLastProject,
  onConfigureEditor,
  onClearEditor,
  onTerminalChange
}: SettingsPageProps): React.JSX.Element {
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

      <div className="settings-groups">
        <section className="settings-group" aria-labelledby="settings-general-title">
          <h2 id="settings-general-title">通用</h2>
          <SettingsToggle
            label="启动时恢复上次项目"
            checked={restoreLastProject}
            title="开启后启动直接进入上次活跃的项目；目录不可用或已移除登记时停留在项目库并说明原因。默认关闭。"
            onChange={onSetRestoreLastProject}
          />
          <p className="hint">恢复的是浏览位置，不恢复进程，也不附带写权限（未信任项目仍以只读浏览打开）。</p>
        </section>

        <section className="settings-group" aria-labelledby="settings-editor-title">
          <h2 id="settings-editor-title">编辑器</h2>
          <p className="hint">
            用于文件树右键菜单里的「用指定编辑器打开」。Windows 仅支持 .exe；未设置时该项不可用，「用默认程序打开」不受影响。
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

        <section className="settings-group settings-group-wide" aria-labelledby="settings-terminal-title">
          <h2 id="settings-terminal-title">终端</h2>
          <p className="hint">
            外观设置立即应用到已打开的终端；默认 Shell 与启动目录只影响之后新建的会话。终端进程不会因改设置而重建。
          </p>

          <div className="settings-subsection">
            <h3>会话</h3>
            <div className="settings-grid">
              <SettingsSelect
                label="默认 Shell"
                value={terminal.defaultShell}
                options={SHELL_OPTIONS}
                onChange={(value) => onTerminalChange({ defaultShell: value })}
              />
              <SettingsSelect
                label="新建标签的启动目录"
                value={terminal.startupDirectory}
                options={STARTUP_OPTIONS}
                onChange={(value) => onTerminalChange({ startupDirectory: value === 'current' ? 'current' : 'root' })}
              />
            </div>
            {info !== null && info.platform !== 'win32' ? (
              <p className="hint">当前平台不是 Windows，Shell 选择本机不适用，终端按 $SHELL 启动。</p>
            ) : null}
            <p className="hint">「当前文件所在目录」取当前预览文件所在的文件夹；没有可定位的文件时使用项目根目录。</p>
          </div>

          <div className="settings-subsection">
            <h3>外观</h3>
            <div className="settings-grid">
              <SettingsSelect
                label="字体"
                value={terminal.fontFamily}
                options={FONT_OPTIONS}
                onChange={(value) =>
                  onTerminalChange({ fontFamily: value === 'cascadia' || value === 'consolas' ? value : 'default' })
                }
              />
              <SettingsSelect
                label="字号"
                value={String(terminal.fontSize)}
                options={numberOptions(FONT_SIZE_VALUES, terminal.fontSize, 'px')}
                onChange={(value) => onTerminalChange({ fontSize: Number(value) })}
              />
              <SettingsSelect
                label="行距"
                value={String(terminal.lineHeight)}
                options={numberOptions(LINE_HEIGHT_VALUES, terminal.lineHeight)}
                onChange={(value) => onTerminalChange({ lineHeight: Number(value) })}
              />
              <SettingsSelect
                label="字间距"
                value={String(terminal.letterSpacing)}
                options={numberOptions(LETTER_SPACING_VALUES, terminal.letterSpacing, 'px')}
                onChange={(value) => onTerminalChange({ letterSpacing: Number(value) })}
              />
              <SettingsSelect
                label="光标样式"
                value={terminal.cursorStyle}
                options={CURSOR_OPTIONS}
                onChange={(value) =>
                  onTerminalChange({
                    cursorStyle: value === 'block' || value === 'underline' ? value : 'bar'
                  })
                }
              />
              <SettingsSelect
                label="最小对比度（WCAG）"
                value={String(terminal.minContrastRatio)}
                options={numberOptions(CONTRAST_VALUES, terminal.minContrastRatio)}
                onChange={(value) => onTerminalChange({ minContrastRatio: Number(value) })}
              />
              <SettingsSelect
                label="滚动回看行数"
                value={String(terminal.scrollback)}
                options={numberOptions(SCROLLBACK_VALUES, terminal.scrollback)}
                onChange={(value) => onTerminalChange({ scrollback: Number(value) })}
              />
            </div>
            <div className="settings-toggles">
              <SettingsToggle
                label="光标闪烁"
                checked={terminal.cursorBlink}
                title="关闭后光标常亮，便于在录屏或长时间阅读时保持稳定。"
                onChange={(checked) => onTerminalChange({ cursorBlink: checked })}
              />
            </div>
            <p className="hint">最小对比度 7 为 WCAG AAA；低于该值的前景色会由 xterm 自动提亮。</p>
          </div>

          <div className="settings-subsection">
            <h3>行为</h3>
            <div className="settings-grid">
              <SettingsSelect
                label="链接打开行为"
                value={terminal.linkOpenBehavior}
                options={LINK_OPTIONS}
                onChange={(value) =>
                  onTerminalChange({
                    linkOpenBehavior: value === 'always' || value === 'off' ? value : 'ask'
                  })
                }
              />
            </div>
            <div className="settings-toggles">
              <SettingsToggle
                label="复制即选"
                checked={terminal.copyOnSelect}
                title="开启后，在终端中划选文本并在同一位置松开鼠标即写入系统剪贴板。"
                onChange={(checked) => onTerminalChange({ copyOnSelect: checked })}
              />
            </div>
            <p className="hint">
              链接只允许 http/https，并经主进程通道交给系统浏览器；终端不执行链接内容。「每次询问」会先在应用内确认。
            </p>
          </div>
        </section>

        <section className="settings-group settings-group-wide" aria-labelledby="settings-shortcuts-title">
          <h2 id="settings-shortcuts-title">快捷键</h2>
          <p className="hint">终端快捷键在终端面板内生效；Ctrl+`（反引号）在项目页任意位置可用。</p>
          <dl className="shortcut-list">
            <div>
              <dt>展开 / 收起终端</dt>
              <dd>
                <kbd>Ctrl</kbd> + <kbd>`</kbd>
              </dd>
            </div>
            <div>
              <dt>新建标签</dt>
              <dd>
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>T</kbd>
              </dd>
            </div>
            <div>
              <dt>切换标签</dt>
              <dd>
                <kbd>Ctrl</kbd> + <kbd>Tab</kbd> / <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd>
              </dd>
            </div>
            <div>
              <dt>关闭标签（运行中先确认）</dt>
              <dd>
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>W</kbd>
              </dd>
            </div>
            <div>
              <dt>搜索终端输出</dt>
              <dd>
                <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd>
              </dd>
            </div>
            <div>
              <dt>搜索上一个 / 下一个</dt>
              <dd>
                <kbd>Enter</kbd> / <kbd>Shift</kbd> + <kbd>Enter</kbd>
              </dd>
            </div>
            <div>
              <dt>关闭搜索或对话框</dt>
              <dd>
                <kbd>Esc</kbd>
              </dd>
            </div>
            <div>
              <dt>调整终端字号</dt>
              <dd>
                <kbd>Ctrl</kbd> + <kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd>，或 <kbd>Ctrl</kbd> + 滚轮
              </dd>
            </div>
            <div>
              <dt>展开 / 收起项目侧边栏</dt>
              <dd>
                <kbd>Ctrl</kbd> + <kbd>B</kbd>
              </dd>
            </div>
          </dl>
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
    </div>
  )
}
