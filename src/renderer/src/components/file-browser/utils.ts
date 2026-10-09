import type { FileEntry, FileOperationBatchResult } from '@shared/types'

/**
 * 文件栏的纯工具函数。
 *
 * 从 `FileBrowser.tsx` 拆出（重构，行为不变）：这里只放无组件状态、无副作用的
 * 纯函数与展示用的小类型，供组件与菜单构建共用。
 */

/** 文件操作后的提示条内容（成功或失败，含逐项明细）。 */
export interface OperationNotice {
  tone: 'success' | 'error'
  title: string
  details: string[]
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function formatTime(iso: string): string {
  if (iso.startsWith('1970-01-01')) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 悬浮提示：优先显示完整名称，被省略号截断时尤其需要 */
export function tooltipFor(entry: FileEntry): string {
  const lines = [entry.name]
  if (entry.relativePath !== entry.name) lines.push(entry.relativePath)
  if (entry.isLink) lines.push('符号链接或目录联接')
  lines.push(entry.kind === 'directory' ? '单击展开或收起' : '单击预览')
  return lines.join('\n')
}

/** 拆分路径，返回从根到父级的目录链（不含自身） */
export function ancestorDirectories(relativePath: string): string[] {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  const trail: string[] = []
  let accumulated = ''
  for (let index = 0; index < segments.length - 1; index += 1) {
    accumulated = accumulated.length === 0 ? (segments[index] as string) : `${accumulated}/${segments[index]}`
    trail.push(accumulated)
  }
  return trail
}

export function parentDirectoryOf(relativePath: string): string {
  const separator = relativePath.lastIndexOf('/')
  return separator < 0 ? '' : relativePath.slice(0, separator)
}

/** 把批量操作结果整理为提示条：标题给三项计数，明细逐项列出非成功项。 */
export function operationReport(result: FileOperationBatchResult, action: string): OperationNotice {
  const title = `${action}完成：成功 ${result.ok} 项，失败 ${result.failed} 项，未执行 ${result.skipped} 项`
  const details: string[] = []
  if (result.abortMessage !== null) details.push(result.abortMessage)
  for (const item of result.items) {
    if (item.status === 'ok') continue
    const target =
      item.targetRelativePath === undefined || item.targetRelativePath === null ? '' : ` → ${item.targetRelativePath}`
    details.push(`${item.status === 'skipped' ? '未执行' : '失败'}：${item.relativePath}${target}：${item.message}`)
  }
  return {
    tone: result.failed > 0 || result.skipped > 0 || result.aborted ? 'error' : 'success',
    title,
    details: [...new Set(details)]
  }
}

/** 兼容回退：无 navigator.clipboard 的安全上下文时用 execCommand 复制 */
export function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  } finally {
    document.body.removeChild(area)
  }
  return ok
}
