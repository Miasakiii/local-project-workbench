import { useTerminalSession } from '../hooks/useTerminalSession'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  projectId: string
  /** 启动目录（相对项目根）；空串表示项目根 */
  relativePath: string
  /** 面板是否可见。收起时保持会话运行，不重建进程 */
  visible: boolean
  /** 会话建立或结束时回调，null 表示当前无活动会话 */
  onSessionChange: (sessionId: string | null) => void
  /** 可选：指定 shell（pwsh／powershell／cmd）；仅在创建会话时读取，切换不重建 */
  shell?: string
}

export function TerminalView({
  projectId,
  relativePath,
  visible,
  onSessionChange,
  shell
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useTerminalSession({ projectId, relativePath, visible, onSessionChange, shell })
  return <div className="terminal-host" ref={hostRef} />
}
