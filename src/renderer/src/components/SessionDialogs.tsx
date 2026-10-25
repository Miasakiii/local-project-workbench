import type { RefObject } from 'react'

interface SessionDialogsProps {
  closeProjectName: string | null
  pendingQuit: number | null
  closeDialogRef: RefObject<HTMLDivElement | null>
  quitDialogRef: RefObject<HTMLDivElement | null>
  onCancelClose: () => void
  onConfirmClose: () => void
  onCancelQuit: () => void
  onConfirmQuit: () => void
}

export function SessionDialogs({
  closeProjectName,
  pendingQuit,
  closeDialogRef,
  quitDialogRef,
  onCancelClose,
  onConfirmClose,
  onCancelQuit,
  onConfirmQuit
}: SessionDialogsProps): React.JSX.Element {
  return (
    <>
      {closeProjectName !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="close-sessions-title">
          <div className="modal" ref={closeDialogRef}>
            <h2 id="close-sessions-title">「{closeProjectName}」的终端会话正在运行</h2>
            <p>关闭项目会结束该项目的终端会话，正在其中运行的命令会被中断。</p>
            <p className="hint">不承诺恢复原来的进程；重新打开项目后需要重新执行命令。</p>
            <div className="modal-actions">
              <button type="button" onClick={onCancelClose}>
                取消
              </button>
              <button type="button" className="danger" onClick={onConfirmClose}>
                结束会话并关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingQuit !== null ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="quit-sessions-title">
          <div className="modal" ref={quitDialogRef}>
            <h2 id="quit-sessions-title">还有 {pendingQuit} 个终端会话正在运行</h2>
            <p>退出应用会结束这些会话，正在其中运行的命令会被中断。</p>
            <p className="hint">不承诺恢复原来的进程；下次启动后需要重新执行命令。</p>
            <div className="modal-actions">
              <button type="button" onClick={onCancelQuit}>
                取消
              </button>
              <button type="button" className="danger" onClick={onConfirmQuit}>
                结束会话并退出
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
