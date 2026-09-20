import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 路径安全解析层 —— 「项目 ID + 相对路径」的唯一校验入口。
 *
 * 对应设计稿 8.1 / 4.3 的不可协商约束：
 * - 前端不得传递任意绝对路径，主进程须复核真实路径。
 * - 校验须覆盖路径穿越、符号链接、目录联接，以及检查与执行之间的路径变化。
 *
 * 本模块不导入 Electron，可独立测试。
 *
 * 设计要点：
 * 1. **先判形态，再判归属。** 形态检查（绝对路径、盘符、UNC、ADS、设备名、
 *    尾随点与空格）在字符串层面完成，不触碰磁盘；归属检查基于真实路径
 *    （`realpath`）完成，因此符号链接与目录联接会被展开后比对，指向项目外的
 *    链接无法通过。
 * 2. **不存在的目标也要校验。** 新建文件场景下目标尚不存在，此时对「最近的
 *    已存在祖先目录」做真实路径解析，再拼回剩余片段，避免以「不存在」为由
 *    跳过归属检查。
 * 3. **大小写不敏感比较交由 `path.relative`。** 在 win32 上它按大小写不敏感
 *    方式比较根，符合 Windows 语义；不手工转小写（见风险 R3）。
 */

/** 路径被拒绝的原因。用判别字段而非字符串匹配来区分类型。 */
export type PathRejection =
  | 'empty'
  | 'not-a-string'
  | 'nul-byte'
  | 'absolute'
  | 'drive-relative'
  | 'unc'
  | 'device-path'
  | 'traversal'
  | 'ads'
  | 'trailing-dot-or-space'
  | 'outside-project'
  | 'not-found'
  | 'not-directory'
  | 'not-file'
  | 'io-error'

export interface ShapeCheck {
  ok: boolean
  /** 以 `/` 归一化后的相对路径；仅在 ok 时有意义 */
  normalized: string
  rejection: PathRejection | null
  detail: string
}

export interface PathResolution {
  ok: boolean
  /** 真实路径（已展开符号链接与目录联接）；被拒绝时为 null */
  absolutePath: string | null
  /** 归一化后的相对路径 */
  normalized: string
  /** 路径链上是否存在符号链接或目录联接 */
  viaReparsePoint: boolean
  rejection: PathRejection | null
  detail: string
}

/** Windows 保留设备名。这些名字在 Win32 下会被解析为设备而非文件。 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

const isWindows = process.platform === 'win32'

function fail(rejection: PathRejection, detail: string, normalized = ''): ShapeCheck {
  return { ok: false, normalized, rejection, detail }
}

/**
 * 形态检查：在字符串层面判断相对路径是否可接受。
 * 不访问磁盘，因此对不存在的路径同样有效。
 */
export function checkRelativeShape(input: unknown): ShapeCheck {
  if (typeof input !== 'string') return fail('not-a-string', '路径必须是字符串')
  if (input.length === 0) return fail('empty', '路径不能为空')
  if (input.includes('\0')) return fail('nul-byte', '路径包含 NUL 字节')

  // 统一分隔符后再判断。反斜杠在 Windows 上是分隔符，在 POSIX 上是合法文件名字符，
  // 但本项目第一版以 Windows 为主，统一按分隔符处理可避免 `..\..\` 形式的绕过。
  const unified = input.replace(/\\/g, '/')

  if (unified.startsWith('//')) return fail('unc', '不接受 UNC 路径（\\\\server\\share）')
  if (/^[a-zA-Z]:/.test(unified)) {
    // `C:foo` 是盘符相对路径，`C:\foo` 是绝对路径，两者都拒绝
    const isDriveRelative = unified.length > 2 && unified[2] !== '/'
    return fail(
      isDriveRelative ? 'drive-relative' : 'absolute',
      isDriveRelative ? '不接受盘符相对路径（C:foo）' : '不接受绝对路径（C:\\foo）'
    )
  }
  if (unified.startsWith('/')) return fail('absolute', '不接受绝对路径（/foo）')
  if (isAbsolute(input)) return fail('absolute', `不接受绝对路径（${input}）`)

  const segments: string[] = []
  for (const rawSegment of unified.split('/')) {
    if (rawSegment === '' || rawSegment === '.') continue
    if (rawSegment === '..') {
      // 允许 `..` 回退到项目内上层，但不得越过项目根。
      if (segments.length === 0) {
        return fail('traversal', '路径穿越：已越过项目根目录')
      }
      segments.pop()
      continue
    }
    if (isWindows) {
      if (rawSegment.includes(':')) {
        return fail('ads', `不接受备用数据流（ADS）写法：${rawSegment}`)
      }
      // Windows 会静默去除文件名尾部的点与空格，`a.` 与 `a` 指向同一文件，
      // 因此这类写法不能作为可区分的路径使用。
      if (/[. ]$/.test(rawSegment)) {
        return fail('trailing-dot-or-space', `文件名不得以点或空格结尾：${rawSegment}`)
      }
      const stem = rawSegment.split('.')[0]?.toLowerCase() ?? ''
      if (RESERVED_DEVICE_NAMES.has(stem)) {
        return fail('device-path', `不接受 Windows 保留设备名：${rawSegment}`)
      }
    }
    segments.push(rawSegment)
  }

  return { ok: true, normalized: segments.join('/'), rejection: null, detail: '形态检查通过' }
}

