/**
 * Node 模块解析钩子：让主进程 TS 源码可以在纯 Node 下被验证脚本直接加载。
 *
 * 解决两个问题：
 *   1. 源码使用 `@shared/*` 别名，Node 无法解析。
 *   2. 源码的相对导入省略 `.ts` 扩展名，Node ESM 要求显式扩展名。
 *
 * 仅用于验证脚本，不参与打包。打包仍由 electron-vite 按 tsconfig 的 paths 处理。
 */

import { existsSync, statSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** src/shared 的绝对路径（本文件位于 scripts/ts-loader/） */
const SHARED_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shared')

/** 尝试为无扩展名的路径补全可解析的真实文件。 */
function completeWithExtension(candidate) {
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 忽略：回落到扩展名补全
    }
  }
  for (const suffix of ['.ts', '.mts', '.tsx', '/index.ts']) {
    const attempt = `${candidate}${suffix}`
    if (existsSync(attempt)) return attempt
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@shared/')) {
    const target = completeWithExtension(resolvePath(SHARED_ROOT, specifier.slice('@shared/'.length)))
    if (target !== null) return nextResolve(pathToFileURL(target).href, context)
  }

  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL)
    const target = completeWithExtension(resolvePath(dirname(parentPath), specifier))
    if (target !== null) return nextResolve(pathToFileURL(target).href, context)
  }

  return nextResolve(specifier, context)
}
