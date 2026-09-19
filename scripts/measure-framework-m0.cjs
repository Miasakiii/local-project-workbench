/**
 * M0-7 技术验证：框架实测（冷启动、内存占用、分发体积）。
 *
 * 用法：
 *   node scripts/measure-framework-m0.cjs            # 默认测量 5 次
 *   node scripts/measure-framework-m0.cjs 3          # 指定次数
 *   node scripts/measure-framework-m0.cjs --sizes    # 只测体积
 *
 * 测量口径：
 *   - 冷启动：每次启动一个全新的 Electron 进程，测量
 *     `app.whenReady` / `ready-to-show` / `did-finish-load` 三个时点，
 *     相对该进程的启动时刻（父进程 spawn 前打点）。
 *   - 内存：界面稳定 1.5 秒后读取 `app.getAppMetrics()` 的工作集，
 *     按进程类型汇总。
 *   - 体积：测量 Electron 运行时、应用产物、必须随包分发的原生依赖的
 *     未压缩体积，并对运行时做一次真实 gzip 压缩以给出压缩比参考。
 *     **安装包体积为投影值**，真实 NSIS/LZMA 打包在 M3-5 执行。
 *
 * 本脚本既作为父进程（普通 Node）也作为子进程（Electron 主进程）运行，
 * 通过 `process.versions.electron` 区分。
 */

const path = require('node:path')
const fs = require('node:fs')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const RENDERER_INDEX = path.join(ROOT, 'out', 'renderer', 'index.html')
const PRELOAD_INDEX = path.join(ROOT, 'out', 'preload', 'index.js')

/* ==================== 子进程：Electron 主进程内测量 ==================== */

function runChild() {
  const electronModule = require('electron')

  // 若环境强制以 ELECTRON_RUN_AS_NODE 启动，`require('electron')` 返回的是
  // 二进制路径字符串而非 API，此时无法创建窗口，必须明确失败而不是静默降级。
  if (typeof electronModule === 'string') {
    process.stderr.write(
      '当前进程以 ELECTRON_RUN_AS_NODE 模式启动，无法创建窗口。\n' +
        '请通过父进程模式运行：node scripts/measure-framework-m0.cjs\n'
    )
    process.exit(2)
  }

  const { app, BrowserWindow } = electronModule
  const startedAt = Number(process.env.WB_MEASURE_T0 || Date.now())
  const marks = {}
  const mark = (name) => {
    marks[name] = Date.now() - startedAt
  }

  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')

  let finished = false
  const finish = (extra) => {
    if (finished) return
    finished = true
    const metrics = app.getAppMetrics().map((entry) => ({
      type: entry.type,
      pid: entry.pid,
      workingSetMB: Number((entry.memory.workingSetSize / 1024).toFixed(1)),
      peakWorkingSetMB: Number((entry.memory.peakWorkingSetSize / 1024).toFixed(1))
    }))
    const totalWorkingSetMB = Number(metrics.reduce((sum, entry) => sum + entry.workingSetMB, 0).toFixed(1))
    process.stdout.write(
      '\nMEASURE_JSON ' +
        JSON.stringify({
          marks,
          metrics,
          totalWorkingSetMB,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
          ...extra
        }) +
        '\n'
    )
    app.exit(0)
  }

  const guard = setTimeout(() => finish({ timedOut: true }), 30000)

  app
    .whenReady()
    .then(() => {
      mark('whenReady')
      const window = new BrowserWindow({
        width: 1280,
        height: 840,
        show: false,
        backgroundColor: '#ffffff',
        webPreferences: {
          preload: PRELOAD_INDEX,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true
        }
      })

      window.once('ready-to-show', () => mark('readyToShow'))
      window.webContents.on('render-process-gone', (_event, details) => {
        clearTimeout(guard)
        finish({ rendererGone: details.reason })
      })
      window.webContents.once('did-finish-load', () => {
        mark('didFinishLoad')
        setTimeout(() => {
          clearTimeout(guard)
          finish({})
        }, 1500)
      })
      window.loadFile(RENDERER_INDEX)
    })
    .catch((error) => {
      clearTimeout(guard)
      finish({ error: String(error) })
    })
}

/* ==================== 父进程：编排、聚合与体积测量 ==================== */

