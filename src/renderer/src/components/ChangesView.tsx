import type { DiffScope, FileDiff, GitChangeGroup, GitSnapshot } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DiffView } from './DiffView'

interface ChangesViewProps {
  projectId: string
  /** 登记时探测的结果：true 是仓库，false 不是，null 表示 Git 不可用或尚未探测 */
  isGitRepository: boolean | null
  /** 文件变化信号带来的刷新令牌；递增即重新查询 */
  refreshToken: number
}

const GROUP_LABELS: Record<GitChangeGroup, string> = {
  unstaged: '未暂存',
  staged: '已暂存',
  untracked: '未跟踪',
  conflicted: '冲突'
}

const GROUP_ORDER: GitChangeGroup[] = ['conflicted', 'unstaged', 'staged', 'untracked']

const GROUP_HINTS: Record<GitChangeGroup, string> = {
  unstaged: '工作区与索引的差异',
  staged: '索引与 HEAD 的差异',
  untracked: '尚未纳入 Git 的文件',
  conflicted: 'Git 报告的未合并状态'
}

/** 分组 → 差异比较对象。未跟踪与冲突没有可比基线，各自单独处理。 */
const GROUP_SCOPE: Record<GitChangeGroup, DiffScope> = {
  unstaged: 'unstaged',
  staged: 'staged',
  untracked: 'untracked',
  conflicted: 'conflicted'
}

interface SelectedEntry {
  relativePath: string
  group: GitChangeGroup
  originalPath: string | null
}

/**
 * 变更页（设计稿 5.2／5.3，M2-1／M2-2／M2-6）。
 *
 * 左栏为四分组文件列表，右栏为该文件的只读逐行差异。
 *
 * 表达规则：
 * - 非 Git 项目给出「未使用 Git」的明确解释，而不是空白（验收场景 9）。
 * - Git 不可用与「不是仓库」分别表述（C08）。
 * - 查询失败显示原因与上次更新时间，**不得呈现为「无变更」**（设计稿 5.3）。
 * - 查询序号递增，丢弃过期返回，避免旧查询覆盖新结果（设计稿 5.3）。
 */
