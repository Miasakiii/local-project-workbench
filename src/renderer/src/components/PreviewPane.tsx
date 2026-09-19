import type { AssetReadResult, FilePreview } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { MarkdownPreview } from './MarkdownPreview'

interface PreviewPaneProps {
  projectId: string
  preview: FilePreview | null
  loading: boolean
  onNavigateProjectPath: (relativePath: string) => void
  /** 清除当前选择（用于文件已被删除后返回目录） */
  onDismiss?: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 只读预览面板（设计稿 4.2／4.3，M1-4）。
 *
 * 各类结果分别呈现：Markdown、纯文本、代码（含行号）、图片、不支持、错误。
 * 不提供保存入口；不执行文档内容；图片按需经主进程换取 data URL。
 */
export function PreviewPane({
  projectId,
  preview,
  loading,
  onNavigateProjectPath,
  onDismiss
}: PreviewPaneProps): React.JSX.Element {
  const [oversizedImage, setOversizedImage] = useState<AssetReadResult | null>(null)
  const [loadingOversized, setLoadingOversized] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: preview?.relativePath 是刻意的触发依赖——效果体只做状态复位，但换文件时必须重置大图读取结果
  useEffect(() => {
    setOversizedImage(null)
  }, [preview?.relativePath])

  const loadOversized = useCallback(async () => {
    if (preview === null) return
    setLoadingOversized(true)
    try {
      const result = await window.workbench.file.readAsset({
        projectId,
        relativePath: preview.relativePath,
        allowOversized: true
      })
      setOversizedImage(result)
    } finally {
      setLoadingOversized(false)
    }
  }, [projectId, preview])

  const openExternally = useCallback(async () => {
    if (preview === null) return
    await window.workbench.system.openPath({ projectId, relativePath: preview.relativePath })
  }, [projectId, preview])

  if (loading) {
    return (
      <div className="preview-pane">
        <div className="preview-empty">正在读取…</div>
      </div>
    )
  }

  if (preview === null) {
    return (
      <div className="preview-pane">
        <div className="preview-empty">
          <p>未选择文件</p>
          <p className="hint">在左侧列表中双击文件即可只读预览</p>
        </div>
      </div>
    )
  }

  const header = (
    <header className="preview-header">
      <div className="preview-title">
        <strong>{preview.name}</strong>
        <code>{preview.relativePath}</code>
      </div>
      <div className="preview-meta">
        {preview.language !== null ? <span className="chip">{preview.language}</span> : null}
        <span className="chip">{formatBytes(preview.size)}</span>
        {preview.lineCount !== null ? <span className="chip">{preview.lineCount} 行</span> : null}
        <button type="button" onClick={() => void openExternally()}>
          用默认程序打开
        </button>
      </div>
    </header>
  )

  const body = (): React.JSX.Element => {
    switch (preview.kind) {
      case 'markdown': {
        const document = preview.markdown
        if (document === null) {
          return <div className="preview-empty">Markdown 渲染结果不可用。</div>
        }
        return (
          <MarkdownPreview projectId={projectId} document={document} onNavigateProjectPath={onNavigateProjectPath} />
        )
      }

      case 'code':
        return (
          <div className="code-view">
            {preview.message !== null ? <p className="inline-warning">{preview.message}</p> : null}
            {preview.truncated ? <p className="inline-warning">文件超过 5 MB，仅显示前 5 MB 内容。</p> : null}
            <pre className="code-block">
              <code
                // biome-ignore lint/security/noDangerouslySetInnerHtml: 高亮结果由主进程生成，只包含已转义的 span 与文本
                dangerouslySetInnerHTML={{ __html: preview.highlightedHtml ?? '' }}
              />
            </pre>
          </div>
        )

      case 'text':
        return (
          <div className="text-view">
            {preview.message !== null ? <p className="inline-warning">{preview.message}</p> : null}
            {preview.truncated ? <p className="inline-warning">文件超过 5 MB，仅显示前 5 MB 内容。</p> : null}
            <pre className="text-block">{preview.text ?? ''}</pre>
          </div>
        )

      case 'image': {
        const asset = oversizedImage ?? preview.image
        if (asset !== null && asset.status === 'ok' && asset.dataUrl !== null) {
          return (
            <div className="image-view">
              <img src={asset.dataUrl} alt={preview.name} />
              <p className="hint">
                {asset.mime} · {formatBytes(asset.bytes)}
              </p>
            </div>
          )
        }
        return (
          <div className="preview-empty">
            <p>{asset?.message ?? '图片无法预览'}</p>
            {asset?.status === 'too-large' ? (
              <button type="button" onClick={() => void loadOversized()} disabled={loadingOversized}>
                {loadingOversized ? '正在加载…' : '仍然加载（可能较慢）'}
              </button>
            ) : null}
            <button type="button" onClick={() => void openExternally()}>
              用默认程序打开
            </button>
          </div>
        )
      }

      case 'unsupported':
      case 'error': {
        // 文件被删除时保留提示页，提供返回目录（设计稿 5.1）
        const missing = /不存在|已被移动|ENOENT/.test(preview.message ?? '')
        return (
          <div className="preview-empty">
            <p>{missing ? '该文件已不在磁盘上' : (preview.message ?? '该文件无法预览')}</p>
            {missing ? <p className="hint">文件可能已被外部程序移动或删除。可返回目录重新选择。</p> : null}
            {missing && onDismiss !== undefined ? (
              <button type="button" className="primary" onClick={onDismiss}>
                返回目录
              </button>
            ) : (
              <button type="button" onClick={() => void openExternally()}>
                用默认程序打开
              </button>
            )}
          </div>
        )
      }
    }
  }

  return (
    <div className="preview-pane">
      {header}
      <div className="preview-body">{body()}</div>
    </div>
  )
}
