import type { OperationNotice as OperationNoticeData } from './file-browser/utils'

/**
 * 文件操作结果提示条（成功或失败，含逐项明细）。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：纯展示组件，状态由父组件传入。
 */

interface OperationNoteProps {
  notice: OperationNoticeData
}

export function OperationNote({ notice }: OperationNoteProps): React.JSX.Element {
  return (
    <div className={notice.tone === 'error' ? 'file-operation-note error' : 'file-operation-note'} role="status">
      <strong>{notice.title}</strong>
      {notice.details.length > 0 ? (
        <ul>
          {notice.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
