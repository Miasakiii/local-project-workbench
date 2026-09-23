import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Project, ProjectSummary, ProjectViewState } from '@shared/types'
import { JsonStore } from '../storage/json-store'

/**
 * 项目登记模块（设计稿第 3 章，M1-1／M1-2／M1-3／M1-6）。
 *
 * 关键规则：
 * - **去重基于真实路径身份**，不比较原始输入字符串，也不手工转小写比较（风险 R3）。
 *   `realpath` 在 Windows 上返回磁盘上的规范大小写，因此同一目录的不同写法会归一到
 *   同一身份，字符串精确比较即可。
 * - **记录与磁盘文件分离**：移除登记只删除记录，不动磁盘（设计稿 3.2）。
 * - **Git 是可选属性**：`isGitRepository` 为三态，`null` 表示 Git 不可用或尚未探测，
 *   界面须与「不是仓库」分别表述（C08）。
 */

export interface RegistryData {
  projects: Project[]
  viewStates: ProjectViewState[]
}

export interface RegistryFile {
  projects: unknown
  viewStates: unknown
}

const STORE_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function sanitizeProject(raw: unknown): Project | null {
  if (!isRecord(raw)) return null
  const id = raw['id']
  const normalizedIdentity = raw['normalizedIdentity']
  const originalPath = raw['originalPath']
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof normalizedIdentity !== 'string' || normalizedIdentity.length === 0) return null
  if (typeof originalPath !== 'string' || originalPath.length === 0) return null

  const git = raw['isGitRepository']
  const isGitRepository = typeof git === 'boolean' ? git : null

  return {
    id,
    displayName:
      typeof raw['displayName'] === 'string' && raw['displayName'].length > 0
        ? raw['displayName']
        : basename(normalizedIdentity),
    originalPath,
    normalizedIdentity,
    descriptionOverride: toStringOrNull(raw['descriptionOverride']),
    readmePath: toStringOrNull(raw['readmePath']),
    pinned: toBoolean(raw['pinned'], false),
    lastOpenedAt: typeof raw['lastOpenedAt'] === 'string' ? raw['lastOpenedAt'] : new Date(0).toISOString(),
    trusted: toBoolean(raw['trusted'], false),
    // 旧版本 projects.json 无此字段时按默认关闭恢复（设计稿 4.3）
    allowNetworkImages: toBoolean(raw['allowNetworkImages'], false),
    isGitRepository
  }
}

function sanitizeViewState(raw: unknown): ProjectViewState | null {
  if (!isRecord(raw)) return null
  const projectId = raw['projectId']
  if (typeof projectId !== 'string' || projectId.length === 0) return null
  const page = raw['page']
  const normalizedPage = page === 'overview' || page === 'files' || page === 'changes' ? page : 'overview'
  const scrollTop = raw['scrollTop']
  const terminalPanelHeight = raw['terminalPanelHeight']
  const filesPaneWidth = raw['filesPaneWidth']
  return {
    projectId,
    page: normalizedPage,
    relativePath: typeof raw['relativePath'] === 'string' ? raw['relativePath'] : '',
    scrollTop: typeof scrollTop === 'number' && Number.isFinite(scrollTop) ? scrollTop : 0,
    terminalPanelHeight:
      typeof terminalPanelHeight === 'number' && Number.isFinite(terminalPanelHeight) ? terminalPanelHeight : 280,
    filesPaneWidth: typeof filesPaneWidth === 'number' && Number.isFinite(filesPaneWidth) ? filesPaneWidth : 380,
    // 旧记录没有该字段时按收起处理：不替用户展开面板，只恢复浏览位置
    terminalOpen: raw['terminalOpen'] === true
  }
}

function sanitizeRegistry(raw: unknown): RegistryData | null {
  if (!isRecord(raw)) return null
  const projects = Array.isArray(raw['projects']) ? raw['projects'] : null
  if (projects === null) return null
  const viewStates = Array.isArray(raw['viewStates']) ? raw['viewStates'] : []

  const parsedProjects: Project[] = []
  for (const item of projects) {
    const project = sanitizeProject(item)
    if (project !== null) parsedProjects.push(project)
  }

  const parsedStates: ProjectViewState[] = []
  for (const item of viewStates) {
    const state = sanitizeViewState(item)
    if (state !== null) parsedStates.push(state)
  }

  return { projects: parsedProjects, viewStates: parsedStates }
}

export interface RegisterOutcome {
  status: 'added' | 'existing' | 'unavailable'
  project: Project | null
  message: string | null
}

/**
 * 重新定位的结果。
 *
 * `trustReset` 是安全语义的核心：一旦目录身份发生变化，原信任不再适用于新目录，
 * 必须由用户重新确认（设计稿 3.2「重新定位与信任重确认」）。
 */
