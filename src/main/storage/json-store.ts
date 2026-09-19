import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 应用元数据存储（M0 原型阶段）。
 *
 * 设计稿 8.4 建议第一版使用 SQLite，M0/M1 阶段以「具备安全写入机制的配置文件」过渡。
 * 本实现提供三件事：
 *   1. **原子写入**：先写临时文件再重命名，避免断电或崩溃留下半截文件。
 *   2. **损坏容错**：解析失败时保留损坏文件并回退到默认值，不静默丢数据。
 *   3. **版本字段**：为后续迁移留出判别依据。
 *
 * 元数据一律写入应用数据目录，**不向用户项目写入任何配置文件**。
 */
export interface StoreEnvelope<T> {
  version: number
  data: T
}

export interface StoreOptions<T> {
  filePath: string
  version: number
  /** 校验并修复读入的数据；返回 null 表示不可用，回退默认值 */
  sanitize: (raw: unknown) => T | null
  createDefault: () => T
}

export class JsonStore<T> {
  private cache: T | null = null

  constructor(private readonly options: StoreOptions<T>) {}

  get path(): string {
    return this.options.filePath
  }

  read(): T {
    if (this.cache !== null) return this.cache

    if (!existsSync(this.options.filePath)) {
      this.cache = this.options.createDefault()
      return this.cache
    }

    try {
      const text = readFileSync(this.options.filePath, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && 'data' in (parsed as Record<string, unknown>)) {
        const envelope = parsed as StoreEnvelope<unknown>
        const sanitized = this.options.sanitize(envelope.data)
        if (sanitized !== null) {
          this.cache = sanitized
          return this.cache
        }
      }
      this.quarantine('结构不符合预期')
    } catch (error) {
      this.quarantine(error instanceof Error ? error.message : String(error))
    }

    this.cache = this.options.createDefault()
    return this.cache
  }

  write(value: T): void {
    this.cache = value
    const envelope: StoreEnvelope<T> = { version: this.options.version, data: value }
    const serialized = JSON.stringify(envelope, null, 2)

    mkdirSync(dirname(this.options.filePath), { recursive: true })

    // 原子写入：临时文件 → 重命名覆盖
    const temporaryPath = `${this.options.filePath}.tmp`
    writeFileSync(temporaryPath, serialized, 'utf8')
    try {
      renameSync(temporaryPath, this.options.filePath)
    } catch {
      // 某些文件系统上重命名覆盖会失败，退回直接写入并清理临时文件
      writeFileSync(this.options.filePath, serialized, 'utf8')
      try {
        rmSync(temporaryPath, { force: true })
      } catch {
        // 忽略
      }
    }
  }

  /** 把无法解析的文件改名保留，便于事后诊断，而不是直接丢弃。 */
  private quarantine(reason: string): void {
    try {
      const backup = `${this.options.filePath}.corrupt-${Date.now()}`
      renameSync(this.options.filePath, backup)
      console.warn(`[存储] 元数据不可用（${reason}），已保留为 ${backup}，本次使用默认值。`)
    } catch (error) {
      console.warn(`[存储] 元数据不可用（${reason}），且无法保留副本：${String(error)}`)
    }
  }

  /** 仅用于测试：丢弃内存缓存 */
  invalidate(): void {
    this.cache = null
  }
}
