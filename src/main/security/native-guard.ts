import type { PathRejection } from './path-guard'

/**
 * 句柄级原生写守卫 —— R9 的「闭合」方向（设计稿 4.2 / 8.1 的写安全）。
 *
 * 交付形态：一个 N-API 原生模块（与 node-pty 同策略：N-API、与 Electron/Node ABI 无关、
 * `npmRebuild:false`、electron-builder `asarUnpack`）。它把「先解析校验、再按路径操作」改为
 * 「按句柄校验并即按该句柄操作」——打开源/父目录句柄时用 `FILE_FLAG_OPEN_REPARSE_POINT`
 * （开的是重解析点本体而非其目标）、以 `GetFinalPathNameByHandle` 复核归属、再以
 * `SetFileInformationByHandle(FileRenameInfo)` 等按句柄完成变更，从根上消除「检查与执行之间
 * 被换入重解析点」的 TOCTOU 窗口。
 *
 * 设计、构建与竞态 E2E runbook：docs/plan/R9-句柄级原生守卫-设计与构建.md。
 *
 * **当前构建产物不含该原生模块**，`loadNativePathGuard()` 因此返回 `null`；主进程据此回退到
 * 现有 `path-guard` + Node fs 流程，行为与今天完全一致（`verify:m3-file-ops` 等即回退契约）。
 *
 * 边界：`delete → 系统回收站`即便原生也不按句柄闭合——回收站 API 是路径型的，按句柄硬删会违反
 * 「绝不降级为永久删除」基线；故 delete 不在本契约内，仍为已登记残余。
 */

/** 原生守卫必须满足的接口（编译期契约）。addon 与 file-access 集成时据此对齐。 */
export interface NativePathGuard {
  /** 在已校验的项目内原子新建文件／文件夹；目标已存在即失败（不覆盖） */
  createByHandle(root: string, parentRelativePath: string, name: string, kind: 'file' | 'folder'): NativeGuardResult
  /** 同一父目录内按句柄改名 */
  renameByHandle(root: string, sourceRelativePath: string, targetRelativePath: string): NativeGuardResult
  /** 按句柄移动到另一父目录（改名／移动合一） */
  moveByHandle(
    root: string,
    sourceRelativePath: string,
    targetParentRelativePath: string,
    name: string
  ): NativeGuardResult
  /** 按句柄复制：源与目标两端均按句柄打开并复核 */
  copyByHandle(root: string, sourceRelativePath: string, targetRelativePath: string): NativeGuardResult
}

/** 与纯 Node 侧判别对齐：成功或带 `PathRejection` 的失败（`path-changed` 亦同），不抛异常。 */
export type NativeGuardResult = { ok: true } | { ok: false; rejection: PathRejection }

/** 未来 N-API addon 的包名（供特性探测与 asarUnpack 规则一致使用）。 */
export const NATIVE_GUARD_MODULE = 'local-project-workbench-native-guard'

let cached: NativePathGuard | null | undefined

/**
 * 特性探测式加载原生守卫。**当前返回 `null`**（原生模块尚未构建）；应用不依赖其存在，
 * 返回 null 即走回退。模块就绪后，此处改为经 `createRequire` 加载、校验接口形状并缓存，
 * 加载失败同样回退为 null（绝不因加载异常影响主流程）。
 */
export function loadNativePathGuard(): NativePathGuard | null {
  if (cached !== undefined) return cached
  cached = null
  return cached
}
