import type { DiffLineKind, FileDiff } from '@shared/types'

interface DiffViewProps {
  diff: FileDiff | null
  loading: boolean
  onOpenFile: () => void
}

const SCOPE_LABELS: Record<FileDiff['scope'], string> = {
  unstaged: '工作区 ↔ 索引',
  staged: '索引 ↔ HEAD',
  untracked: '当前内容（无 Git 基线）',
  conflicted: '当前内容（含冲突标记）'
}

const STATUS_LABELS: Record<FileDiff['status'], string> = {
  modified: '已修改',
  added: '新增',
  deleted: '已删除',
  renamed: '重命名',
  unchanged: '无变化'
}

function markerFor(kind: DiffLineKind): string {
  if (kind === 'add') return '+'
  if (kind === 'remove') return '-'
  return ''
}

/**
 * 只读逐行差异（设计稿 5.2，M2-2）。
 *
 * 呈现规则：
 * - 明确写出比较对象（工作区↔索引 / 索引↔HEAD / 无基线），避免歧义。
 * - 失败与「无差异」分别表达：`error` 非空时只说「无法判断」，绝不显示为「没有变化」。
 * - 二进制文件、超大差异、无基线内容各有专门说明。
 * - 冲突文件按设计稿呈现「当前内容」而非增删差异。
 * - 文本经 React 渲染，自动转义，不执行任何内容。
 */
export function DiffView({ diff, loading, onOpenFile }: DiffViewProps): React.JSX.Element {
  if (loading) {
    return (
      <div className="diff-pane">
        <div className="preview-empty">正在读取差异…</div>
      </div>
    )
  }

  if (diff === null) {
    return (
      <div className="diff-pane">
        <div className="preview-empty">
          <p>未选择文件</p>
          <p className="hint">在左侧点击变更文件即可查看只读逐行差异</p>
        </div>
      </div>
    )
  }

  const header = (
    <header className="preview-header">
      <div className="preview-title">
        <strong title={diff.relativePath}>{diff.relativePath.split('/').pop() ?? diff.relativePath}</strong>
        <code title={diff.relativePath}>{diff.relativePath}</code>
      </div>
      <div className="preview-meta">
        <span className="chip">{STATUS_LABELS[diff.status]}</span>
        <span className="chip">{SCOPE_LABELS[diff.scope]}</span>
        {diff.error === null ? (
          <span className="diff-stat">
            <span className="diff-stat-add">+{diff.addedLines}</span>
            <span className="diff-stat-remove">−{diff.removedLines}</span>
          </span>
        ) : null}
        <button type="button" onClick={onOpenFile}>
          用默认程序打开
        </button>
      </div>
    </header>
  )

  const body = (): React.JSX.Element => {
    if (diff.error !== null) {
      return (
        <div className="preview-empty">
          <p className="inline-error">无法判断变化：{diff.error}</p>
          <p className="hint">这与「没有变化」不是一回事。可稍后重试，或用默认程序打开文件查看。</p>
        </div>
      )
    }

    if (diff.binary) {
      return (
        <div className="preview-empty">
          <p>二进制文件不提供逐行差异。</p>
          <p className="hint">可用默认程序打开查看。</p>
        </div>
      )
    }

    if (diff.originalPath !== null) {
      return (
        <div className="diff-scroll">
          <p className="diff-note">由 {diff.originalPath} 重命名而来。</p>
          <DiffHunks diff={diff} />
        </div>
      )
    }

    if (diff.hunks.length === 0) {
      return (
        <div className="preview-empty">
          <p>{diff.noBaseline ? '该文件没有 Git 历史基线' : '没有差异'}</p>
          <p className="hint">
            {diff.noBaseline
              ? '未跟踪文件尚未纳入 Git，因此没有可比对的基线。'
              : diff.truncated
                ? '内容超过展示上限。'
                : '该比较对象下没有需要展示的内容。'}
          </p>
        </div>
      )
    }

    return (
      <div className="diff-scroll">
        {diff.noBaseline ? (
          <p className="diff-note">
            未跟踪文件没有 Git 历史基线，以下为<strong>当前内容</strong>，不代表「新增了这些行」。
          </p>
        ) : null}
        {diff.scope === 'conflicted' ? (
          <p className="diff-note">
            该文件处于合并冲突状态。以下为当前内容，冲突标记（&lt;&lt;&lt;&lt;&lt;&lt;&lt;）可直接看到；
            应用不提供自动解决。
          </p>
        ) : null}
        {diff.truncated ? <p className="inline-warning">差异超过 2000 行，已截断显示。</p> : null}
        <DiffHunks diff={diff} />
      </div>
    )
  }

  return (
    <div className="diff-pane">
      {header}
      <div className="preview-body">{body()}</div>
    </div>
  )
}

function DiffHunks({ diff }: { diff: FileDiff }): React.JSX.Element {
  return (
    <div className="diff-hunks">
      {diff.hunks.map((hunk, hunkIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunk 没有稳定标识；索引参与复合键，且差异列表不会重排
        <section className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
          <div className="diff-hunk-header" title={hunk.header}>
            {hunk.header}
          </div>
          <div className="diff-lines">
            {hunk.lines.map((line, lineIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 差异行没有稳定标识；行内容可重复，索引参与复合键是唯一可靠选择
              <div className={`diff-line ${line.kind}`} key={`${hunkIndex}-${lineIndex}`}>
                <span className="diff-gutter">{line.oldLine ?? ''}</span>
                <span className="diff-gutter">{line.newLine ?? ''}</span>
                <span className="diff-marker">{markerFor(line.kind)}</span>
                <span className="diff-text">{line.text}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
