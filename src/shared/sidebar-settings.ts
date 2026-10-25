/**
 * 侧栏开合偏好：主进程持久化与渲染层共享的同一份契约（P2-7）。
 *
 * 渲染层不再持有任何 localStorage 键：开合状态经 `settings.update` 落入
 * `settings.json`（见 `app-settings.ts`），与终端偏好同一通道。这里放两端的共识——
 * 默认值、落盘校验，以及旧 localStorage 键的一次性迁移解析——保证渲染层迁移
 * 与主进程复核不各自漂移。
 */

/** 默认展开；沿用 localStorage 时代「无值即展开」的默认行为 */
export const DEFAULT_SIDEBAR_OPEN = true

/** 旧版渲染层散落的 localStorage 键；迁移写入成功后即从渲染层清除 */
export const LEGACY_SIDEBAR_PREFERENCE_KEY = 'workbench.sidebarOpen'

/**
 * 落盘值校验：只接受布尔，其余一律回落默认（展开）。
 * settings.json 的读取与 `settings.update` 的入参共用此判定，损坏或被手改的
 * 字段不会让侧栏不可用。
 */
export function sanitizeSidebarPreference(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_SIDEBAR_OPEN
}

/**
 * 旧 localStorage 值的一次性迁移解析。
 *
 * 返回 null 表示键不存在、无需迁移；键存在时沿用旧读取语义
 * （`value !== 'false'` 即展开）：仅字符串 'false' 视为收起，其余一律展开，
 * 与迁移前 `readSidebarPreference` 的判定完全一致。
 */
export function parseLegacySidebarPreference(raw: string | null): boolean | null {
  if (raw === null) return null
  return raw !== 'false'
}
