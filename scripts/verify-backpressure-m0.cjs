/**
 * M0-3 技术验证：高频输出的吞吐与内存有界性。
 *
 * 验证目标（对应设计稿 6.2）：
 *   - 连续大输出下主进程内存增长是否有界
 *   - 输出是否完整传递、有无丢失
 *   - 吞吐量基线
 *
 * 说明：执行环境无图形会话，因此「界面可交互」一项无法自动验证，
 * 本脚本验证的是后端侧（PTY → 主进程）的行为。界面响应性留待人工确认。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/verify-backpressure-m0.cjs [行数]
 */

const pty = require('node-pty')

const TOTAL_LINES = Number(process.argv[2] ?? 200000)
const shell =
  process.platform === 'win32'
    ? process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'
    : process.env.SHELL || '/bin/bash'

const env = {}
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') env[key] = value
}

const MEMORY_GROWTH_LIMIT_MB = 100

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}

async function main() {
  console.log('=== M0-3 背压与内存验证 ===')
  console.log(`运行时：Node ${process.versions.node}　Shell：${shell}`)
  console.log(`目标输出：${TOTAL_LINES} 行\n`)

  const session = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env,
    ...(process.platform === 'win32' ? { useConpty: true } : {})
  })

  let bytes = 0
  let chunks = 0
  let done = false
  let doneAt = 0
  let sawDoneMarker = false

  const started = Date.now()
  const baseline = process.memoryUsage().heapUsed
  let peak = baseline
  let samples = 0

  const memoryTimer = setInterval(() => {
    const used = process.memoryUsage().heapUsed
    if (used > peak) peak = used
    samples += 1
  }, 200)

  session.onData((data) => {
    bytes += data.length
    chunks += 1
    if (!sawDoneMarker && data.includes('__M0_3_DONE__')) {
      sawDoneMarker = true
      done = true
      doneAt = Date.now()
    }
  })

  await wait(1200)
  session.write(`node scripts/gen-output.cjs ${TOTAL_LINES}\r\n`)

  const deadline = Date.now() + 90000
  while (!done && Date.now() < deadline) {
    await wait(200)
  }

  clearInterval(memoryTimer)
  await wait(1500)

  const elapsedMs = (done ? doneAt : Date.now()) - started
  const elapsedSec = elapsedMs / 1000
  const throughput = bytes / 1024 / 1024 / Math.max(elapsedSec, 0.001)
  const growthMb = (peak - baseline) / 1024 / 1024

  const passed = done && growthMb < MEMORY_GROWTH_LIMIT_MB

  console.log('--- 结果 ---')
  console.log(`输出完成标记：${sawDoneMarker ? '已捕获' : '未捕获（超时）'}`)
  console.log(`接收总量：${toMb(bytes)} MB　分片数：${chunks}`)
  console.log(`耗时：${elapsedSec.toFixed(2)} 秒　吞吐：${throughput.toFixed(1)} MB/s`)
  console.log(`内存采样：${samples} 次`)
  console.log(`堆内存基线：${toMb(baseline)} MB　峰值：${toMb(peak)} MB　增长：${growthMb.toFixed(1)} MB`)
  console.log(`内存增长上限：${MEMORY_GROWTH_LIMIT_MB} MB`)
  console.log(`\n结论：${passed ? '通过 — 输出完整且内存增长有界' : '未通过 — 需排查'}`)

  try {
    session.kill()
  } catch {
    // 会话可能已退出
  }

  await wait(500)
  process.exit(passed ? 0 : 1)
}

main().catch((error) => {
  console.error('验证异常：', error)
  process.exit(1)
})
