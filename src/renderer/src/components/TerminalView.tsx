import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalViewProps {
  projectId: string
  /** 启动目录（相对项目根）；空串表示项目根 */
  relativePath: string
  /** 面板是否可见。收起时保持会话运行，不重建进程 */
  visible: boolean
  /** 会话建立或结束时回调，null 表示当前无活动会话 */
  onSessionChange: (sessionId: string | null) => void
}

/**
 * 终端视图。
 *
 * 设计约束（设计稿第 6 章）：
 * - 终端组件只负责显示与输入转发，权限由主进程持有。
 * - 切换项目、页面或收起面板都不终止进程；收起只改变可见性。
 * - 会话属于创建它的项目，本组件不向会话静默发送 cd。
 * - 回滚缓冲由本组件负责（主进程不保留输出内容）。
 */
export function TerminalView({
  projectId,
  relativePath,
  visible,
  onSessionChange
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbackRef = useRef(onSessionChange)
  const visibleRef = useRef(visible)

  useEffect(() => {
    callbackRef.current = onSessionChange
  }, [onSessionChange])

  useEffect(() => {
    // 面板由隐藏转为可见时，宿主尺寸从 0 变为实际尺寸，ResizeObserver 会触发校正
    visibleRef.current = visible
  }, [visible])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

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

    let sessionId: string | null = null
    let disposed = false

    /** 面板不可见时宿主尺寸为 0，此时不调整尺寸，避免把会话压成 1 行 */
    const fitIfVisible = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      if (sessionId !== null) {
        void window.workbench.terminal.resize({ sessionId, cols: term.cols, rows: term.rows })
      }
    }

    fitIfVisible()

    /**
     * 尺寸校正做去抖：拖拽面板边缘时 ResizeObserver 会连续触发，
     * 每次都 fit 并向主进程发 resize 会造成明显抖动与 IPC 洪泛。
     */
    let fitTimer = 0
    const scheduleFit = (): void => {
      if (!visibleRef.current) return
      if (fitTimer !== 0) return
      fitTimer = window.setTimeout(() => {
        fitTimer = 0
        fitIfVisible()
      }, 60)
    }

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
      if (sessionId === null) return
      void window.workbench.terminal.write({ sessionId, data })
    })

    void window.workbench.terminal
      .create({ projectId, relativePath, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (disposed) {
          void window.workbench.terminal.dispose(result.sessionId)
          return
        }
        sessionId = result.sessionId
        callbackRef.current(result.sessionId)
        fitIfVisible()
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        term.write(`\x1b[31m终端启动失败：${message}\x1b[0m\r\n`)
      })

    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(host)

    return () => {
      disposed = true
      window.clearTimeout(fitTimer)
      resizeObserver.disconnect()
      inputDisposable.dispose()
      offData()
      offExit()
      if (sessionId !== null) void window.workbench.terminal.dispose(sessionId)
      term.dispose()
    }
    // 仅在项目或启动目录变化时重建会话
  }, [projectId, relativePath])

  return <div className="terminal-host" ref={hostRef} />
}