export interface RelocateOutcome {
  status: 'relocated' | 'unchanged' | 'unavailable' | 'duplicate' | 'not-found'
  project: Project | null
  message: string
  /** 是否因路径身份变化而重置了信任状态 */
  trustReset: boolean
}

/** 计算目录的真实路径身份。失败表示目录不存在或不可访问。 */
export function computeIdentity(directory: string): { ok: true; identity: string } | { ok: false; reason: string } {
  if (typeof directory !== 'string' || directory.length === 0) {
    return { ok: false, reason: '路径为空' }
  }
  const candidate = resolve(directory)
  if (!existsSync(candidate)) {
    return { ok: false, reason: '目录不存在或不可访问' }
  }
  try {
    if (!statSync(candidate).isDirectory()) {
      return { ok: false, reason: '所选路径不是文件夹' }
    }
    // realpathSync.native 返回磁盘上的规范大小写，是跨写法去重的可靠依据
    const identity = realpathSync.native(candidate)
    return { ok: true, identity }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export class ProjectRegistry {
  constructor(private readonly store: JsonStore<RegistryData>) {}

  private data(): RegistryData {
    return this.store.read()
  }

  private persist(data: RegistryData): void {
    this.store.write(data)
  }

  list(): Project[] {
    return [...this.data().projects]
  }

  get(projectId: string): Project | null {
    return this.data().projects.find((project) => project.id === projectId) ?? null
  }

  /** 解析项目根目录；目录不可用时返回 null。主进程其他模块据此避免使用前端传入的路径。 */
  resolveRoot(projectId: string): { ok: true; root: string; project: Project } | { ok: false; reason: string } {
    const project = this.get(projectId)
    if (project === null) return { ok: false, reason: '项目未登记' }
    if (!existsSync(project.normalizedIdentity)) {
      return { ok: false, reason: '项目目录不可用（可能已被移动或删除）' }
    }
    try {
      if (!statSync(project.normalizedIdentity).isDirectory()) {
        return { ok: false, reason: '项目路径不再是文件夹' }
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true, root: project.normalizedIdentity, project }
  }

  register(directory: string): RegisterOutcome {
    const identityResult = computeIdentity(directory)
    if (!identityResult.ok) {
      return { status: 'unavailable', project: null, message: identityResult.reason }
    }

    const existing = this.data().projects.find((project) => project.normalizedIdentity === identityResult.identity)
    if (existing !== undefined) {
      return { status: 'existing', project: existing, message: '该目录已登记，未重复添加。' }
    }

    const project: Project = {
      id: randomUUID(),
      displayName: basename(identityResult.identity),
      originalPath: resolve(directory),
      normalizedIdentity: identityResult.identity,
      descriptionOverride: null,
      readmePath: null,
      pinned: false,
      lastOpenedAt: new Date().toISOString(),
      trusted: false,
      // 新登记项目一律默认关闭网络图片（设计稿 4.3：默认不加载）
      allowNetworkImages: false,
      isGitRepository: null
    }

    const data = this.data()
    this.persist({ ...data, projects: [...data.projects, project] })
    return { status: 'added', project, message: null }
  }

  /**
   * 把登记重新定位到另一个目录（设计稿 3.2）。
   *
   * 三条不可协商的规则：
   * 1. **新目录必须真实存在且是文件夹**，与登记时同样严格；
   * 2. **不得与其它已登记项目指向同一真实路径**，否则会产生两条记录指向一个目录；
   * 3. **目录身份一旦变化就重置信任**。信任授予的是「这个目录」，不是「这条记录」，
   *    换目录后沿用旧信任等于让用户在没有重新确认的情况下把写权限交给另一个目录。
   *
   * 重新定位不移动、不复制、不创建任何磁盘内容；旧目录原样保留。
   */
  relocate(projectId: string, directory: string): RelocateOutcome {
    const current = this.get(projectId)
    if (current === null) {
      return { status: 'not-found', project: null, message: '该项目不在登记列表中。', trustReset: false }
    }

    const identityResult = computeIdentity(directory)
    if (!identityResult.ok) {
      return {
        status: 'unavailable',
        project: current,
        message: `新目录不可用：${identityResult.reason}`,
        trustReset: false
      }
    }

    const occupied = this.data().projects.find(
      (project) => project.id !== projectId && project.normalizedIdentity === identityResult.identity
    )
    if (occupied !== undefined) {
      return {
        status: 'duplicate',
        project: current,
        message: `该目录已由「${occupied.displayName}」登记，未重复指向同一目录。`,
        trustReset: false
      }
    }

    if (identityResult.identity === current.normalizedIdentity) {
      return {
        status: 'unchanged',
        project: current,
        message: '新目录与当前登记位置相同，未做改动。',
        trustReset: false
      }
    }

    const trustReset = current.trusted
    const next: Project = {
      ...current,
      originalPath: resolve(directory),
      normalizedIdentity: identityResult.identity,
      // 身份变化即撤销信任：新目录必须重新确认后才允许写操作与终端
      trusted: false
    }

    const data = this.data()
    this.persist({
      ...data,
      projects: data.projects.map((project) => (project.id === projectId ? next : project))
    })

    return {
      status: 'relocated',
      project: next,
      message: trustReset
        ? '已重新定位到新目录。目录已变化，原信任已撤销，请重新确认后再执行写操作或使用终端。'
        : '已重新定位到新目录。',
      trustReset
    }
  }

  /** 移除登记。**只删除记录，不动磁盘文件**（设计稿 3.2）。 */
  remove(projectId: string): boolean {
    const data = this.data()
    const next = data.projects.filter((project) => project.id !== projectId)
    if (next.length === data.projects.length) return false
    this.persist({
      projects: next,
      viewStates: data.viewStates.filter((state) => state.projectId !== projectId)
    })
    return true
  }

  update(
    projectId: string,
    patch: Partial<
      Pick<
        Project,
        | 'pinned'
        | 'trusted'
        | 'displayName'
        | 'readmePath'
        | 'descriptionOverride'
        | 'isGitRepository'
        | 'allowNetworkImages'
      >
    >
  ): Project | null {
    const data = this.data()
    let updated: Project | null = null
    const projects = data.projects.map((project) => {
      if (project.id !== projectId) return project
      const next: Project = { ...project }
      if (patch.pinned !== undefined) next.pinned = patch.pinned
      if (patch.trusted !== undefined) next.trusted = patch.trusted
      if (patch.displayName !== undefined && patch.displayName.trim().length > 0) {
        next.displayName = patch.displayName.trim()
      }
      if (patch.readmePath !== undefined) next.readmePath = patch.readmePath
      if (patch.descriptionOverride !== undefined) next.descriptionOverride = patch.descriptionOverride
      if (patch.isGitRepository !== undefined) next.isGitRepository = patch.isGitRepository
      if (patch.allowNetworkImages !== undefined) next.allowNetworkImages = patch.allowNetworkImages
      updated = next
      return next
    })
    if (updated === null) return null
    this.persist({ ...data, projects })
    return updated
  }

  /** 记录最近打开时间 */
  touch(projectId: string): Project | null {
    const data = this.data()
    let updated: Project | null = null
    const projects = data.projects.map((project) => {
      if (project.id !== projectId) return project
      updated = { ...project, lastOpenedAt: new Date().toISOString() }
      return updated
    })
    if (updated === null) return null
    this.persist({ ...data, projects })
    return updated
  }

  getViewState(projectId: string): ProjectViewState | null {
    return this.data().viewStates.find((state) => state.projectId === projectId) ?? null
  }

  saveViewState(state: ProjectViewState): void {
    const data = this.data()
    const viewStates = data.viewStates.filter((item) => item.projectId !== state.projectId)
    viewStates.push(state)
    this.persist({ ...data, viewStates })
  }
}

/** 把持久化记录转为界面对象，附带运行时可用性判定。 */
export function toSummary(
  project: Project,
  resolveDescription: (project: Project) => { text: string | null; source: 'user' | 'readme' | 'path' }
): ProjectSummary {
  let available = true
  let unavailableReason: string | null = null
  try {
    if (!existsSync(project.normalizedIdentity)) {
      available = false
      unavailableReason = '目录不存在，可能已被移动、重命名或删除'
    } else if (!statSync(project.normalizedIdentity).isDirectory()) {
      available = false
      unavailableReason = '该路径当前不是文件夹'
    }
  } catch (error) {
    available = false
    unavailableReason = error instanceof Error ? error.message : String(error)
  }

  const description = resolveDescription(project)

  return {
    id: project.id,
    displayName: project.displayName,
    originalPath: project.originalPath,
    normalizedIdentity: project.normalizedIdentity,
    description: description.text,
    descriptionSource: description.source,
    readmePath: project.readmePath,
    pinned: project.pinned,
    lastOpenedAt: project.lastOpenedAt,
    trusted: project.trusted,
    isGitRepository: project.isGitRepository,
    allowNetworkImages: project.allowNetworkImages,
    available,
    unavailableReason
  }
}

export function createRegistry(store: JsonStore<RegistryData>): ProjectRegistry {
  return new ProjectRegistry(store)
}

export function createRegistryStore(filePath: string): JsonStore<RegistryData> {
  return new JsonStore<RegistryData>({
    filePath,
    version: STORE_VERSION,
    sanitize: sanitizeRegistry,
    createDefault: () => ({ projects: [], viewStates: [] })
  })
}
