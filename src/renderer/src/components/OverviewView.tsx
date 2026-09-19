import type { FileEntry, FilePreview, ReadmeDetection } from '@shared/types'
import { useCallback, useEffect, useState } from 'react'
import { MarkdownPreview } from './MarkdownPreview'

interface OverviewViewProps {
  projectId: string
  /** 用户指定的介绍文件；null 表示自动识别 */
  readmePath: string | null
  onReadmePathChange: (relativePath: string | null) => void
  onNavigateProjectPath: (relativePath: string) => void
}

/**
 * 项目概览页（设计稿 4.1／4.2，M1-5／M1-6）。
 *
 * 规则：
 * - 优先使用用户指定的介绍文件；否则按 README.md → README.markdown → README.txt →
 *   无扩展名 README 的顺序在根目录、docs、.github 中查找（大小写兼容）。
 * - 存在多语言变体时提供切换入口，但不覆盖用户已选版本。
 * - 没有 README 时显示空状态与选择入口，**不擅自生成或写入文件**。
 */
export function OverviewView({
  projectId,
  readmePath,
  onReadmePathChange,
  onNavigateProjectPath
}: OverviewViewProps): React.JSX.Element {
  const [detection, setDetection] = useState<ReadmeDetection | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [picking, setPicking] = useState(false)
  const [candidates, setCandidates] = useState<FileEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: readmePath 是刻意的触发依赖——用户切换 README 变体后必须重新探测
  useEffect(() => {
    let cancelled = false
    void window.workbench.project
      .readme({ projectId })
      .then((result) => {
        if (cancelled) return
        setDetection(result)
        setSelected(result.selected)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, readmePath])

  useEffect(() => {
    if (selected === null) {
      setPreview(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.workbench.file
      .preview({ projectId, relativePath: selected })
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setPreview(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, selected])

  const openPicker = useCallback(async () => {
    setPicking(true)
    try {
      const listing = await window.workbench.file.list({ projectId, relativePath: '' })
      setCandidates(listing.entries.filter((entry) => entry.kind === 'file'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [projectId])

  const choose = useCallback(
    (entry: FileEntry) => {
      setPicking(false)
      setSelected(entry.relativePath)
      onReadmePathChange(entry.relativePath)
    },
    [onReadmePathChange]
  )

  const resetToAuto = useCallback(() => {
    onReadmePathChange(null)
  }, [onReadmePathChange])

  const variants = detection?.variants ?? []
  const locationLabel =
    detection?.location === 'docs' ? 'docs 目录' : detection?.location === '.github' ? '.github 目录' : '项目根目录'

  if (detection !== null && detection.selected === null) {
    return (
      <div className="overview-view">
        <div className="empty-state">
          <h2>没有找到介绍文件</h2>
          <p>
            已在项目根目录、docs 与 .github 中按 README.md、README.markdown、README.txt、README 的顺序查找，均未找到。
          </p>
          <p className="hint">应用不会自动创建或写入任何文件。</p>
          <div className="empty-actions">
            <button type="button" className="primary" onClick={() => void openPicker()}>
              选择介绍文件
            </button>
            <button type="button" onClick={() => void window.workbench.project.reveal({ projectId })}>
              在资源管理器中打开
            </button>
          </div>
          {picking ? (
            <div className="file-picker">
              {candidates.length === 0 ? <p className="hint">项目根目录没有可选择的文件。</p> : null}
              {candidates.map((entry) => (
                <button type="button" key={entry.relativePath} onClick={() => choose(entry)}>
                  {entry.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="overview-view">
      <div className="overview-toolbar">
        <div className="readme-meta">
          <span className="chip">介绍文件</span>
          <code>{detection?.selected ?? '识别中…'}</code>
          <span className="hint">来自{locationLabel}</span>
          {readmePath !== null ? <span className="chip chip-user">用户指定</span> : null}
        </div>
        <div className="readme-actions">
          {variants.length > 0 ? (
            <div className="variant-switch">
              <span className="hint">语言</span>
              <button
                type="button"
                className={readmePath === null ? 'active' : ''}
                onClick={() => {
                  setSelected(detection?.selected ?? null)
                  resetToAuto()
                }}
              >
                默认
              </button>
              {variants.map((variant) => (
                <button
                  type="button"
                  key={variant.relativePath}
                  className={readmePath === variant.relativePath ? 'active' : ''}
                  onClick={() => {
                    setSelected(variant.relativePath)
                    onReadmePathChange(variant.relativePath)
                  }}
                >
                  {variant.locale ?? variant.relativePath}
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" onClick={() => void openPicker()}>
            更换介绍文件
          </button>
        </div>
      </div>

      {picking ? (
        <div className="file-picker inline">
          {candidates.length === 0 ? <p className="hint">项目根目录没有可选择的文件。</p> : null}
          {candidates.map((entry) => (
            <button type="button" key={entry.relativePath} onClick={() => choose(entry)}>
              {entry.name}
            </button>
          ))}
          <button type="button" onClick={() => setPicking(false)}>
            取消
          </button>
        </div>
      ) : null}

      {error !== null ? <p className="inline-error">{error}</p> : null}

      {loading ? <p className="hint">正在读取介绍文件…</p> : null}

      {!loading && preview !== null && preview.kind === 'markdown' && preview.markdown !== null ? (
        <MarkdownPreview
          projectId={projectId}
          document={preview.markdown}
          onNavigateProjectPath={onNavigateProjectPath}
        />
      ) : null}

      {!loading && preview !== null && preview.kind !== 'markdown' ? (
        <div className="empty-state">
          <p>该文件不是 Markdown，无法在概览页渲染。</p>
          <p className="hint">{preview.message ?? '可在文件页中查看或选择其他介绍文件。'}</p>
        </div>
      ) : null}
    </div>
  )
}
