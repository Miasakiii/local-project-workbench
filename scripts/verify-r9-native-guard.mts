/**
 * R9 原生守卫：加载器契约。
 *
 * 原生 N-API 模块的**构建与竞态 E2E 需要原生 Windows 机器**（本环境禁派生进程、无 node-gyp、
 * 本项目 `npmRebuild:false`），故本套件只固定当前可验证的部分：
 *   1) 原生模块缺席时 `loadNativePathGuard()` 返回 null——主进程据此回退，行为不变、不依赖其存在；
 *   2) 加载可重复调用且稳定返回 null（探测为纯读、无副作用）；
 *   3) 模块包名常量与结果联合契约就绪，供 addon 与 file-access 集成时对齐。
 * `NativePathGuard` / `NativeGuardResult` 的接口形状由本文件引用在编译期保证（见下）。
 *
 * 不编译任何 C++、不发真实请求、不依赖显示会话。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-r9-native-guard.mts
 */

import type { NativeGuardResult, NativePathGuard } from '../src/main/security/native-guard.ts'
import { loadNativePathGuard, NATIVE_GUARD_MODULE } from '../src/main/security/native-guard.ts'

interface Check {
  name: string
  pass: boolean
  detail: string
}
const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

// 契约引用：加载器签名与结果联合（addon/file-access 集成时据此对齐）
const guardResults: NativeGuardResult[] = [{ ok: true }, { ok: false, rejection: 'outside-project' }]

function main(): void {
  console.log('=== R9 验证：原生守卫加载器契约 ===\n')

  const first: NativePathGuard | null = loadNativePathGuard()
  check('原生缺席时加载器返回 null（应用回退，不依赖其存在）', first === null, `value=${String(first)}`)

  const again: NativePathGuard | null = loadNativePathGuard()
  check('加载可重复调用且稳定返回 null', again === null && again === first, `stable=${String(again === first)}`)

  check(
    '原生模块包名常量就绪',
    typeof NATIVE_GUARD_MODULE === 'string' && NATIVE_GUARD_MODULE.length > 0,
    `module=${NATIVE_GUARD_MODULE}`
  )

  check(
    '结果联合契约可构造（ok 与带 rejection 两种）',
    guardResults.length === 2 && guardResults[0]?.ok === true && guardResults[1]?.ok === false,
    'ok / {ok:false, rejection}'
  )

  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${checks.length} 项通过`)
  process.exit(passed === checks.length ? 0 : 1)
}

main()
