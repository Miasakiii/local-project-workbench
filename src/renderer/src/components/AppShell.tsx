import type { AppInfo } from '@shared/types'
import type { ReactNode } from 'react'

interface AppShellProps {
  fatalError: string | null
  startupNotice: string | null
  info: AppInfo | null
  openProjectCount: number
  runningCount: number
  sidebar: ReactNode
  dialogs: ReactNode
  children: ReactNode
  onDismissFatalError: () => void
}

export function AppShell({
  fatalError,
  startupNotice,
  info,
  openProjectCount,
  runningCount,
  sidebar,
  dialogs,
  children,
  onDismissFatalError
}: AppShellProps): React.JSX.Element {
  return (
    <div className="app">
      {fatalError !== null ? (
        <div className="inline-error banner banner-dismissible" role="alert">
          <span className="banner-text">{fatalError}</span>
          <button type="button" className="banner-dismiss" onClick={onDismissFatalError} aria-label="关闭提示">
            ×
          </button>
        </div>
      ) : null}

      {startupNotice !== null ? <p className="inline-notice banner">{startupNotice}</p> : null}

      <div className="app-body">
        {sidebar}
        <div className="app-main">{children}</div>
      </div>

      {dialogs}

      <footer className="app-footer">
        <span>
          {info === null
            ? '本地项目工作台'
            : `Electron ${info.electronVersion} · Chromium ${info.chromeVersion} · Node ${info.nodeVersion}`}
        </span>
        <span className="hint">
          {openProjectCount > 0 ? `已打开 ${openProjectCount} 个项目 · ` : ''}
          {runningCount > 0 ? `${runningCount} 个终端运行中 · ` : ''}
          项目停留在原位置，不复制、不上传源码
        </span>
      </footer>
    </div>
  )
}
