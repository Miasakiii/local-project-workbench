import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  /** 启动目录；变化时重建会话 */
  cwd: string
  /** 会话建立或结束时回调，null 表示当前无活动会话 */
  onSessionChange: (sessionId: string | null) => void
}

/**
 * 终端视图（M0-1 原型）。
 *
 * 设计约束（设计稿第 6 章）：
 * - 终端组件只负责显示与输入转发，权限由主进程持有。
 * - 切换页面不终止会话；本组件的卸载会显式关闭会话，属用户主动操作。
 */
export function TerminalView({ cwd, onSessionChange }: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbackRef = useRef(onSessionChange)

  useEffect(() => {
    callbackRef.current = onSessionChange
  }, [onSessionChange])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 2000,
      convertEol: true,
      theme: {
        background: '#1b1f23',
        foreground: '#e6e6e6',
        cursor: '#e6e6e6'
      }
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    let sessionId: string | null = null
    let disposed = false

    const offData = window.workbench.terminal.onData((payload) => {
      if (payload.sessionId === sessionId) term.write(payload.data)
    })

    const offExit = window.workbench.terminal.onExit((payload) => {
      if (payload.sessionId !== sessionId) return
      term.write(`\r\n\x1b[90m[会话已结束，退出码 ${payload.exitCode}]\x1b[0m\r\n`)
      sessionId = null
      callbackRef.current(null)
    })

    const inputDisposable = term.onData((data) => {
      if (!sessionId) return
      void window.workbench.terminal.write({ sessionId, data })
    })

    void window.workbench.terminal
      .create({ cwd, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (disposed) {
          void window.workbench.terminal.dispose(result.sessionId)
          return
        }
        sessionId = result.sessionId
        callbackRef.current(result.sessionId)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        term.write(`\x1b[31m终端启动失败：${message}\x1b[0m\r\n`)
      })

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      if (sessionId) {
        void window.workbench.terminal.resize({
          sessionId,
          cols: term.cols,
          rows: term.rows
        })
      }
    })
    resizeObserver.observe(host)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      inputDisposable.dispose()
      offData()
      offExit()
      if (sessionId) void window.workbench.terminal.dispose(sessionId)
      term.dispose()
    }
  }, [cwd])

  return <div className="terminal-host" ref={hostRef} />
}
