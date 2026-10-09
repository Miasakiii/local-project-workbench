import type { FileOperationReason, FileOperationStatus } from '@shared/types'
import {
  isProtectedEntry,
  isSameLocation,
  type PathRejection,
  type ResolveOptions,
  resolveProjectPath
} from '../security/path-guard'

/**
 * 写操作目标解析 —— 所有会改动磁盘的路径都只经此入口取得绝对路径。
 *
 * 从 `file-access.ts` 拆出（重构，行为不变）：这里是「相对路径 → 可写真实路径」的
 * 判定顺序本体，即 README 安全边界中「判定顺序含归一化**后**再查受保护项」的落地处；
 * `file-access.ts` 的四个写入口共用它，将来的句柄级原生守卫（R9）也按这两个函数
 * 作为集成接缝。
 *
 * 本模块不导入 Electron，可在纯 Node 下测试。
 */

/**
 * 文件操作层的路径拒绝码：沿用 path-guard 的取值，并补充 `invalid-path`
 * 用于「形态检查未通过但无法归入具体原因」的情形。
 */
export type FileRejection = PathRejection | 'invalid-path'

/** 一个写目标被统一守卫拒绝后的表达。 */
export interface WriteRejection {
  ok: false
  /** 拒绝只会是「失败」或「未执行」，不会出现「成功」 */
  status: Exclude<FileOperationStatus, 'ok'>
  reason: FileOperationReason
  message: string
}

interface WriteTargetOk {
  ok: true
  /** 已确认可用于写操作的真实路径 */
  absolutePath: string
  /** 折叠 `..` 与重复分隔符之后的项目内相对路径 */
  relativePath: string
}

/** 写目标的解析结果：要么拿到可用于磁盘操作的真实路径，要么带着可直接上报的拒绝。 */
export type WriteTarget = WriteTargetOk | WriteRejection

export interface WriteGuardWording {
  /** 路径链上有符号链接或目录联接 */
  viaReparsePoint: string
  /** 命中项目根或 `.git` 元数据 */
  protectedEntry: (normalized: string) => string
  /** 形态、归属或类型检查未通过 */
  unresolvable: (
    input: string,
    rejection: FileRejection,
    detail: string
  ) => {
    reason: FileOperationReason
    message: string
  }
}

interface WriteGuardOptions extends ResolveOptions {
  /** 目录类目标允许就是项目根（新建的父目录、粘贴目标目录）；项级目标不允许 */
  allowProjectRoot?: boolean
  wording: WriteGuardWording
}

/** 受保护项按「未执行」报告，其余写拒绝按「失败」。 */
function rejectProtected(message: string): WriteRejection {
  return { ok: false, status: 'skipped', reason: 'protected-entry', message }
}

function rejectWrite(reason: FileOperationReason, message: string): WriteRejection {
  return { ok: false, status: 'failed', reason, message }
}

/**
 * 写操作目标解析——所有会改动磁盘的路径都只经此入口取得绝对路径。
 *
 * 判定顺序即安全边界，四步缺一不可：
 * 1. 原始输入命中项目根或 `.git` → 拒绝；
 * 2. 形态与归属检查（穿越、绝对路径、项目外、目录类型）；
 * 3. 路径链上存在符号链接或目录联接 → 拒绝，写操作不经过链接；
 * 4. **折叠 `..` 之后再查一次受保护项**。
 *
 * 第 4 步不是冗余：`sub/../.git` 的原始输入首段是 `sub`，只有第 4 步能看出它
 * 归一化后就是 `.git`。缺这一步会让「`.git` 元数据不提供写操作」这条边界失效。
 */
export function resolveForWrite(projectRoot: string, input: string, options: WriteGuardOptions): WriteTarget {
  const allowProjectRoot = options.allowProjectRoot ?? false
  const { wording } = options

  const isProtected = (candidate: string): boolean =>
    candidate.length > 0 ? isProtectedEntry(candidate) : !allowProjectRoot

  if (isProtected(input)) {
    return rejectProtected(wording.protectedEntry(input))
  }

  const resolution = resolveProjectPath(projectRoot, input, {
    mustExist: options.mustExist,
    expect: options.expect
  })
  if (!resolution.ok || resolution.absolutePath === null) {
    const rejection = resolution.rejection ?? 'invalid-path'
    const detail = wording.unresolvable(input, rejection, resolution.detail)
    return rejectWrite(detail.reason, detail.message)
  }
  if (resolution.viaReparsePoint) {
    return rejectWrite('invalid-path', wording.viaReparsePoint)
  }
  if (isProtected(resolution.normalized)) {
    return rejectProtected(wording.protectedEntry(resolution.normalized))
  }

  return {
    ok: true,
    absolutePath: resolution.absolutePath,
    relativePath: resolution.normalized
  }
}

/** 目录类写目标（新建的父目录、粘贴目标目录）；空串表示项目根。 */
export function resolveDirectoryForWrite(
  projectRoot: string,
  relativePath: string,
  wording: WriteGuardWording
): WriteTarget {
  return resolveForWrite(projectRoot, relativePath.length > 0 ? relativePath : '.', {
    mustExist: true,
    expect: 'directory',
    allowProjectRoot: true,
    wording
  })
}

/**
 * 执行后复核：目标必须仍然存在、类型符合预期、真实路径与执行前一致，且路径链上
 * 没有出现链接。`unstable` 供各入口补充自身条件（如「剪切后源项必须已消失」）。
 *
 * 只要这里返回 false，调用方就**不得报告成功**——系统调用返回不等于用户可确认的结果。
 */
export function writtenTargetIntact(
  projectRoot: string,
  targetRelativePath: string,
  expect: 'any' | 'file' | 'directory',
  absolutePathBefore: string,
  unstable?: () => boolean
): boolean {
  const targetAfter = resolveProjectPath(projectRoot, targetRelativePath, { mustExist: true, expect })
  return !!(
    targetAfter.ok &&
    targetAfter.absolutePath !== null &&
    !targetAfter.viaReparsePoint &&
    isSameLocation(targetAfter.absolutePath, absolutePathBefore) &&
    !unstable?.()
  )
}
