/**
 * 单元测试入口 —— 使用 Node 内置测试运行器，不引入第三方测试框架。
 *
 * 与既有集成验证脚本的分工：
 * - `tests/unit/` 只断言不依赖 Electron 的纯函数与本地存储行为，运行秒级；
 * - `scripts/verify-*.mts` 继续承担真实仓库、真实回收站、真实 Electron 的集成验证。
 *
 * 用法：
 *   node scripts/run-unit-tests.mjs              # 仅运行单元测试
 *   node scripts/run-unit-tests.mjs --coverage   # 运行并检查覆盖率门槛
 *
 * 覆盖率只对「有完整单元覆盖」的纯函数模块设门槛；Markdown 净化的结构性不变量
 * 由 `verify:fuzz-security` 覆盖，不在这里用低门槛冒充高覆盖。
 */

import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = join(ROOT, 'tests', 'unit')
const LOADER = pathToFileURL(join(ROOT, 'scripts', 'ts-loader', 'register.mjs')).href

/** 覆盖率门槛只覆盖这些纯函数模块。 */
const COVERAGE_INCLUDE = [
  'src/main/security/path-guard.ts',
  'src/main/modules/entry-name.ts',
  'src/main/modules/git-parse.ts',
  'src/main/modules/git-diff-parse.ts',
  'src/main/modules/app-settings.ts',
  'src/main/modules/shell-select.ts',
  'src/main/modules/file-op-common.ts',
  'src/main/modules/file-op-errors.ts',
  'src/main/modules/write-guard.ts',
  'src/main/storage/json-store.ts',
  'src/renderer/src/components/terminal-appearance.ts'
]

const testFiles = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mts'))
  .sort()
  .map((name) => join(TEST_DIR, name))

if (testFiles.length === 0) {
  console.error(`未找到单元测试文件：${TEST_DIR}`)
  process.exit(1)
}

const withCoverage = process.argv.includes('--coverage')
const args = [
  // 我们明确依赖 transform-types 与「无 type 字段」的源码导入方式：
  // 关掉这两类已知噪音，避免真正的警告被淹没。
  '--disable-warning=ExperimentalWarning',
  '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
  '--experimental-transform-types',
  '--import',
  LOADER,
  '--test'
]

if (withCoverage) {
  args.push('--experimental-test-coverage', '--test-coverage-exclude=tests/**')
  for (const pattern of COVERAGE_INCLUDE) args.push(`--test-coverage-include=${pattern}`)
  // 门槛刻意保守：宁可低一点，也不让门槛变成「为了让 CI 变绿而删测试」的诱因。
  args.push('--test-coverage-lines=70', '--test-coverage-functions=70', '--test-coverage-branches=55')
}

args.push(...testFiles)

console.log(`[unit] ${testFiles.length} 个测试文件${withCoverage ? '，覆盖率门槛已启用' : ''}`)

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })

child.on('error', (error) => {
  console.error('[unit] 无法启动测试运行器：', error)
  process.exitCode = 1
})

child.on('close', (code) => {
  process.exitCode = code ?? 1
})
