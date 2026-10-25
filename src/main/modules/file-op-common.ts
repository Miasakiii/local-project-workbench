import type {
  FileOperationBatchResult,
  FileOperationItem,
  FileOperationReason,
  FileOperationStatus
} from '@shared/types'
import type { FileRejection } from './write-guard'

/**
 * 文件操作的共享辅助 —— 四个写入口（新建／重命名／复制·剪切／删除）共用的
 * 类型、常量与结果拼装函数。
 *
 * 从 `file-access.ts` 拆出（重构，行为不变）：各入口按关注点拆成独立模块后，
 * 这些共用件集中在此，避免 barrel 与入口模块互相导入形成环。公开导出面仍
 * 经 `file-access.ts` 的 barrel 再导出保持不变。
 *
 * 本模块不导入 Electron，可在纯 Node 下测试。
 */

/** 回收站能力。主进程注入 `shell.trashItem`。 */
export type TrashFn = (absolutePath: string) => Promise<void>

/**
 * 执行前钩子 —— **仅验证脚本注入的测试接缝，产品链路不设置。**
 *
 * 在身份快照采集完毕、执行前复核之前调用，供验证脚本模拟「resolve 之后、
 * execute 之前」路径被替换的竞态（A1／R9）。函数无法经结构化克隆通过 IPC，
 * 主进程装配同样不设置它，因此它只可能出现在纯 Node 验证进程里。
 */
export type BeforeExecuteHook = (context: {
  operation: 'create' | 'rename' | 'copy' | 'move' | 'delete'
  targetAbsolutePath: string
}) => void

/** 单次批量操作的项数上限，防止误操作放大到不可收拾的规模。 */
export const MAX_BATCH_ITEMS = 500

export function reasonForRejection(rejection: FileRejection): FileOperationReason {
  switch (rejection) {
    case 'traversal':
    case 'outside-project':
    case 'absolute':
    case 'drive-relative':
    case 'unc':
      return 'outside-project'
    case 'not-found':
      return 'not-found'
    case 'permission-denied':
      return 'permission-denied'
    default:
      return 'invalid-path'
  }
}

export function messageForRejection(rejection: FileRejection, relativePath: string): string {
  switch (rejection) {
    case 'outside-project':
    case 'traversal':
      return `目标位于项目之外或经链接指向项目外，未执行：${relativePath}`
    case 'absolute':
    case 'drive-relative':
    case 'unc':
      return `不接受绝对路径、盘符或 UNC 写法，未执行：${relativePath}`
    case 'not-found':
      return `目标不存在：${relativePath}`
    case 'permission-denied':
      return `没有权限访问目标，未执行：${relativePath}`
    default:
      return `路径不合法，未执行：${relativePath}`
  }
}

export function summarize(items: FileOperationItem[]): FileOperationBatchResult {
  let ok = 0
  let failed = 0
  let skipped = 0
  for (const item of items) {
    if (item.status === 'ok') ok += 1
    else if (item.status === 'failed') failed += 1
    else skipped += 1
  }
  return { items, ok, failed, skipped, aborted: false, abortReason: null, abortMessage: null }
}

export function abortBatch(reason: FileOperationReason, message: string): FileOperationBatchResult {
  return { items: [], ok: 0, failed: 0, skipped: 0, aborted: true, abortReason: reason, abortMessage: message }
}

export function childRelativePath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`
}

export function leafOf(relativePath: string): string {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}

export function isSameOrDescendant(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

export function operationItem(
  relativePath: string,
  status: FileOperationStatus,
  reason: FileOperationReason | null,
  message: string,
  targetRelativePath: string | null = null
): FileOperationItem {
  return { relativePath, targetRelativePath, status, reason, message }
}
