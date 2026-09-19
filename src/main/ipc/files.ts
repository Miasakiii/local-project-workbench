import type {
  AssetReadResult,
  AssetRequestPayload,
  DeleteEntriesResult,
  FileDeleteRequest,
  FileListRequest,
  FileListResult,
  FilePreview,
  FilePreviewRequest
} from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { shell } from 'electron'
import { deleteEntries } from '../modules/file-access'
import { listDirectory, previewFile } from '../modules/file-browser'
import { readAsset } from '../modules/markdown-preview'
import type { IpcContext } from './context'

/**
 * 文件浏览、预览与删除。
 *
 * 渲染进程只传「项目 ID + 相对路径」，真实路径一律在此解析并复核归属。
 */
export function registerFileIpc(ctx: IpcContext): void {
  ctx.handle(
    IpcChannel.fileList,
    (_event, request: FileListRequest): FileListResult =>
      listDirectory({
        projectRoot: ctx.projectRoot(request.projectId),
        relativePath: request.relativePath
      })
  )

  ctx.handle(
    IpcChannel.filePreview,
    (_event, request: FilePreviewRequest): FilePreview =>
      previewFile({
        projectRoot: ctx.projectRoot(request.projectId),
        relativePath: request.relativePath
      })
  )

  ctx.handle(
    IpcChannel.markdownReadAsset,
    (_event, request: AssetRequestPayload): AssetReadResult =>
      readAsset({
        projectRoot: ctx.projectRoot(request.projectId),
        relativePath: request.relativePath,
        allowOversized: request.allowOversized === true
      })
  )

  ctx.handle(IpcChannel.fileDelete, async (_event, request: FileDeleteRequest): Promise<DeleteEntriesResult> => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) throw new Error(resolved.reason)
    return deleteEntries({
      projectRoot: resolved.root,
      relativePaths: request.relativePaths,
      trusted: resolved.project.trusted,
      trash: (absolutePath) => shell.trashItem(absolutePath)
    })
  })
}
