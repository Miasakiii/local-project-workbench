import type { TerminalPreferences } from '@shared/terminal-settings'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import {
  resolveTerminalFontFamily,
  stepTerminalFontSize,
  TERMINAL_SEARCH_DECORATIONS,
  TERMINAL_THEME
} from '../components/terminal-appearance'
import {
  matchTerminalShortcut,
  TerminalEarlyEventsBuffer,
  type TerminalSearchHandle,
  type TerminalSearchResults,
  type TerminalSessionState,
  type TerminalShortcut
} from '../terminal-model'

interface UseTerminalSessionOptions {
  projectId: string
  relativePath: string
  visible: boolean
  settings: TerminalPreferences
  onSessionStateChange: (state: TerminalSessionState) => void
  onSearchResults: (results: TerminalSearchResults) => void
  onSearchReady: (handle: TerminalSearchHandle | null) => void
  onShortcut: (shortcut: TerminalShortcut) => void
  onFontSizeChange: (size: number) => void
  onLinkOpen: (uri: string) => void
  /** 可选：指定 shell（pwsh／powershell／cmd）；仅在创建会话时读取 */
  shell?: string
}

/**
 * 一个标签对应一个 xterm 实例与一个 PTY 会话。
 *
 * 会话状态机：idle → starting → running → exited / failed。状态只经
 * `onSessionStateChange` 上报，标签的稳定身份由外层的 key 决定；重建会话通过
 * epoch 触发组件重挂载，不在这里偷偷重试。
 *
 * 外观设置可热应用（字体、字号、行距、光标、对比度、回滚、复制即选）；
 * 默认 Shell 与启动目录只影响新建会话，这里绝不因设置变化重建进程。
 */