export function ChangesView({ projectId, isGitRepository, refreshToken }: ChangesViewProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<SelectedEntry | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const sequenceRef = useRef(0)
  const selectedRef = useRef<SelectedEntry | null>(null)

  const loadDiff = useCallback(
    async (entry: SelectedEntry) => {
      setLoadingDiff(true)
      setDiffError(null)
      try {
        const result = await window.workbench.git.fileDiff({
          projectId,
          relativePath: entry.relativePath,
          scope: GROUP_SCOPE[entry.group],
          originalPath: entry.originalPath
        })
        // 期间用户可能已切换到别的文件
        if (selectedRef.current !== entry) return
        setDiff(result)
      } catch (error) {
        if (selectedRef.current !== entry) return
        setDiff(null)
        setDiffError(error instanceof Error ? error.message : String(error))
      } finally {
        if (selectedRef.current === entry) setLoadingDiff(false)
      }
    },
    [projectId]
  )

  const refresh = useCallback(async () => {
    sequenceRef.current += 1
    const sequence = sequenceRef.current
    setLoading(true)
    try {
      const result = await window.workbench.git.snapshot({ projectId, sequence })
      // 丢弃过期返回，避免旧查询覆盖新结果
      if (sequence !== sequenceRef.current) return
      setSnapshot(result)
      // 列表刷新后同步重载当前选中文件的差异，避免列表与差异不一致
      const current = selectedRef.current
      if (current !== null) void loadDiff(current)
    } finally {
      if (sequence === sequenceRef.current) setLoading(false)
    }
  }, [loadDiff, projectId])

  useEffect(() => {
    selectedRef.current = null
    setSelected(null)
    setDiff(null)
    setSnapshot(null)
    if (isGitRepository !== true) return
    void refresh()
  }, [isGitRepository, refresh])

  // 文件变化后重新查询；同时重载当前选中文件的差异
  useEffect(() => {
    if (isGitRepository !== true) return
    if (refreshToken === 0) return
    void refresh()
  }, [isGitRepository, refresh, refreshToken])

  const selectEntry = useCallback(
    (entry: SelectedEntry) => {
      selectedRef.current = entry
      setSelected(entry)
      void loadDiff(entry)
    },
    [loadDiff]
  )

  const openExternally = useCallback(async () => {
    if (selected === null) return
    await window.workbench.system.openPath({ projectId, relativePath: selected.relativePath })
  }, [projectId, selected])

  if (isGitRepository === false) {
    return (
      <div className="changes-view">
        <div className="empty-state">
          <h2>未使用 Git</h2>
          <p>该目录不是 Git 仓库，因此没有版本变更信息。文件浏览、README 与终端均可正常使用。</p>
          <p className="hint">
            如需启用版本管理，可在下方终端中自行执行 <code>git init</code>。应用不会代你初始化仓库。
          </p>
        </div>
      </div>
    )
  }

  if (isGitRepository === null) {
    return (
      <div className="changes-view">
        <div className="empty-state">
          <h2>无法判断变化</h2>
          <p>未检测到可用的 Git 程序，因此无法判断该目录的版本变化。</p>
          <p className="hint">这与「没有变化」不是一回事。安装 Git 后重新登记该项目即可获得变更信息。</p>
        </div>
      </div>
    )
  }

  const counts: Record<GitChangeGroup, number> = {
    unstaged: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0
  }
  const uniqueFiles = new Set<string>()
  if (snapshot !== null) {
    for (const entry of snapshot.entries) {
      counts[entry.group] += 1
      uniqueFiles.add(entry.relativePath)
    }
  }

  return (
    <div className="changes-view">
      <div className="changes-toolbar">
        <div className="changes-summary">
          {snapshot === null ? (
            <span>正在查询…</span>
          ) : snapshot.stale ? (
            <span className="error">无法判断变化</span>
          ) : (
            <span>
              分支 <code title={snapshot.branch ?? ''}>{snapshot.branch ?? '（无分支，可能尚无首次提交）'}</code> ·
              变更文件 {uniqueFiles.size} 个
            </span>
          )}
        </div>
        <div className="changes-actions">
          {snapshot !== null ? (
            <span className="hint">
              更新于 {new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          ) : null}
          <button type="button" onClick={() => void refresh()} disabled={loading}>
            {loading ? '查询中…' : '刷新'}
          </button>
        </div>
      </div>

      {snapshot !== null && snapshot.error !== null ? (
        <p className="inline-error">
          无法判断变化：{snapshot.error}
          {snapshot.stale ? '（以下内容可能已过期）' : ''}
        </p>
      ) : null}

      {snapshot !== null && snapshot.error === null && uniqueFiles.size === 0 ? (
        <div className="empty-state">
          <h2>没有变化</h2>
          <p>工作区与索引均与当前提交一致。</p>
        </div>
      ) : null}

      {snapshot !== null && snapshot.entries.length > 0 ? (
        <div className="changes-split">
          <div className="changes-list">
            {GROUP_ORDER.map((group) => {
              const entries = snapshot.entries.filter((entry) => entry.group === group)
              if (entries.length === 0) return null
              return (
                <section key={group} className="change-group">
                  <header>
                    <strong>{GROUP_LABELS[group]}</strong>
                    <span className="chip">{entries.length} 项</span>
                  </header>
                  <ul>
                    {entries.map((entry) => {
                      const isSelected = selected?.relativePath === entry.relativePath && selected.group === group
                      return (
                        <li key={`${group}-${entry.relativePath}`}>
                          <button
                            type="button"
                            className={isSelected ? 'change-file active' : 'change-file'}
                            onClick={() =>
                              selectEntry({
                                relativePath: entry.relativePath,
                                group,
                                originalPath: entry.originalPath
                              })
                            }
                            title={`${entry.relativePath}\n${GROUP_HINTS[group]}`}
                          >
                            <span className="change-file-name">
                              {entry.relativePath.split('/').pop() ?? entry.relativePath}
                            </span>
                            <span className="change-file-path">{entry.relativePath}</span>
                            {entry.originalPath !== null ? (
                              <span className="chip">原路径 {entry.originalPath}</span>
                            ) : null}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}

            <p className="hint">
              顶部数量按去重后的文件数计算；同一文件可能同时出现在「已暂存」与「未暂存」，
              因此分组数量之和可能大于文件数。
            </p>
          </div>

          {diffError !== null ? (
            <div className="diff-pane">
              <div className="preview-empty">
                <p className="inline-error">无法读取差异：{diffError}</p>
              </div>
            </div>
          ) : (
            <DiffView diff={diff} loading={loadingDiff} onOpenFile={() => void openExternally()} />
          )}
        </div>
      ) : null}
    </div>
  )
}