function directorySize(target) {
  let total = 0
  let files = 0
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
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size
          files += 1
        } catch {
          // 忽略不可读文件
        }
      }
    }
  }
  return { bytes: total, files }
}

/** 对目录做一次真实 gzip 压缩（流式，避免大文件占用内存），返回压缩后字节数。 */
async function gzipSize(target) {
  let total = 0
  const stack = [target]
  const files = []
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
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) files.push(full)
    }
  }

  for (const file of files) {
    await new Promise((resolve) => {
      const gzip = zlib.createGzip({ level: 6 })
      const input = fs.createReadStream(file)
      let bytes = 0
      gzip.on('data', (chunk) => {
        bytes += chunk.length
      })
      gzip.on('end', () => {
        total += bytes
        resolve()
      })
      gzip.on('error', resolve)
      input.on('error', resolve)
      input.pipe(gzip)
    })
  }
  return total
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(1))
}

async function runSizes() {
  console.log('=== M0-7 体积测量 ===\n')

  const electron = directorySize(path.join(ROOT, 'node_modules', 'electron', 'dist'))
  const appCode = directorySize(path.join(ROOT, 'out'))

  // 必须随包分发的原生依赖：主进程 externalize 的 node-pty
  // 只需 win32-x64 预编译产物与 ConPTY 资源，其余平台产物不进入安装包
  const ptyRoot = path.join(ROOT, 'node_modules', 'node-pty')
  const ptyWin = directorySize(path.join(ptyRoot, 'prebuilds', 'win32-x64'))
  const ptyConpty = directorySize(path.join(ptyRoot, 'prebuilds', 'conpty'))
  const ptyLib = directorySize(path.join(ptyRoot, 'lib'))
  const ptyTotal = directorySize(ptyRoot)

  console.log('未压缩体积构成：')
  console.log(`  Electron 运行时            ${String(mb(electron.bytes)).padStart(7)} MB  (${electron.files} 个文件)`)
  console.log(`  应用产物 out/              ${String(mb(appCode.bytes)).padStart(7)} MB  (${appCode.files} 个文件)`)
  console.log(`  node-pty 全部              ${String(mb(ptyTotal.bytes)).padStart(7)} MB`)
  console.log(
    `    ├─ 仅 win32-x64 + conpty ${String(mb(ptyWin.bytes + ptyConpty.bytes + ptyLib.bytes)).padStart(7)} MB  (实际需分发)`
  )
  console.log(
    `    └─ 其他平台预编译产物    ${String(mb(ptyTotal.bytes - ptyWin.bytes - ptyConpty.bytes - ptyLib.bytes)).padStart(7)} MB  (可不分发)`
  )

  const unpacked = electron.bytes + appCode.bytes + ptyWin.bytes + ptyConpty.bytes + ptyLib.bytes
  console.log(`\n  合计（未压缩，实际需分发）  ${String(mb(unpacked)).padStart(7)} MB`)

  process.stdout.write('\n正在测量运行时压缩比（真实 gzip，可能需要 1-2 分钟）…')
  const gzipped = await gzipSize(path.join(ROOT, 'node_modules', 'electron', 'dist'))
  const ratio = gzipped / electron.bytes
  console.log(' 完成')
  console.log(`\nElectron 运行时 gzip 压缩后：${mb(gzipped)} MB（压缩比 ${(ratio * 100).toFixed(1)}%）`)

  // 投影：NSIS + LZMA 通常优于 deflate，此处以 gzip 结果作为安装包体积的上界估计
  const projected = gzipped + appCode.bytes * 0.4 + (ptyWin.bytes + ptyConpty.bytes) * 0.5
  console.log(`安装包体积投影（上界估计）：约 ${mb(projected)} MB`)
  console.log('说明：真实安装包需 M3-5 用 NSIS/LZMA 打包实测；本值为压缩比投影，不作为结论。')

  return {
    electronMB: mb(electron.bytes),
    appCodeMB: mb(appCode.bytes),
    ptyShippedMB: mb(ptyWin.bytes + ptyConpty.bytes + ptyLib.bytes),
    unpackedMB: mb(unpacked),
    gzipRatioPercent: Number((ratio * 100).toFixed(1)),
    projectedInstallerMB: mb(projected)
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function runOnce() {
  const t0 = Date.now()

  // 显式清除 ELECTRON_RUN_AS_NODE：部分执行环境会注入该变量，
  // 使 Electron 以纯 Node 模式启动（require('electron') 只返回二进制路径），
  // 从而无法创建窗口。
  const childEnv = { ...process.env, WB_MEASURE_T0: String(t0) }
  delete childEnv.ELECTRON_RUN_AS_NODE

  const result = spawnSync(ELECTRON_BIN, [__filename], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true
  })
  const output = `${result.stdout || ''}`
  const match = /MEASURE_JSON (\{.*\})/.exec(output)
  if (match === null) {
    const detail = `${output}\n${result.stderr || ''}`.trim()
    return { failed: true, detail: detail.slice(-800) }
  }
  return JSON.parse(match[1])
}

async function main() {
  const args = process.argv.slice(2)
  const sizesOnly = args.includes('--sizes')

  if (!sizesOnly) {
    const runs = Number(args.find((item) => /^\d+$/.test(item)) || 5)
    console.log(`=== M0-7 冷启动与内存测量（${runs} 次）===`)
    console.log(`Electron 二进制：${ELECTRON_BIN}`)
    console.log(`被测界面：${RENDERER_INDEX}\n`)

    const results = []
    for (let index = 0; index < runs; index += 1) {
      const result = runOnce()
      if (result.failed) {
        console.log(`第 ${index + 1} 次：失败 — ${result.detail}`)
        continue
      }
      results.push(result)
      console.log(
        `第 ${index + 1} 次：whenReady=${String(result.marks.whenReady)}ms  ` +
          `readyToShow=${String(result.marks.readyToShow ?? '—')}ms  ` +
          `didFinishLoad=${String(result.marks.didFinishLoad ?? '—')}ms  ` +
          `工作集合计=${String(result.totalWorkingSetMB)}MB` +
          (result.rendererGone ? `  [渲染进程退出：${result.rendererGone}]` : '') +
          (result.timedOut ? '  [超时]' : '')
      )
    }

    if (results.length > 0) {
      const whenReady = results.map((item) => item.marks.whenReady).filter((value) => typeof value === 'number')
      const readyToShow = results.map((item) => item.marks.readyToShow).filter((value) => typeof value === 'number')
      const didFinishLoad = results.map((item) => item.marks.didFinishLoad).filter((value) => typeof value === 'number')
      const memory = results.map((item) => item.totalWorkingSetMB).filter((value) => typeof value === 'number')

      console.log('\n--- 汇总（中位数 / 最小值 / 最大值）---')
      const summary = (label, values) => {
        if (values.length === 0) {
          console.log(`  ${label}：无有效样本`)
          return null
        }
        const line = `  ${label}：${median(values)} / ${Math.min(...values)} / ${Math.max(...values)}`
        console.log(line)
        return median(values)
      }
      summary('whenReady (ms)', whenReady)
      summary('ready-to-show (ms)', readyToShow)
      summary('did-finish-load (ms)', didFinishLoad)
      const medianMemory = summary('工作集合计 (MB)', memory)

      const last = results[results.length - 1]
      if (last.metrics) {
        console.log('\n  进程明细（末次样本）：')
        for (const entry of last.metrics) {
          console.log(
            `    ${entry.type.padEnd(10)} pid=${String(entry.pid).padEnd(7)} 工作集=${entry.workingSetMB}MB 峰值=${entry.peakWorkingSetMB}MB`
          )
        }
      }
      console.log(
        `\n  运行时版本：Electron ${String(last.electron)} / Chromium ${String(last.chrome)} / Node ${String(last.node)}`
      )
      if (medianMemory !== null) {
        console.log(`  说明：工作集为各进程之和，含共享页重复计入，仅用于纵向对比。`)
      }
    }
  }

  if (args.includes('--sizes') || args.includes('--with-sizes')) {
    console.log('')
    const sizes = await runSizes()
    console.log('\n=== 机器可读汇总 ===')
    console.log(JSON.stringify(sizes))
  }
}

if (process.versions.electron) {
  runChild()
} else {
  main().catch((error) => {
    console.error('测量异常：', error)
    process.exit(1)
  })
}
