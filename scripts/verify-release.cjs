/**
 * 发布验收：构建解包产物、校验体积门禁，并在真实打包目录上做端到端验证。
 *
 * 默认输出 `release/`，与旧的 `verify:release` 链路一致。可用
 * `--output=<目录>` 或 `WB_RELEASE_OUTPUT` 指定其它输出位置：部分本机环境
 * 会由外部进程长期占用工作区内的 `app.asar`，此时把产物放到工作区外仍可
 * 执行同一套验收，而不必放宽任何产品配置。
 */

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const outputArg = process.argv.find((item) => item.startsWith('--output='))
const OUTPUT = path.resolve(outputArg === undefined ? process.env.WB_RELEASE_OUTPUT ?? path.join(ROOT, 'release') : outputArg.slice(9))

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (result.error !== undefined) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status === null ? 1 : result.status)
}

run([path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'])
run([path.join(ROOT, 'scripts', 'build-icon.mjs')])
run([path.join(ROOT, 'scripts', 'prepare-electron-dist.cjs')])
run([
  path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
  '--dir',
  `--config.directories.output=${OUTPUT}`
])

const UNPACKED = path.join(OUTPUT, 'win-unpacked')
run([path.join(ROOT, 'scripts', 'measure-pack-size.cjs'), `--dir=${UNPACKED}`, '--max-unpacked-mb=340'])
run([path.join(ROOT, 'scripts', 'verify-packaged.cjs'), `--dir=${UNPACKED}`])
