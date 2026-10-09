import { checkRelativeShape } from '../security/path-guard'

/**
 * 单段名称校验 —— 新建与重命名入口共用。
 *
 * 从 `file-access.ts` 拆出（重构，行为不变）：名称必须是「单个文件或文件夹名」，
 * 不能包含路径分隔符，也不能是路径占位符；形态部分复用 path-guard 的检查，
 * 因此设备名、尾点尾空格等拒绝规则与路径层保持一致。
 *
 * 本模块不导入 Electron，可在纯 Node 下测试。
 */

interface NormalizedEntryName {
  ok: true
  normalized: string
}

interface InvalidEntryName {
  ok: false
  message: string
}

/** 所有新建、复制和重命名入口共用的单段名称校验。 */
export function normalizeEntryName(input: unknown): NormalizedEntryName | InvalidEntryName {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, message: '名称不能为空。' }
  }
  if (input.includes('/') || input.includes('\\')) {
    return { ok: false, message: '名称只能是单个文件或文件夹名称，不能包含路径分隔符。' }
  }
  const shape = checkRelativeShape(input)
  if (!shape.ok) return { ok: false, message: `名称不合法：${shape.detail}` }
  if (shape.normalized.length === 0 || shape.normalized === '.' || shape.normalized === '..') {
    return { ok: false, message: '名称不能是项目根目录或路径占位符。' }
  }
  return { ok: true, normalized: shape.normalized }
}

/** 重命名入口的新名称校验：与通用校验一致，仅失败措辞带「新名称」主语。 */
export function normalizeRenameName(input: unknown): NormalizedEntryName | InvalidEntryName {
  const result = normalizeEntryName(input)
  if (!result.ok) return { ok: false, message: `新名称不合法：${result.message}` }
  return result
}
