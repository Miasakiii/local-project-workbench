/**
 * 准备一份「已裁剪语言包」的 Electron 运行时目录，供 electron-builder 打包使用。
 *
 * 为什么不直接用 electron-builder 的 `electronLanguages`：
 *   它的做法是先把 55 个语言包（49 MB）全部复制进产物，再逐个删掉不需要的 53 个。
 *   而裁剪本身完全可以在复制阶段完成——只复制需要的两个语言包，全程没有任何删除动作。
 *   结果是：产物一致、少一轮 49 MB 的写入与删除，且不依赖任何事后清理。
 *
 * 用法：node scripts/prepare-electron-dist.cjs
 * 产物：build/electron-dist/（已被 .gitignore 忽略）
 *
 * 幂等：源版本与语言包清单未变时直接复用，不重复复制。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SOURCE = path.join(ROOT, 'node_modules', 'electron', 'dist')
const TARGET = path.join(ROOT, 'build', 'electron-dist')
// 标记放在目标目录之外：目标目录会被整体复制进产物，标记留在里面会成为多余文件
const MARKER = path.join(ROOT, 'build', 'electron-dist.marker.json')

/** 界面语言为简体中文；保留英文以便系统区域为 en 时仍有正常回退。 */
const KEEP_LOCALES = ['zh-CN.pak', 'en-US.pak']

function readSourceVersion() {
  try {
    return fs.readFileSync(path.join(SOURCE, 'version'), 'utf8').trim()
  } catch {
    return null
  }
}

function isUpToDate(version) {
  try {
    const marker = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
    return marker.version === version && JSON.stringify(marker.locales) === JSON.stringify(KEEP_LOCALES)
  } catch {
    return false
  }
}

/**
 * 递归复制。`locales` 目录只取 KEEP_LOCALES 中的文件，其余条目原样复制。
 * 用硬链接代替复制大文件：同一卷上不额外占用磁盘，且运行时只读。
 * 唯一例外是 electron.exe——打包时会对其进行版本信息与图标改写，
 * 为避免任何原地改写波及源文件，这个文件走真实复制。
 */
function copyTree(sourceDir, targetDir, relative = '') {
  fs.mkdirSync(targetDir, { recursive: true })

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const relativePath = relative === '' ? entry.name : `${relative}/${entry.name}`
    const from = path.join(sourceDir, entry.name)
    const to = path.join(targetDir, entry.name)

    if (entry.isDirectory()) {
      if (relativePath === 'locales') {
        fs.mkdirSync(to, { recursive: true })
        for (const locale of KEEP_LOCALES) {
          const localeFrom = path.join(from, locale)
          if (fs.existsSync(localeFrom)) fs.copyFileSync(localeFrom, path.join(to, locale))
        }
        continue
      }
      copyTree(from, to, relativePath)
      continue
    }

    if (entry.name.toLowerCase() === 'electron.exe') {
      fs.copyFileSync(from, to)
      continue
    }

    try {
      fs.linkSync(from, to)
    } catch {
      // 跨卷或文件系统不支持硬链接时退回复制
      fs.copyFileSync(from, to)
    }
  }
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`未找到 Electron 运行时：${path.relative(ROOT, SOURCE)}`)
    console.error('请先执行 npm install。')
    process.exit(1)
  }

  const version = readSourceVersion()
  if (version === null) {
    console.error(`无法读取 Electron 版本文件：${path.relative(ROOT, path.join(SOURCE, 'version'))}`)
    process.exit(1)
  }

  if (isUpToDate(version)) {
    console.log(`Electron 运行时已就绪（${version}，语言包 ${KEEP_LOCALES.join(' / ')}），跳过复制。`)
    return
  }

  // 单次递归删除（一次调用），重建目标目录
  fs.rmSync(TARGET, { recursive: true, force: true })
  console.log(`正在准备裁剪版 Electron 运行时（${version}）…`)
  copyTree(SOURCE, TARGET)

  fs.writeFileSync(MARKER, JSON.stringify({ version, locales: KEEP_LOCALES }, null, 2))

  const localeDir = path.join(TARGET, 'locales')
  const kept = fs.existsSync(localeDir) ? fs.readdirSync(localeDir).length : 0
  console.log(`完成：${path.relative(ROOT, TARGET)}（语言包 ${kept} 个）`)
}

main()
