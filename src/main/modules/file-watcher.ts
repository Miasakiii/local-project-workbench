import { existsSync, type FSWatcher, watch } from 'node:fs'
import { join, sep } from 'node:path'
import { IpcChannel } from '@shared/ipc'
import type { ProjectChangedEvent } from '@shared/types'
import type { WebContents } from 'electron'

/**
 * 受控文件监听（设计稿 5.3，M2-3）。
 *
 * 四条约束：
 * 1. **只监听活动项目。** 同一时刻最多一个项目被监听，切换项目即释放上一个。
 * 2. **不做无边界的内容监听。** 依赖目录与构建产物被忽略；`.git` 只关注
 *    HEAD／index 等元数据文件，不递归监听 objects。
 * 3. **事件合并。** 密集写入（例如保存一整批文件、构建输出）合并为一次刷新信号，
 *    并按窗口限流，避免事件风暴（风险 R5）。
 * 4. **监听只是刷新信号，不是事实来源。** 界面收到信号后重新读取文件与查询 Git，
 *    以重新读取的结果为准。
 */

/** 忽略的路径片段：依赖目录、构建产物、缓存与编辑器元数据 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.parcel-cache',
  'target',
  'venv',
  '.venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  '.cache',
  'coverage'
])

/** `.git` 下值得关注的元数据文件：提交、切换分支、暂存都会改动它们 */
const GIT_METADATA_FILES = new Set(['HEAD', 'index', 'MERGE_HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'CHERRY_PICK_HEAD'])

const DEBOUNCE_MS = 400
/** 单次事件中最多列出的路径数；超出只给汇总 */
const MAX_PATHS = 20
/** 窗口内的事件数上限，超过即按批量处理 */
const MAX_EVENTS_PER_WINDOW = 400
const WINDOW_MS = 1000
/** 两次下发之间的最小间隔，防止高频写入把界面刷爆 */
const MIN_EMIT_INTERVAL_MS = 700

function isIgnored(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/)
  for (const segment of segments) {
    if (IGNORED_SEGMENTS.has(segment)) return true
  }
  // 编辑器临时文件与系统文件
  const name = segments[segments.length - 1] ?? ''
  if (name.endsWith('.swp') || name.endsWith('.tmp') || name.endsWith('~')) return true
  if (name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini') return true
  return false
}

function normalizeRelative(root: string, target: string): string | null {
  if (!target.startsWith(root)) return null
  const relative = target.slice(root.length).replace(/^[\\/]+/, '')
  return relative.split(sep).join('/')
}

export class ProjectWatcher {
  private projectId: string | null = null
  private root: string | null = null
  private sender: WebContents | null = null
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private readonly pending = new Set<string>()
  private bulk = false
  private eventCount = 0
  private windowStartedAt = 0
  private lastEmitAt = 0

  get activeProjectId(): string | null {
    return this.projectId
  }

  /** 切换活动项目。传入 null 表示回到项目库，停止监听。 */
  setActive(projectId: string | null, root: string | null, sender: WebContents): void {
    if (this.projectId === projectId && this.root === root) {
      this.sender = sender
      return
    }

    this.dispose()
    this.sender = sender
    if (projectId === null || root === null) return

    this.projectId = projectId
    this.root = root

    try {
      // 递归监听项目根：Windows 上为单个句柄，事件量由忽略规则控制
      this.watchers.push(
        watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
          const name = filename === null ? null : String(filename)
          if (name === null) {
            this.record('', true)
            return
          }
          if (isIgnored(name)) return
          this.record(name.split(sep).join('/'), false)
        })
      )
    } catch (error) {
      console.warn(`[监听] 无法监听项目根目录：${String(error)}`)
    }

    // `.git` 单独非递归监听：只关心元数据文件，不触碰 objects
    const gitDir = join(root, '.git')
    if (existsSync(gitDir)) {
      try {
        this.watchers.push(
          watch(gitDir, { persistent: false }, (_eventType, filename) => {
            const name = filename === null ? null : String(filename)
            if (name === null) {
              this.record('', true)
              return
            }
            if (!GIT_METADATA_FILES.has(name) && !name.startsWith('refs')) return
            this.record(`.git/${name.split(sep).join('/')}`, false)
          })
        )
      } catch (error) {
        console.warn(`[监听] 无法监听 .git 元数据：${String(error)}`)
      }
    }
  }

  private record(relativePath: string, forceBulk: boolean): void {
    const now = Date.now()
    if (now - this.windowStartedAt > WINDOW_MS) {
      this.windowStartedAt = now
      this.eventCount = 0
    }
    this.eventCount += 1
    if (forceBulk || this.eventCount > MAX_EVENTS_PER_WINDOW) this.bulk = true

    if (relativePath.length > 0) {
      if (this.pending.size < MAX_PATHS) this.pending.add(relativePath)
      else this.bulk = true
    }

    if (this.timer !== null) return
    const elapsed = now - this.lastEmitAt
    const delay = Math.max(DEBOUNCE_MS, MIN_EMIT_INTERVAL_MS - elapsed)
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, delay)
  }

  private flush(): void {
    const sender = this.sender
    const projectId = this.projectId
    if (sender === null || projectId === null) {
      this.pending.clear()
      this.bulk = false
      return
    }
    if (sender.isDestroyed()) {
      this.dispose()
      return
    }

    const payload: ProjectChangedEvent = {
      projectId,
      paths: [...this.pending],
      bulk: this.bulk,
      at: new Date().toISOString()
    }
    this.pending.clear()
    this.bulk = false
    this.lastEmitAt = Date.now()

    sender.send(IpcChannel.watcherChanged, payload)
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        // 忽略：监听可能已自行关闭
      }
    }
    this.watchers = []
    this.pending.clear()
    this.bulk = false
    this.eventCount = 0
    this.projectId = null
    this.root = null
    this.sender = null
  }
}

/** 供诊断与测试：判断某个相对路径是否会被忽略。 */
export function isWatchedPath(relativePath: string): boolean {
  if (relativePath.length === 0) return true
  if (relativePath.startsWith('.git/')) {
    const name = relativePath.slice('.git/'.length)
    return GIT_METADATA_FILES.has(name) || name.startsWith('refs')
  }
  return !isIgnored(relativePath)
}

export { DEBOUNCE_MS, MAX_PATHS, normalizeRelative }
