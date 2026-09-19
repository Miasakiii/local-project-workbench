import type {
  ProjectRef,
  ProjectRemoveResult,
  ProjectRevealResult,
  ProjectSummary,
  ProjectUpdateRequest,
  RegisterProjectResult,
  ViewStateRequest,
  ViewStateSaveRequest
} from '@shared/ipc'
import { IpcChannel } from '@shared/ipc'
import type { ProjectViewState, ReadmeDetection } from '@shared/types'
import { shell } from 'electron'
import { detectRepository } from '../modules/git-query'
import { detectReadme } from '../modules/markdown-preview'
import { toSummary } from '../modules/project-registry'
import type { IpcContext } from './context'
import { pickDirectory } from './dialogs'

/** 项目登记、元数据与视图状态。 */
export function registerProjectIpc(ctx: IpcContext): void {
  ctx.handle(IpcChannel.projectList, (): ProjectSummary[] => ctx.listProjects())

  ctx.handle(IpcChannel.projectRegister, async (event): Promise<RegisterProjectResult> => {
    const directory = await pickDirectory(event)
    if (directory === null) {
      return { status: 'cancelled', project: null, message: null }
    }

    const outcome = ctx.registry().register(directory)

    if (outcome.project === null) {
      return { status: 'unavailable', project: null, message: outcome.message }
    }

    // Git 是可选探测属性（C08）：失败或不可用不影响登记结果
    if (outcome.status === 'added') {
      const detected = await detectRepository(outcome.project.normalizedIdentity)
      ctx.registry().update(outcome.project.id, { isGitRepository: detected })
    }

    const refreshed = ctx.registry().get(outcome.project.id)
    const summary = refreshed === null ? null : toSummary(refreshed, (item) => ctx.describe(item))

    return { status: outcome.status, project: summary, message: outcome.message }
  })

  ctx.handle(IpcChannel.projectRemove, (_event, request: ProjectRef): ProjectRemoveResult => {
    const removed = ctx.registry().remove(request.projectId)
    ctx.invalidateDescription(request.projectId)
    return {
      removed,
      message: removed ? '已移除登记。磁盘上的文件未受影响。' : '该项目不在登记列表中。',
      diskUntouched: true
    }
  })

  ctx.handle(IpcChannel.projectUpdate, (_event, request: ProjectUpdateRequest): ProjectSummary | null => {
    const patch: Parameters<ReturnType<IpcContext['registry']>['update']>[1] = {}
    if (request.pinned !== undefined) patch.pinned = request.pinned
    if (request.trusted !== undefined) patch.trusted = request.trusted
    if (request.displayName !== undefined) patch.displayName = request.displayName
    if (request.readmePath !== undefined) patch.readmePath = request.readmePath
    if (request.descriptionOverride !== undefined) patch.descriptionOverride = request.descriptionOverride

    const updated = ctx.registry().update(request.projectId, patch)
    if (updated === null) return null
    ctx.invalidateDescription(request.projectId)
    return toSummary(updated, (item) => ctx.describe(item))
  })

  ctx.handle(IpcChannel.projectOpen, (_event, request: ProjectRef): ProjectSummary | null => {
    const touched = ctx.registry().touch(request.projectId)
    if (touched === null) return null
    return toSummary(touched, (item) => ctx.describe(item))
  })

  ctx.handle(IpcChannel.projectReveal, async (_event, request: ProjectRef): Promise<ProjectRevealResult> => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) return { opened: false, message: resolved.reason }
    const error = await shell.openPath(resolved.root)
    return { opened: error.length === 0, message: error.length === 0 ? null : error }
  })

  ctx.handle(IpcChannel.projectReadme, (_event, request: ProjectRef): ReadmeDetection => {
    const resolved = ctx.registry().resolveRoot(request.projectId)
    if (!resolved.ok) return { selected: null, variants: [], location: null }
    return detectReadme(resolved.root, resolved.project.readmePath)
  })

  /* ---- 视图状态 ---- */

  ctx.handle(IpcChannel.viewStateGet, (_event, request: ViewStateRequest): ProjectViewState | null =>
    ctx.registry().getViewState(request.projectId)
  )

  ctx.handle(IpcChannel.viewStateSave, (_event, request: ViewStateSaveRequest): void => {
    ctx.registry().saveViewState({
      projectId: request.projectId,
      page: request.page,
      relativePath: request.relativePath,
      scrollTop: Number.isFinite(request.scrollTop) ? request.scrollTop : 0,
      terminalPanelHeight: Number.isFinite(request.terminalPanelHeight) ? request.terminalPanelHeight : 280,
      filesPaneWidth: Number.isFinite(request.filesPaneWidth) ? request.filesPaneWidth : 380
    })
  })
}
