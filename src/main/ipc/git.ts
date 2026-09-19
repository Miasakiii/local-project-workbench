import type { FileDiffRequest, GitSnapshot, GitSnapshotRequest } from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import type { FileDiff } from '@shared/types'
import { fileDiff } from '../modules/diff-service'
import { queryGitStatus } from '../modules/git-query'
import type { IpcContext } from './context'

/**
 * 只读 Git：快照与差异。
 *
 * 项目不可用时返回带 `stale` 与 `error` 的降级结果而不是抛错，
 * 让界面能保留上一份数据并明确标注「不是最新」。
 */
export function registerGitIpc(ctx: IpcContext): void {
  ctx.handle(IpcChannel.gitSnapshot, async (_event, request: GitSnapshotRequest): Promise<GitSnapshot> => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) {
      return {
        projectId: request.projectId,
        sequence: request.sequence,
        branch: null,
        entries: [],
        updatedAt: new Date().toISOString(),
        stale: true,
        error: resolved.reason
      }
    }
    return queryGitStatus(request.projectId, resolved.root, request.sequence)
  })

  ctx.handle(IpcChannel.gitFileDiff, async (_event, request: FileDiffRequest): Promise<FileDiff> => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) {
      return {
        projectId: request.projectId,
        relativePath: request.relativePath,
        scope: request.scope,
        status: 'unchanged',
        binary: false,
        originalPath: null,
        hunks: [],
        addedLines: 0,
        removedLines: 0,
        truncated: false,
        noBaseline: request.scope === 'untracked',
        updatedAt: new Date().toISOString(),
        stale: true,
        error: resolved.reason
      }
    }
    return fileDiff({
      projectId: request.projectId,
      projectRoot: resolved.root,
      relativePath: request.relativePath,
      scope: request.scope,
      originalPath: request.originalPath ?? null
    })
  })
}
