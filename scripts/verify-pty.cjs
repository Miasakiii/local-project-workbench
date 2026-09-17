/**
 * M0-1 技术验证：自检 node-pty 与 Windows ConPTY。
 *
 * 用法：node scripts/verify-pty.cjs
 *
 * 说明：本脚本在 Node 环境下验证 node-pty 可用性与伪终端交互，
 * 用于排除「终端能否建立」这一基础边界问题。
 * 注意：在 Electron 中运行还需针对 Electron ABI 重新构建原生模块。
 */

const pty = require('node-pty')

const isWindows = process.platform === 'win32'
const shell = isWindows
  ? process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'
  : process.env.SHELL || '/bin/bash'

const command = isWindows ? 'echo PTY_OK & echo CWD=%CD%' : 'echo PTY_OK && echo CWD=$(pwd)'

const env = {}
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string') env[key] = value
}

console.log(`平台：${process.platform}`)
console.log(`Shell：${shell}`)
console.log('--- 终端输出开始 ---')

const child = pty.spawn(shell, isWindows ? ['/c', command] : ['-c', command], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env,
  ...(isWindows ? { useConpty: true } : {})
})

let output = ''
let settled = false

const timer = setTimeout(() => {
  if (settled) return
  settled = true
  console.error('\n--- 验证失败：10 秒内未收到退出事件 ---')
  try {
    child.kill()
  } catch {
    // 忽略
  }
  process.exit(1)
}, 10000)

child.onData((data) => {
  output += data
  process.stdout.write(data)
})

child.onExit(({ exitCode, signal }) => {
  if (settled) return
  settled = true
  clearTimeout(timer)

  console.log('\n--- 终端输出结束 ---')
  console.log(`退出码：${exitCode}　信号：${signal ?? '无'}`)

  if (output.includes('PTY_OK')) {
    console.log('结果：验证通过 — node-pty 已成功建立伪终端会话')
    process.exit(0)
  }

  console.error('结果：验证失败 — 未在输出中找到预期标记 PTY_OK')
  process.exit(1)
})
