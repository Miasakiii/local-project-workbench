import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import {
  type FontSizeStorage,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_EVENT,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_MIN_CONTRAST_RATIO,
  TERMINAL_SCROLLBACK,
  TERMINAL_THEME,
  clampTerminalFontSize,
  readTerminalFontSize,
  stepTerminalFontSize,
  writeTerminalFontSize
} from './terminal-appearance'
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

/** 字号偏好存本地存储；隐私模式或存储被禁用时访问会抛异常，此时只有本次会话生效。 */
function resolveFontSizeStorage(): FontSizeStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * 终端视图。
 *
 * 设计约束（设计稿第 6 章）：
 * - 终端组件只负责显示与输入转发，权限由主进程持有。
 * - 切换项目、页面或收起面板都不终止进程；收起只改变可见性。
 * - 会话属于创建它的项目，本组件不向会话静默发送 cd。
 * - 回滚缓冲由本组件负责（主进程不保留输出内容）。
 *
 * 可读性基线集中在 `terminal-appearance`：字体回退链（中文不能掉到宋体）、
 * 最小对比度（CLI 自己输出的暗灰由 xterm 自动提亮）、字号与行距。
 * Ctrl+滚轮可临时缩放字号，偏好写本地存储并广播给同窗口的其它终端。
 */
export function TerminalView({
  projectId,
  relativePath,
  visible,
  onSessionChange,
  shell
}: TerminalViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbackRef = useRef(onSessionChange)
  const visibleRef = useRef(visible)
  /** 选中的 shell；仅在创建会话时读取，切换不重建会话（入 ref 不入 effect 依赖） */
  const shellRef = useRef<string | undefined>(shell !== undefined && shell.length > 0 ? shell : undefined)

  useEffect(() => {
    callbackRef.current = onSessionChange
  }, [onSessionChange])

  useEffect(() => {
    // 面板由隐藏转为可见时，宿主尺寸从 0 变为实际尺寸，ResizeObserver 会触发校正
    visibleRef.current = visible
  }, [visible])

  useEffect(() => {
    shellRef.current = shell !== undefined && shell.length > 0 ? shell : undefined
  }, [shell])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const storage = resolveFontSizeStorage()
    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: readTerminalFontSize(storage),
      lineHeight: TERMINAL_LINE_HEIGHT,
      letterSpacing: TERMINAL_LETTER_SPACING,
      fontWeight: '400',
      fontWeightBold: '600',
      minimumContrastRatio: TERMINAL_MIN_CONTRAST_RATIO,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: TERMINAL_SCROLLBACK,
      convertEol: true,
      theme: TERMINAL_THEME
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    let sessionId: string | null = null
    let disposed = false
    let fontSizeTimer = 0

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

    const currentFontSize = (): number => clampTerminalFontSize(term.options.fontSize)

    /**
     * 应用字号并同步 PTY 尺寸。返回是否真的发生了变化。
     *
     * xterm 在选项变更后的下一拍才重算 cell 尺寸，立刻 fit 会沿用旧尺寸；
     * 因此延后一拍校正，避免列宽与 PTY 不一致（长行会错位）。
     */
    const applyFontSize = (size: number): boolean => {
      const next = writeTerminalFontSize(storage, size)
      if (term.options.fontSize === next) return false
      term.options.fontSize = next
      if (fontSizeTimer !== 0) window.clearTimeout(fontSizeTimer)
      fontSizeTimer = window.setTimeout(() => {
        fontSizeTimer = 0
        fitIfVisible()
      }, 0)
      return true
    }

    /** Ctrl+滚轮缩放：与常见终端（VS Code 等）一致，且不劫持普通滚轮滚动。 */
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1
      if (!applyFontSize(stepTerminalFontSize(currentFontSize(), direction))) return
      window.dispatchEvent(new CustomEvent(TERMINAL_FONT_SIZE_EVENT, { detail: currentFontSize() }))
    }

    /** 同窗口其它标签缩放后一并跟随，避免切标签时字号忽大忽小。 */
    const onExternalFontSize = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail
      if (typeof detail !== 'number') return
      applyFontSize(detail)
    }

    host.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener(TERMINAL_FONT_SIZE_EVENT, onExternalFontSize)

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
      .create({ projectId, relativePath, cols: term.cols, rows: term.rows, shell: shellRef.current })
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
      window.clearTimeout(fontSizeTimer)
      host.removeEventListener('wheel', onWheel)
      window.removeEventListener(TERMINAL_FONT_SIZE_EVENT, onExternalFontSize)
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
