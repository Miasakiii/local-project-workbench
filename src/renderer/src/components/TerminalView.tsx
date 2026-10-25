import type { TerminalPreferences } from '@shared/terminal-settings'
import { useTerminalSession } from '../hooks/useTerminalSession'
import type {
  TerminalSearchHandle,
  TerminalSearchResults,
  TerminalSessionState,
  TerminalShortcut
} from '../terminal-model'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  projectId: string
  /** 启动目录（相对项目根）；空串表示项目根 */
  relativePath: string
  /** 面板是否可见。收起时保持会话运行，不重建进程 */
  visible: boolean
  settings: TerminalPreferences
  /** 会话状态变化；starting/running/exited/failed 由 hook 上报 */
  onSessionStateChange: (state: TerminalSessionState) => void
  onSearchResults: (results: TerminalSearchResults) => void
  onSearchReady: (handle: TerminalSearchHandle | null) => void
  onShortcut: (shortcut: TerminalShortcut) => void
  onFontSizeChange: (size: number) => void
  onLinkOpen: (uri: string) => void
  /** 可选：指定 shell（pwsh／powershell／cmd）；仅在创建会话时读取 */
  shell?: string
}

export function TerminalView(props: TerminalViewProps): React.JSX.Element {
  const hostRef = useTerminalSession(props)
  return <div className="terminal-host" ref={hostRef} />
}
