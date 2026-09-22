import type { SettingsResult } from '@shared/ipc'
import { JsonStore } from '../storage/json-store'

/**
 * 应用级偏好（C09 / 验收场景 10「恢复上次项目」）。
 *
 * 承载三件事，且都写在应用数据目录：
 * - `restoreLastProject`：开关，**默认关闭**；
 * - `lastProjectId`：上次活跃于哪个项目，由主进程在用户打开项目时记录；
 * - `editorPath`：「用指定编辑器打开」所用的编辑器可执行路径（设计稿 4.2，G3b）。
 *
 * 刻意与 `projects.json` 分开存放：开关是应用属性，不是项目属性。移除登记、
 * 重新定位都不该改动它——能否恢复由启动那一刻的实际情况决定，见 `decideStartupView`。
 */

const STORE_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function sanitizeSettings(raw: unknown): SettingsResult | null {
  if (!isRecord(raw)) return null
  const last = raw['lastProjectId']
  const editor = raw['editorPath']
  return {
    restoreLastProject: raw['restoreLastProject'] === true,
    lastProjectId: typeof last === 'string' && last.length > 0 ? last : null,
    editorPath: typeof editor === 'string' && editor.length > 0 ? editor : null
  }
}

/** 上次项目在启动时刻的可恢复性；由调用方查登记表与磁盘后填入，使判定本身不碰文件系统。 */
export type StartupProjectState =
  | { status: 'available' }
  | { status: 'unregistered' }
  | { status: 'unavailable'; displayName: string; reason: string }

/** 恢复决策。开关状态由调用方补回，见 `StartupViewResult`。 */
export interface StartupView {
  projectId: string | null
  notice: string | null
}

export class AppSettingsStore {
  constructor(private readonly store: JsonStore<SettingsResult>) {}

  get(): SettingsResult {
    return this.store.read()
  }

  setRestoreLastProject(enabled: boolean): SettingsResult {
    const next: SettingsResult = { ...this.get(), restoreLastProject: enabled === true }
    this.store.write(next)
    return next
  }

  /** 「用指定编辑器打开」所用的编辑器路径；null 或空串表示清空（回到未设置）。 */
  setEditorPath(path: string | null): SettingsResult {
    const next: SettingsResult = {
      ...this.get(),
      editorPath: typeof path === 'string' && path.length > 0 ? path : null
    }
    this.store.write(next)
    return next
  }

  /**
   * 记录「用户此刻在哪个项目」。
   *
   * 关闭项目时**不清除**：恢复的语义是「上次打开的那个项目」，
   * 而不是「退出瞬间还挂着的那个」；用户回到项目库再启动，仍该回到刚才干活的地方。
   */
  recordActiveProject(projectId: string): void {
    if (typeof projectId !== 'string' || projectId.length === 0) return
    const current = this.get()
    if (current.lastProjectId === projectId) return
    this.store.write({ ...current, lastProjectId: projectId })
  }
}

/** 判定只需要登记表的这两项能力，因此不依赖 `ProjectRegistry` 本身。 */
export interface StartupRegistryView {
  get(projectId: string): { displayName: string } | null
  resolveRoot(projectId: string): { ok: true } | { ok: false; reason: string }
}

/**
 * 把登记表与磁盘现状包成恢复判定所需的查询。
 *
 * 「先查记录、再查目录」的顺序有意义：记录不在是「已移除登记」，
 * 记录在但目录不在是「目录不可用」，两者的用户说明与下一步动作不同。
 */
export function createStartupLookup(registry: StartupRegistryView): (projectId: string) => StartupProjectState {
  return (projectId) => {
    const project = registry.get(projectId)
    if (project === null) return { status: 'unregistered' }
    const resolved = registry.resolveRoot(projectId)
    if (!resolved.ok) {
      return { status: 'unavailable', displayName: project.displayName, reason: resolved.reason }
    }
    return { status: 'available' }
  }
}

/**
 * 启动时应打开哪里。三种情形分别表达：
 *
 * 1. 开关关闭、或从未打开过项目 → 停留项目库，**不解释**（这是默认状态，不是异常）；
 * 2. 开关开启且上次项目可用 → 直接打开它；
 * 3. 开关开启但恢复不了（登记已移除、目录已不可用）→ 停留项目库并**说明原因**，
 *    不把「没能恢复」显示成「什么都没有」。
 *
 * 判定只看目录可用性，不看信任：恢复的是浏览位置，写操作与终端仍需用户重新确认。
 */
export function decideStartupView(
  settings: SettingsResult,
  lookup: (projectId: string) => StartupProjectState
): StartupView {
  if (settings.restoreLastProject !== true || settings.lastProjectId === null) {
    return { projectId: null, notice: null }
  }

  const projectId = settings.lastProjectId
  const state = lookup(projectId)

  if (state.status === 'available') return { projectId, notice: null }
  if (state.status === 'unregistered') {
    return { projectId: null, notice: '上次的项目已不在登记列表中，已停留在项目库。' }
  }
  return {
    projectId: null,
    notice: `上次的项目「${state.displayName}」当前不可用：${state.reason}。已停留在项目库，重新定位后可继续。`
  }
}

export function createSettingsStore(filePath: string): AppSettingsStore {
  return new AppSettingsStore(
    new JsonStore<SettingsResult>({
      filePath,
      version: STORE_VERSION,
      sanitize: sanitizeSettings,
      createDefault: () => ({ restoreLastProject: false, lastProjectId: null, editorPath: null })
    })
  )
}
