import type { GitChangeGroup, GitSnapshot, GitStatusEntry } from '@shared/types'

/**
 * Git 只读查询（M0-6）。
 *
 * 边界（设计稿 5.2、5.3、8.1）：
 * - 只读：仅查询分支、状态与差异，不提供任何写操作。
 * - 以参数数组调用，禁止拼接用户路径为 Shell 命令。
 * - 失败与「无变更」必须可区分（stale / error）。
 * - 使用 porcelain v2 与 NUL 分隔，正确处理特殊文件名。
 */

/** 解析 porcelain v2（-z）输出 */
export function parsePorcelainV2(buffer: Buffer): {
  branch: string | null
  detached: boolean
  entries: GitStatusEntry[]
} {
  const records = buffer.toString('utf8').split('\0')
  const entries: GitStatusEntry[] = []
  let branch: string | null = null
  let detached = false

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record || record.length === 0) continue

    if (record.startsWith('# ')) {
      const head = /^# branch\.head (.+)$/.exec(record)
      if (head) {
        const value = head[1] ?? ''
        if (value === '(detached)') {
          detached = true
          branch = null
        } else {
          branch = value
        }
      }
      continue
    }

    const kind = record[0]

    if (kind === '?') {
      const path = record.slice(2)
      if (path) entries.push({ group: 'untracked', relativePath: path, originalPath: null })
      continue
    }

    if (kind === '!') continue

    if (kind === 'u') {
      const path = fieldAfter(record, 10)
      if (path) entries.push({ group: 'conflicted', relativePath: path, originalPath: null })
      continue
    }

    if (kind === '1' || kind === '2') {
      const indexStatus = record[2] ?? '.'
      const worktreeStatus = record[3] ?? '.'

      if (kind === '2') {
        const path = fieldAfter(record, 9)
        const originalPath = records[index + 1] ?? null
        index += 1
        if (path) pushByStatus(entries, indexStatus, worktreeStatus, path, originalPath)
        continue
      }

      const path = fieldAfter(record, 8)
      if (path) pushByStatus(entries, indexStatus, worktreeStatus, path, null)
    }
  }

  return { branch, detached, entries }
}

/** 取第 n 个空格分隔字段之后的所有内容（路径可含空格） */
function fieldAfter(record: string, fieldCount: number): string | null {
  let cursor = 0
  for (let count = 0; count < fieldCount; count += 1) {
    const space = record.indexOf(' ', cursor)
    if (space === -1) return null
    cursor = space + 1
  }
  const value = record.slice(cursor)
  return value.length > 0 ? value : null
}

/** 同一文件可同时处于已暂存与未暂存（设计稿 5.2） */
function pushByStatus(
  entries: GitStatusEntry[],
  indexStatus: string,
  worktreeStatus: string,
  relativePath: string,
  originalPath: string | null
): void {
  if (indexStatus !== '.') {
    entries.push({ group: 'staged', relativePath, originalPath })
  }
  if (worktreeStatus !== '.') {
    entries.push({ group: 'unstaged', relativePath, originalPath })
  }
}

/** 按分组统计，供界面解释数量差异（设计稿 5.2） */
export function countByGroup(entries: GitStatusEntry[]): Record<GitChangeGroup, number> {
  const counts: Record<GitChangeGroup, number> = {
    unstaged: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0
  }
  for (const entry of entries) counts[entry.group] += 1
  return counts
}

/** 去重后的变更文件数，用于顶部数量展示 */
export function countUniqueFiles(entries: GitStatusEntry[]): number {
  return new Set(entries.map((entry) => entry.relativePath)).size
}

/** 构造失败快照；失败不得呈现为「无变更」 */
export function failedSnapshot(projectId: string, sequence: number, error: string): GitSnapshot {
  return {
    projectId,
    sequence,
    branch: null,
    entries: [],
    updatedAt: new Date().toISOString(),
    stale: true,
    error
  }
}
