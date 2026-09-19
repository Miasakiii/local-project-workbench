import type { DiffFileStatus, DiffHunk, DiffLine } from '@shared/types'

/**
 * 统一差异格式解析（设计稿 5.2）。
 *
 * 纯函数、无副作用，可独立测试。调用方保证每次只传入**一个文件**的差异，
 * 因此不需要处理多文件之间的状态切换，也就不必依赖 `diff --git` 头。
 *
 * 解析内容：
 * - hunk 标题 `@@ -旧起点,旧行数 +新起点,新行数 @@ 说明`（行数可省略）
 * - 行分类：上下文／新增／删除／元信息（`\ No newline at end of file`）
 * - 文件级标记：二进制、新增、删除、重命名
 */

export interface ParsedDiff {
  binary: boolean
  status: DiffFileStatus
  originalPath: string | null
  hunks: DiffHunk[]
  addedLines: number
  removedLines: number
  /** 合并冲突的差异使用 `@@@` 三路格式，本版不逐行展示 */
  combined: boolean
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function createEmptyResult(): ParsedDiff {
  return {
    binary: false,
    status: 'modified',
    originalPath: null,
    hunks: [],
    addedLines: 0,
    removedLines: 0,
    combined: false
  }
}

/** 解析统一差异文本。空输入返回「无差异」。 */
export function parseUnifiedDiff(source: string): ParsedDiff {
  const result = createEmptyResult()
  const normalized = source.replace(/\r\n?/g, '\n')
  if (normalized.trim().length === 0) {
    result.status = 'unchanged'
    return result
  }

  const lines = normalized.split('\n')
  let current: DiffHunk | null = null
  let oldCursor = 0
  let newCursor = 0

  for (const line of lines) {
    // 文件级标记：二进制与新增/删除/重命名
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      result.binary = true
      continue
    }
    if (line.startsWith('@@@')) {
      result.combined = true
      continue
    }
    if (line.startsWith('new file mode')) {
      result.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      result.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      result.status = 'renamed'
      result.originalPath = line.slice('rename from '.length)
      continue
    }
    if (line.startsWith('rename to ')) {
      result.status = 'renamed'
      continue
    }
    // 文件头与其他元信息：跳过，不进入 hunk
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('dissimilarity index')
    ) {
      continue
    }

    const hunkHeader = HUNK_HEADER_RE.exec(line)
    if (hunkHeader) {
      const oldStart = Number.parseInt(hunkHeader[1] as string, 10)
      const oldCount = hunkHeader[2] === undefined ? 1 : Number.parseInt(hunkHeader[2], 10)
      const newStart = Number.parseInt(hunkHeader[3] as string, 10)
      const newCount = hunkHeader[4] === undefined ? 1 : Number.parseInt(hunkHeader[4], 10)
      current = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: []
      }
      oldCursor = oldStart
      newCursor = newStart
      result.hunks.push(current)
      continue
    }

    if (current === null) continue

    // 空行不是合法的 hunk 内容：上下文行一定带一个前导空格。
    // 若把 `split('\n')` 产生的尾随空元素当作上下文行，会凭空多出一行并打乱行号。
    if (line.length === 0) continue

    if (line.startsWith('\\')) {
      // `\ No newline at end of file`：归属于上一个内容行，仅作展示
      current.lines.push({ kind: 'meta', oldLine: null, newLine: null, text: line })
      continue
    }

    const marker = line.charAt(0)
    const text = line.slice(1)

    if (marker === '+') {
      current.lines.push({ kind: 'add', oldLine: null, newLine: newCursor, text })
      newCursor += 1
      result.addedLines += 1
      continue
    }
    if (marker === '-') {
      current.lines.push({ kind: 'remove', oldLine: oldCursor, newLine: null, text })
      oldCursor += 1
      result.removedLines += 1
      continue
    }
    if (marker === ' ') {
      current.lines.push({ kind: 'context', oldLine: oldCursor, newLine: newCursor, text })
      oldCursor += 1
      newCursor += 1
      continue
    }

    // 其余（例如空行）按上下文处理，避免丢失内容
    current.lines.push({ kind: 'context', oldLine: oldCursor, newLine: newCursor, text: line })
    oldCursor += 1
    newCursor += 1
  }

  if (result.hunks.length === 0 && !result.binary && result.status === 'modified') {
    result.status = 'unchanged'
  }

  return result
}

/**
 * 把整份文件内容合成为「当前内容」视图：行全部标为上下文。
 *
 * 用于合并冲突文件——设计稿 5.2 要求冲突分组呈现「冲突提示与当前内容」，
 * 而不是增删差异。
 */
export function synthesizeContentDiff(content: string): ParsedDiff {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (normalized.length === 0) {
    return {
      binary: false,
      status: 'modified',
      originalPath: null,
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      combined: false
    }
  }

  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  return {
    binary: false,
    status: 'modified',
    originalPath: null,
    combined: false,
    hunks: [
      {
        header: `@@ 当前内容，共 ${lines.length} 行 @@`,
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: lines.length,
        lines: lines.map((text, index) => ({
          kind: 'context' as const,
          oldLine: null,
          newLine: index + 1,
          text
        }))
      }
    ],
    addedLines: 0,
    removedLines: 0
  }
}

/** 统计差异行数，用于界面显示「+N −M」。 */
export function countDiffLines(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1
      else if (line.kind === 'remove') removed += 1
    }
  }
  return { added, removed }
}

/**
 * 把整份文件内容合成为「全部新增」的差异。
 *
 * 未跟踪文件没有 Git 历史基线，因此不产生真正的差异，只呈现当前内容并标注
 * 「没有 Git 历史基线」（设计稿 5.2）。
 */
export function synthesizeAddedDiff(content: string): ParsedDiff {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (normalized.length === 0) {
    return {
      binary: false,
      status: 'added',
      originalPath: null,
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      combined: false
    }
  }

  const lines = normalized.split('\n')
  // 末尾换行会多出一个空元素，去掉它以免多出一行
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const diffLines: DiffLine[] = lines.map((text, index) => ({
    kind: 'add',
    oldLine: null,
    newLine: index + 1,
    text
  }))

  return {
    binary: false,
    status: 'added',
    originalPath: null,
    combined: false,
    hunks:
      lines.length === 0
        ? []
        : [
            {
              header: `@@ -0,0 +1,${lines.length} @@`,
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: lines.length,
              lines: diffLines
            }
          ],
    addedLines: lines.length,
    removedLines: 0
  }
}
