import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import {
  clampTerminalFontSize,
  type FontSizeStorage,
  readTerminalFontSize,
  stepTerminalFontSize,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_EVENT,
  TERMINAL_LETTER_SPACING,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_MIN_CONTRAST_RATIO,
  TERMINAL_SCROLLBACK,
  TERMINAL_THEME,
  writeTerminalFontSize
} from '../components/terminal-appearance'

interface UseTerminalSessionOptions {
  projectId: string
  relativePath: string
  visible: boolean
  onSessionChange: (sessionId: string | null) => void
  shell?: string
}

function resolveFontSizeStorage(): FontSizeStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function useTerminalSession({
  projectId,
  relativePath,
  visible,
  onSessionChange,
  shell
}: UseTerminalSessionOptions): React.RefObject<HTMLDivElement | null> {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbackRef = useRef(onSessionChange)
  const visibleRef = useRef(visible)
  const shellRef = useRef<string | undefined>(shell !== undefined && shell.length > 0 ? shell : undefined)

  useEffect(() => {
    callbackRef.current = onSessionChange
  }, [onSessionChange])

  useEffect(() => {
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

    const fitIfVisible = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      if (sessionId !== null) {
        void window.workbench.terminal.resize({ sessionId, cols: term.cols, rows: term.rows })
      }
    }

    fitIfVisible()

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

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1
      if (!applyFontSize(stepTerminalFontSize(currentFontSize(), direction))) return
      window.dispatchEvent(new CustomEvent(TERMINAL_FONT_SIZE_EVENT, { detail: currentFontSize() }))
    }

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
  }, [projectId, relativePath])

  return hostRef
}
