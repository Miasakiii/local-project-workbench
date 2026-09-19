/**
 * M0-1 技术验证（扩展）：多会话并存、会话隔离、尺寸变化、中断信号。
 *
 * 用法（使用 Electron 的 Node 运行时，以匹配实际运行环境的 ABI）：
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/verify-terminal-m0.cjs
 *
 * 对应设计稿验收场景 6 与 8 中与终端相关的部分。
 */

const pty = require('node-pty')

const isWindows = process.platform === 'win32'
const shell = isWindows ? process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe' : process.env.SHELL || '/bin/bash'

const env = {}
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') env[key] = value
}

function spawn(cols = 80, rows = 24) {
  return pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env,
    ...(isWindows ? { useConpty: true } : {})
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function enter() {
  return isWindows ? '\r\n' : '\n'
}

const results = []

async function main() {
  console.log(`平台：${process.platform}　Shell：${shell}`)
  console.log(
    `运行时：Electron ${process.versions.electron ?? '无'} / Node ${process.versions.node} / ABI ${process.versions.modules}`
  )

  // ---- 1. 多会话并存与会话隔离 ----
  const sessionA = spawn()
  const sessionB = spawn()
  let outA = ''
  let outB = ''

  sessionA.onData((data) => {
    outA += data
  })
  sessionB.onData((data) => {
    outB += data
  })

  sessionA.write(`echo SESSION_A_MARK${enter()}`)
  sessionB.write(`echo SESSION_B_MARK${enter()}`)
  await wait(2500)

  const gotA = outA.includes('SESSION_A_MARK')
  const gotB = outB.includes('SESSION_B_MARK')
  results.push({
    name: '多会话并存',
    pass: gotA && gotB,
    detail: `会话 A 收到自身输出=${gotA}，会话 B 收到自身输出=${gotB}`
  })

  const leaked = outA.includes('SESSION_B_MARK') || outB.includes('SESSION_A_MARK')
  results.push({
    name: '会话输出隔离',
    pass: !leaked,
    detail: leaked ? '检测到跨会话串流' : '两会话输出互不串流'
  })

  // ---- 2. 尺寸变化后会话仍可用 ----
  let resizeError = null
  try {
    sessionA.resize(120, 40)
    await wait(400)
    sessionA.resize(60, 20)
    await wait(400)
  } catch (error) {
    resizeError = error
  }

  sessionA.write(`echo AFTER_RESIZE_MARK${enter()}`)
  await wait(1800)

  results.push({
    name: '尺寸变化后仍可用',
    pass: !resizeError && outA.includes('AFTER_RESIZE_MARK'),
    detail: resizeError ? `resize 抛出异常：${resizeError.message}` : '80x24 → 120x40 → 60x20 后命令仍可执行'
  })

  // ---- 3. 中断信号后会话存活 ----
  const sessionC = spawn()
  let outC = ''
  sessionC.onData((data) => {
    outC += data
  })

  sessionC.write(isWindows ? `ping -n 30 127.0.0.1 > nul${enter()}` : `sleep 30${enter()}`)
  await wait(1800)
  sessionC.write('\x03')
  await wait(1500)
  sessionC.write(`echo AFTER_INTERRUPT_MARK${enter()}`)
  await wait(1800)

  results.push({
    name: '中断信号后会话存活',
    pass: outC.includes('AFTER_INTERRUPT_MARK'),
    detail: outC.includes('AFTER_INTERRUPT_MARK') ? '发送 Ctrl+C 后可继续执行命令' : '会话在中断后未能继续接受输入'
  })

  // ---- 清理 ----
  for (const child of [sessionA, sessionB, sessionC]) {
    try {
      child.kill()
    } catch {
      // 会话可能已退出
    }
  }

  console.log('\n=== M0-1 验证结果 ===')
  let allPass = true
  for (const item of results) {
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
    if (!item.pass) allPass = false
  }
  console.log(allPass ? '\n结论：M0-1 终端核心能力全部通过' : '\n结论：存在未通过项，需排查')

  await wait(200)
  process.exit(allPass ? 0 : 1)
}

main().catch((error) => {
  console.error('验证过程异常：', error)
  process.exit(1)
})
