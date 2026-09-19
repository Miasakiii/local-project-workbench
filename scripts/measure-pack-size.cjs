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
 *
 * 前置：先执行 `npm run pack:dir`（或 `npm run pack:win` 生成安装包）。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const RELEASE = path.join(ROOT, 'release')

/** 允许用 --dir=<路径> 指定其它产物目录（默认 release/win-unpacked）。 */
const dirArg = process.argv.find((item) => item.startsWith('--dir='))
const UNPACKED = dirArg === undefined ? path.join(RELEASE, 'win-unpacked') : path.resolve(dirArg.slice(6))

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

  console.log('\n=== 机器可读汇总 ===')
  console.log(
    JSON.stringify({
      unpackedMB: mb(total),
      localesMB: fs.existsSync(locales) ? mb(sizeOf(locales)) : null,
      installers: installers.map((item) => ({ name: item.name, MB: mb(item.bytes) }))
    })
  )
}

main()