export function useTerminalSession(options: UseTerminalSessionOptions): React.RefObject<HTMLDivElement | null> {
  const hostRef = useRef<HTMLDivElement>(null)
  const optionsRef = useRef(options)
  const applyAppearanceRef = useRef<(() => void) | null>(null)
  const fitRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    optionsRef.current = options
  }, [options])

  // biome-ignore lint/correctness/useExhaustiveDependencies: 项目或启动目录变化意味着会话归属失效，必须重建；实际读取走 optionsRef，避免外观设置触发重建
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const initial = optionsRef.current.settings
    const term = new Terminal({
      // @xterm/addon-search 的高亮通过 registerDecoration 实现，属于官方标记的 proposed API；
      // 不开启时搜索会抛错并连带整个面板失效。这里只开放该开关，不调用其它 proposed 能力。
      allowProposedApi: true,
      fontFamily: resolveTerminalFontFamily(initial.fontFamily),
      fontSize: initial.fontSize,
      lineHeight: initial.lineHeight,
      letterSpacing: initial.letterSpacing,
      fontWeight: '400',
      fontWeightBold: '600',
      minimumContrastRatio: initial.minContrastRatio,
      cursorBlink: initial.cursorBlink,
      cursorStyle: initial.cursorStyle,
      cursorWidth: 2,
      scrollback: initial.scrollback,
      convertEol: true,
      theme: TERMINAL_THEME
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    const search = new SearchAddon()
    term.loadAddon(search)

    const links = new WebLinksAddon((event, uri) => {
      event.preventDefault()
      optionsRef.current.onLinkOpen(uri)
    })
    term.loadAddon(links)

    term.open(host)

    // 生产态 CSP 禁止内联样式，而 DOM 渲染器靠内联 style 上色，ANSI 颜色会被丢弃。
    // WebGL 渲染器把颜色画进画布，不依赖内联样式；不可用时退回 DOM 渲染器，
    // 终端仍能工作，只是颜色与搜索高亮会退化。
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
      })
      term.loadAddon(webgl)
    } catch {
      // 无 WebGL（驱动或软件渲染不可用）时保持默认渲染器
    }

    let sessionId: string | null = null
    let shellPath: string | null = null
    let status: TerminalSessionState['status'] = 'idle'
    let exitCode: number | null = null
    let errorMessage: string | null = null
    let disposed = false
    let fitTimer = 0
    let appearanceTimer = 0
    const earlyEvents = new TerminalEarlyEventsBuffer()

    const report = (patch: Partial<TerminalSessionState>): void => {
      if (patch.status !== undefined) status = patch.status
      if (patch.sessionId !== undefined) sessionId = patch.sessionId
      if (patch.shell !== undefined) shellPath = patch.shell
      if (patch.exitCode !== undefined) exitCode = patch.exitCode
      if (patch.error !== undefined) errorMessage = patch.error
      if (disposed) return
      optionsRef.current.onSessionStateChange({
        status,
        sessionId,
        shell: shellPath,
        exitCode,
        error: errorMessage
      })
    }

    const fitIfVisible = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      if (sessionId !== null) {
        void window.workbench.terminal.resize({ sessionId, cols: term.cols, rows: term.rows })
      }
    }
    fitRef.current = fitIfVisible
    fitIfVisible()

    const scheduleFit = (): void => {
      if (!optionsRef.current.visible) return
      if (fitTimer !== 0) return
      fitTimer = window.setTimeout(() => {
        fitTimer = 0
        fitIfVisible()
      }, 60)
    }

    const searchHandle: TerminalSearchHandle = {
      findNext: (text, incremental = false) => {
        if (text.length === 0) {
          search.clearDecorations()
          return false
        }
        return search.findNext(text, {
          incremental,
          decorations: TERMINAL_SEARCH_DECORATIONS
        })
      },
      findPrevious: (text) => {
        if (text.length === 0) {
          search.clearDecorations()
          return false
        }
        return search.findPrevious(text, { decorations: TERMINAL_SEARCH_DECORATIONS })
      },
      clear: () => search.clearDecorations()
    }
    optionsRef.current.onSearchReady(searchHandle)

    const offSearchResults = search.onDidChangeResults((results) => {
      if (!disposed) optionsRef.current.onSearchResults(results)
    })

    const applyAppearance = (): void => {
      const current = optionsRef.current.settings
      term.options.fontFamily = resolveTerminalFontFamily(current.fontFamily)
      term.options.fontSize = current.fontSize
      term.options.lineHeight = current.lineHeight
      term.options.letterSpacing = current.letterSpacing
      term.options.cursorStyle = current.cursorStyle
      term.options.cursorBlink = current.cursorBlink
      term.options.minimumContrastRatio = current.minContrastRatio
      term.options.scrollback = current.scrollback
      if (appearanceTimer !== 0) window.clearTimeout(appearanceTimer)
      appearanceTimer = window.setTimeout(() => {
        appearanceTimer = 0
        fitIfVisible()
      }, 0)
    }
    applyAppearanceRef.current = applyAppearance

    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      const current = optionsRef.current.settings.fontSize
      const next = stepTerminalFontSize(current, event.deltaY < 0 ? 1 : -1)
      if (next === current) return
      // 乐观更新，保证连续滚轮每次都从最新字号起算；真实状态随设置更新回流。
      optionsRef.current = {
        ...optionsRef.current,
        settings: { ...optionsRef.current.settings, fontSize: next }
      }
      optionsRef.current.onFontSizeChange(next)
    }

    const onMouseUp = (): void => {
      if (!optionsRef.current.settings.copyOnSelect) return
      const selection = term.getSelection()
      if (selection.length === 0) return
      const clipboard = navigator.clipboard
      if (clipboard === undefined) return
      void clipboard.writeText(selection).catch(() => undefined)
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const shortcut = matchTerminalShortcut(event)
      if (shortcut === null) return true
      event.preventDefault()
      optionsRef.current.onShortcut(shortcut)
      return false
    })

    host.addEventListener('wheel', onWheel, { passive: false })
    host.addEventListener('mouseup', onMouseUp)

    const writeExitNotice = (exitCode: number): void => {
      term.write(`\r\n\x1b[90m[会话已结束，退出码 ${exitCode}]\x1b[0m\r\n`)
    }

    const offData = window.workbench.terminal.onData((payload) => {
      if (payload.sessionId === sessionId) {
        term.write(payload.data)
      } else if (sessionId === null) {
        earlyEvents.appendData(payload.sessionId, payload.data)
      }
    })

    const offExit = window.workbench.terminal.onExit((payload) => {
      if (payload.sessionId !== sessionId) {
        if (sessionId === null) earlyEvents.recordExit(payload.sessionId, payload)
        return
      }
      writeExitNotice(payload.exitCode)
      report({ status: 'exited', sessionId: null, exitCode: payload.exitCode, error: null })
    })

    const inputDisposable = term.onData((data) => {
      if (sessionId === null) return
      void window.workbench.terminal.write({ sessionId, data })
    })

    report({ status: 'starting', sessionId: null, shell: null, exitCode: null, error: null })
    void window.workbench.terminal
      .create({
        projectId: optionsRef.current.projectId,
        relativePath: optionsRef.current.relativePath,
        cols: term.cols,
        rows: term.rows,
        shell: optionsRef.current.shell
      })
      .then((result) => {
        if (disposed) {
          void window.workbench.terminal.dispose(result.sessionId)
          return
        }
        const early = earlyEvents.take(result.sessionId)
        if (early !== null) {
          for (const chunk of early.data) term.write(chunk)
          if (early.exit !== null) {
            writeExitNotice(early.exit.exitCode)
            report({
              status: 'exited',
              sessionId: null,
              shell: result.shell,
              exitCode: early.exit.exitCode,
              error: null
            })
            return
          }
        }
        report({ status: 'running', sessionId: result.sessionId, shell: result.shell, exitCode: null, error: null })
        fitIfVisible()
      })
      .catch((error: unknown) => {
        if (disposed) return
        earlyEvents.clear()
        const message = error instanceof Error ? error.message : String(error)
        term.write(`\x1b[31m终端启动失败：${message}\x1b[0m\r\n`)
        report({ status: 'failed', sessionId: null, shell: null, exitCode: null, error: message })
      })

    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(host)

    return () => {
      disposed = true
      earlyEvents.clear()
      window.clearTimeout(fitTimer)
      window.clearTimeout(appearanceTimer)
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('mouseup', onMouseUp)
      resizeObserver.disconnect()
      inputDisposable.dispose()
      offData()
      offExit()
      offSearchResults.dispose()
      optionsRef.current.onSearchReady(null)
      applyAppearanceRef.current = null
      fitRef.current = null
      if (sessionId !== null) void window.workbench.terminal.dispose(sessionId)
      term.dispose()
    }
  }, [options.projectId, options.relativePath])

  /** 外观设置热应用：只改 xterm 选项，不触碰进程与会话状态。 */
  // biome-ignore lint/correctness/useExhaustiveDependencies: settings 变化是唯一的触发源；应用函数经 ref 读取最新值
  useEffect(() => {
    applyAppearanceRef.current?.()
  }, [options.settings])

  /** 从隐藏切回可见时补一次测量；display:none 期间的尺寸变化不一定触发 ResizeObserver。 */
  useEffect(() => {
    if (!options.visible) return
    const timer = window.setTimeout(() => fitRef.current?.(), 60)
    return () => window.clearTimeout(timer)
  }, [options.visible])

  return hostRef
}
