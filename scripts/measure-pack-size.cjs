/**
 * 分发体积实测。
 *
 * 与 `measure:m0-7` 的区别：那个脚本给的是**投影值**（把 Electron 运行时、
 * 应用产物、原生依赖相加再按 gzip 比折算），本脚本直接测量 electron-builder
 * 的真实产物，并对体积构成做分解，便于定位「哪一项又长胖了」。
 *
 * 用法：
 *   node scripts/measure-pack-size.cjs            # 测量 release/ 下的产物
 *   node scripts/measure-pack-size.cjs --json     # 额外输出机器可读汇总
 *   node scripts/measure-pack-size.cjs --max-unpacked-mb=340
 *   node scripts/measure-pack-size.cjs --max-installer-mb=110
 *
 * 体积门槛用于防止「功能没变、产物悄悄长胖」：超限以非零退出码失败，
 * 而不是只在日志里留一个数字。
 *
 * 前置：先执行 `npm run pack:dir`（或 `npm run pack:win` 生成安装包）。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

/** 允许用 --dir=<路径> 指定其它产物目录（默认 release/win-unpacked）。 */
const dirArg = process.argv.find((item) => item.startsWith('--dir='))
const UNPACKED = dirArg === undefined ? path.join(ROOT, 'release', 'win-unpacked') : path.resolve(dirArg.slice(6))
/** 安装包与解包目录同属一个输出目录；--dir 指向其它位置时随之切换。 */
const RELEASE = path.dirname(UNPACKED)

/** 可选体积门槛（MB）；超限以退出码 1 失败。 */
function readLimit(prefix) {
  const arg = process.argv.find((item) => item.startsWith(prefix))
  if (arg === undefined) return null
  const value = Number(arg.slice(prefix.length))
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`无法解析体积门槛：${arg}`)
    process.exit(1)
  }
  return value
}

const MAX_UNPACKED_MB = readLimit('--max-unpacked-mb=')
const MAX_INSTALLER_MB = readLimit('--max-installer-mb=')

/** 目录或文件的字节数；目录递归累加。 */
function sizeOf(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) return stat.size

  let total = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        total += fs.lstatSync(full).size
      } catch {
        // 忽略：打包过程中文件可能正被占用
      }
    }
  }
  return total
}

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10

/** 按体积降序列出某个目录的直接子项。 */
function breakdown(directory, limit = 12) {
  let entries
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .map((entry) => ({ name: entry.name, bytes: sizeOf(path.join(directory, entry.name)) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, limit)
}

function main() {
  if (!fs.existsSync(UNPACKED)) {
    console.error(`未找到打包产物：${path.relative(ROOT, UNPACKED)}`)
    console.error('请先执行 npm run pack:dir。')
    process.exit(1)
  }

  const total = sizeOf(UNPACKED)

  console.log('=== 分发体积实测（electron-builder 真实产物）===\n')
  console.log(`解包目录：${path.relative(ROOT, UNPACKED)}`)
  console.log(`解包体积：${mb(total)} MB\n`)

  console.log('--- 顶层构成 ---')
  for (const item of breakdown(UNPACKED)) {
    const share = ((item.bytes / total) * 100).toFixed(1)
    console.log(`  ${String(mb(item.bytes)).padStart(8)} MB  ${String(share).padStart(5)}%  ${item.name}`)
  }

  const resources = path.join(UNPACKED, 'resources')
  if (fs.existsSync(resources)) {
    console.log('\n--- resources 内部 ---')
    for (const item of breakdown(resources, 8)) {
      console.log(`  ${String(mb(item.bytes)).padStart(8)} MB  ${item.name}`)
    }
  }

  const locales = path.join(UNPACKED, 'locales')
  if (fs.existsSync(locales)) {
    const count = fs.readdirSync(locales).length
    console.log(`\n语言包：${count} 个，共 ${mb(sizeOf(locales))} MB`)
  }

  const asarUnpacked = path.join(resources, 'app.asar.unpacked')
  if (fs.existsSync(asarUnpacked)) {
    console.log('\n--- asar 解包内容（原生模块）---')
    for (const item of breakdown(path.join(asarUnpacked, 'node_modules'), 6)) {
      console.log(`  ${String(mb(item.bytes)).padStart(8)} MB  ${item.name}`)
    }
  }

  let installers = []
  try {
    installers = fs
      .readdirSync(RELEASE)
      .filter((name) => name.endsWith('.exe'))
      .map((name) => ({ name, bytes: sizeOf(path.join(RELEASE, name)) }))
  } catch {
    // 尚未生成安装包
  }

  if (installers.length > 0) {
    console.log('\n--- 安装包 ---')
    for (const installer of installers) {
      console.log(`  ${String(mb(installer.bytes)).padStart(8)} MB  ${installer.name}`)
    }
  } else {
    console.log('\n安装包：尚未生成（运行 npm run pack:win 后此项才有值）')
  }

  const failures = []
  if (MAX_UNPACKED_MB !== null && total > MAX_UNPACKED_MB * 1024 * 1024) {
    failures.push(`解包体积 ${mb(total)} MB 超过上限 ${MAX_UNPACKED_MB} MB`)
  }
  if (MAX_INSTALLER_MB !== null) {
    if (installers.length === 0) {
      failures.push(`未找到安装包，无法校验 ${MAX_INSTALLER_MB} MB 上限`)
    } else {
      for (const installer of installers) {
        if (installer.bytes > MAX_INSTALLER_MB * 1024 * 1024) {
          failures.push(`安装包 ${installer.name} 为 ${mb(installer.bytes)} MB，超过上限 ${MAX_INSTALLER_MB} MB`)
        }
      }
    }
  }

  console.log('\n=== 体积门槛 ===')
  if (MAX_UNPACKED_MB === null && MAX_INSTALLER_MB === null) {
    console.log('未设置门槛（仅测量）')
  } else {
    for (const item of failures) console.error(`✗ ${item}`)
    if (failures.length === 0) {
      console.log(
        `✓ 通过${MAX_UNPACKED_MB === null ? '' : `（解包 ≤ ${MAX_UNPACKED_MB} MB）`}${MAX_INSTALLER_MB === null ? '' : `（安装包 ≤ ${MAX_INSTALLER_MB} MB）`}`
      )
    }
  }

  console.log('\n=== 机器可读汇总 ===')
  console.log(
    JSON.stringify({
      unpackedMB: mb(total),
      localesMB: fs.existsSync(locales) ? mb(sizeOf(locales)) : null,
      installers: installers.map((item) => ({ name: item.name, MB: mb(item.bytes) })),
      limits: { unpackedMB: MAX_UNPACKED_MB, installerMB: MAX_INSTALLER_MB },
      failures
    })
  )

  if (failures.length > 0) process.exit(1)
}

main()
