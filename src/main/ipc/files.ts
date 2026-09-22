import type {
  AssetReadResult,
  AssetRequestPayload,
  CreateEntryResult,
  DeleteEntriesResult,
  FileCreateRequest,
  FileDeleteRequest,
  FileListRequest,
  FileListResult,
  FilePreview,
  FilePreviewRequest,
  FileRenameRequest,
  FileTransferRequest,
  RemoteAssetRequestPayload,
  RemoteAssetResult,
  TransferEntriesResult
} from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import { shell } from 'electron'
import { createEntry, deleteEntries, renameEntry, transferEntries } from '../modules/file-access'
import { listDirectory, previewFile } from '../modules/file-browser'
import type { PreviewPolicy } from '../modules/markdown-preview'
import { readAsset } from '../modules/markdown-preview'
import { readRemoteImage } from '../modules/remote-image'
import type { IpcContext } from './context'

/**
 * 文件浏览、预览与项目内基础文件管理。
 *
 * 渲染进程只传「项目 ID + 相对路径」，真实路径一律在此解析并复核归属。
 */
export function registerFileIpc(ctx: IpcContext): void {
  /**
   * 预览策略一律由登记记录现算：渲染进程既不能声明「这个项目已授权网络图片」，
   * 也不能靠缓存的界面状态绕过——撤销授权后下一次预览即生效。
   */
  const previewPolicy = (projectId: string): PreviewPolicy => ({
    allowNetworkImages: ctx.registry().get(projectId)?.allowNetworkImages === true,
    allowedImageHosts: []
  })

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
        relativePath: request.relativePath,
        policy: previewPolicy(request.projectId)
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

  ctx.handle(
    IpcChannel.markdownReadRemoteAsset,
    (_event, request: RemoteAssetRequestPayload): Promise<RemoteAssetResult> =>
      readRemoteImage({
        url: request.url,
        allowNetworkImages: ctx.registry().get(request.projectId)?.allowNetworkImages === true,
        allowedImageHosts: []
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

  ctx.handle(IpcChannel.fileCreate, (_event, request: FileCreateRequest): CreateEntryResult => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) throw new Error(resolved.reason)
    return createEntry({
      projectRoot: resolved.root,
      parentRelativePath: request.parentRelativePath,
      name: request.name,
      kind: request.kind,
      trusted: resolved.project.trusted
    })
  })

  ctx.handle(IpcChannel.fileTransfer, (_event, request: FileTransferRequest): TransferEntriesResult => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) throw new Error(resolved.reason)
    return transferEntries({
      projectRoot: resolved.root,
      relativePaths: request.relativePaths,
      targetDirectory: request.targetDirectory,
      mode: request.mode,
      trusted: resolved.project.trusted
    })
  })

  ctx.handle(IpcChannel.fileRename, (_event, request: FileRenameRequest) => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) throw new Error(resolved.reason)
    return renameEntry({
      projectRoot: resolved.root,
      relativePath: request.relativePath,
      newName: request.newName,
      trusted: resolved.project.trusted
    })
  })
}