function safeRealpath(target: string): { ok: true; path: string } | { ok: false; detail: string } {
  try {
    return { ok: true, path: realpathSync.native(target) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 归属检查：目标真实路径必须位于项目根真实路径之内。
 *
 * 用 `path.relative` 判断包含关系：若结果以 `..` 开头或为绝对路径，说明越界。
 * 该方法在 win32 下按大小写不敏感比较根，符合 Windows 语义。
 */
export function isInside(realRoot: string, realTarget: string): boolean {
  const rel = relative(realRoot, realTarget)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  return !isAbsolute(rel)
}

/** 判断路径链上是否存在符号链接／目录联接（Windows 上二者均为重解析点）。 */
function detectReparsePoint(projectRoot: string, normalized: string): boolean {
  const parts = normalized.split('/').filter(Boolean)
  let current = projectRoot
  for (const part of parts) {
    current = resolve(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch {
      // 路径不存在时无法继续探测，到此为止
      return false
    }
  }
  return false
}

export interface ResolveOptions {
  /** 目标必须已存在（读取场景为 true，新建场景为 false） */
  mustExist?: boolean
  /** 期望的目标类型；不匹配时拒绝 */
  expect?: 'any' | 'file' | 'directory'
}

/**
 * 把「项目根 + 相对路径」解析为可安全使用的真实路径。
 *
 * 对不存在的目标：解析最近的已存在祖先目录的真实路径，再拼回剩余片段。
 * 这样既支持新建文件，也不会因为「目标不存在」而跳过归属检查。
 */
export function resolveProjectPath(
  projectRoot: string,
  relativePath: unknown,
  options: ResolveOptions = {}
): PathResolution {
  const shape = checkRelativeShape(relativePath)
  if (!shape.ok) {
    return {
      ok: false,
      absolutePath: null,
      normalized: shape.normalized,
      viaReparsePoint: false,
      rejection: shape.rejection,
      detail: shape.detail
    }
  }

  const rootReal = safeRealpath(projectRoot)
  if (!rootReal.ok) {
    return {
      ok: false,
      absolutePath: null,
      normalized: shape.normalized,
      viaReparsePoint: false,
      rejection: 'io-error',
      detail: `项目根目录不可解析：${rootReal.detail}`
    }
  }

  const viaReparsePoint = detectReparsePoint(rootReal.path, shape.normalized)
  const candidate = resolve(rootReal.path, shape.normalized)
  const targetReal = safeRealpath(candidate)

  let effectiveReal: string
  if (targetReal.ok) {
    effectiveReal = targetReal.path
  } else if (options.mustExist) {
    return {
      ok: false,
      absolutePath: null,
      normalized: shape.normalized,
      viaReparsePoint,
      rejection: 'not-found',
      detail: `目标不存在：${shape.normalized}`
    }
  } else {
    // 目标尚不存在：解析最近的已存在祖先，再拼回剩余片段
    const segments = shape.normalized.split('/').filter(Boolean)
    const remaining: string[] = []
    let probe = rootReal.path
    let resolved = rootReal.path

    for (let index = 0; index < segments.length; index += 1) {
      probe = resolve(probe, segments[index] as string)
      const step = safeRealpath(probe)
      if (step.ok) {
        resolved = step.path
        remaining.length = 0
      } else {
        for (let rest = index; rest < segments.length; rest += 1) {
          remaining.push(segments[rest] as string)
        }
        break
      }
    }

    effectiveReal = remaining.length > 0 ? resolve(resolved, ...remaining) : resolved
  }

  if (!isInside(rootReal.path, effectiveReal)) {
    return {
      ok: false,
      absolutePath: null,
      normalized: shape.normalized,
      viaReparsePoint,
      rejection: 'outside-project',
      detail: viaReparsePoint
        ? `拒绝通过符号链接或目录联接读取项目外路径：${shape.normalized}`
        : `目标真实路径位于项目之外：${shape.normalized}`
    }
  }

  const expect = options.expect ?? 'any'
  if (expect !== 'any' && targetReal.ok) {
    let isDirectory = false
    try {
      isDirectory = lstatSync(effectiveReal).isDirectory()
    } catch (error) {
      return {
        ok: false,
        absolutePath: null,
        normalized: shape.normalized,
        viaReparsePoint,
        rejection: 'io-error',
        detail: error instanceof Error ? error.message : String(error)
      }
    }
    if (expect === 'directory' && !isDirectory) {
      return {
        ok: false,
        absolutePath: null,
        normalized: shape.normalized,
        viaReparsePoint,
        rejection: 'not-directory',
        detail: `目标不是文件夹：${shape.normalized}`
      }
    }
    if (expect === 'file' && isDirectory) {
      return {
        ok: false,
        absolutePath: null,
        normalized: shape.normalized,
        viaReparsePoint,
        rejection: 'not-file',
        detail: `目标不是文件：${shape.normalized}`
      }
    }
  }

  return {
    ok: true,
    absolutePath: effectiveReal,
    normalized: shape.normalized,
    viaReparsePoint,
    rejection: null,
    detail: viaReparsePoint ? '通过（路径链含符号链接，已确认仍在项目内）' : '通过'
  }
}

/** 便捷判断：项目根与目标是否指向同一位置（用于去重与自引用防护）。 */
export function isSameLocation(a: string, b: string): boolean {
  const realA = safeRealpath(a)
  const realB = safeRealpath(b)
  if (!realA.ok || !realB.ok) return false
  return realA.path === realB.path
}

/** 项目内不得通过普通文件操作破坏的路径（设计稿第 7 章）。 */
export function isProtectedEntry(normalized: string): boolean {
  const first = normalized.split('/').filter(Boolean)[0]
  if (first === undefined) return true // 项目根本身
  return process.platform === 'win32' ? first.toLowerCase() === '.git' : first === '.git'
}
