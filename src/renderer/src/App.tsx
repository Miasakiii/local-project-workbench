import { useCallback, useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { TerminalView } from './components/TerminalView'

/**
 * M0-1 技术验证界面。
 *
 * 本阶段只验证一件事：真实终端在 Electron 中是否可用、稳定。
 * 项目库、文件浏览、只读 Git 等界面在 M1 及之后实现（见推进计划）。
 */
export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [cwd, setCwd] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [terminalKey, setTerminalKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.workbench.app
      .getInfo()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])

  const handleSelectDirectory = useCallback(async () => {
    try {
      const selected = await window.workbench.app.selectDirectory()
      if (!selected) return
      setError(null)
      setSessionId(null)
      setCwd(selected)
      setTerminalKey((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const handleRestart = useCallback(() => {
    if (!cwd) return
    setSessionId(null)
    setTerminalKey((value) => value + 1)
  }, [cwd])

  const handleSessionChange = useCallback((next: string | null) => {
    setSessionId(next)
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <div className="title-block">
          <h1>本地项目工作台</h1>
          <p className="subtitle">M0-1 技术验证 · 真实终端原型</p>
        </div>
        {info ? (
          <dl className="env">
            <div>
              <dt>Electron</dt>
              <dd>{info.electronVersion}</dd>
            </div>
            <div>
              <dt>Node</dt>
              <dd>{info.nodeVersion}</dd>
            </div>
            <div>
              <dt>Chromium</dt>
              <dd>{info.chromeVersion}</dd>
            </div>
          </dl>
        ) : null}
      </header>

      <section className="toolbar">
        <button type="button" className="primary" onClick={handleSelectDirectory}>
          选择项目目录
        </button>
        <button type="button" onClick={handleRestart} disabled={!cwd}>
          重开会话
        </button>
        <div className="path-field">
          <span className="label">启动目录</span>
          <code>{cwd ?? '尚未选择'}</code>
        </div>
        <span className={sessionId ? 'badge badge-live' : 'badge'}>
          {sessionId ? '会话运行中' : '无活动会话'}
        </span>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <main className="terminal-area">
        {cwd ? (
          <TerminalView key={terminalKey} cwd={cwd} onSessionChange={handleSessionChange} />
        ) : (
          <div className="empty">
            <p>尚未选择项目目录</p>
            <p className="hint">点击「选择项目目录」以启动一个真实终端会话</p>
          </div>
        )}
      </main>
    </div>
  )
}
