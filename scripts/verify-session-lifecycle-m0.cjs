/**
 * M0-2 技术验证：会话生命周期与进程树清理。
 *
 * 验证目标：
 *   1. 复现 I-1：kill 时 node-pty 的 helper 进程报 AttachConsole failed
 *   2. 对比 useConpty（默认，fork helper 获取进程树）与 useConptyDll 的清理效果
 *
 * 背景（node-pty 1.1.0 windowsPtyAgent.kill）：
 *   - useConpty && !useConptyDll：fork helper 进程 → getConsoleProcessList(shellPid)
 *     → 逐个 kill。若 shell 已退出，AttachConsole 失败，helper 崩溃，
 *     父进程只能等 5 秒超时并把进程列表退化为 [shellPid]，子进程可能残留。
 *   - useConpty && useConptyDll：关闭输入写句柄结束会话，不 fork helper。
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/verify-session-lifecycle-m0.cjs
 *
 * 注意：脚本会在会话中启动一个长时间运行的子进程用于观测，结束后清理残留。
 */

const pty = require('node-pty')
const { execSync } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('本脚本针对 Windows ConPTY 设计，当前平台非 win32，跳过。')
  process.exit(0)
}

const shell = process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'
const CHILD_IMAGE = 'PING.EXE'

const env = {}
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') env[key] = value
}

function hasChildProcess() {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${CHILD_IMAGE}" /NH`, {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.toLowerCase().includes(CHILD_IMAGE.toLowerCase())
  } catch {
    return null
  }
}

function killStrayChildren() {
  try {
    execSync(`taskkill /F /IM ${CHILD_IMAGE} /T`, { stdio: 'ignore', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runScenario(label, options) {
  const session = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env,
    ...options
  })

  await wait(1500)
  session.write('ping -n 120 127.0.0.1 > nul\r\n')
  await wait(2500)

  const during = hasChildProcess()

  session.kill()
  await wait(7000)

  const after = hasChildProcess()

  return { label, during, after }
}

async function main() {
  console.log('=== M0-2 会话生命周期验证 ===')
  console.log(`运行时：Node ${process.versions.node}　Shell：${shell}`)
  console.log('观测子进程：' + CHILD_IMAGE)

  killStrayChildren()
  await wait(1000)

  const results = []

  results.push(
    await runScenario('场景 A：useConpty: true（默认，fork helper 清理进程树）', {
      useConpty: true
    })
  )

  await wait(1000)
  killStrayChildren()
  await wait(1000)

  results.push(
    await runScenario('场景 B：useConpty: true + useConptyDll: true（使用自带 conpty.dll）', {
      useConpty: true,
      useConptyDll: true
    })
  )

  await wait(1000)
  const cleaned = killStrayChildren()

  console.log('\n--- 结果 ---')
  for (const item of results) {
    console.log(`\n${item.label}`)
    console.log(`  会话内子进程已启动：${item.during === true ? '是' : '否'}`)
    console.log(`  会话关闭后子进程残留：${item.after === true ? '是（未清理干净）' : '否'}`)
  }
  console.log(`\n残留进程清理：${cleaned ? '已执行' : '无需执行'}`)
  console.log('\n提示：若上方 stderr 出现 AttachConsole failed，即为 I-1 现象。')

  await wait(300)
  process.exit(0)
}

main().catch((error) => {
  console.error('验证异常：', error)
  process.exit(1)
})
