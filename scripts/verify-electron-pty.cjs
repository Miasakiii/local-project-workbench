/**
 * M0-1 技术验证：检查 node-pty 原生模块是否与当前 Electron ABI 匹配。
 *
 * 用法：npx electron scripts/verify-electron-pty.cjs
 *
 * node-pty 是原生模块，需与 Electron 的 Node ABI 一致。
 * 本脚本在 Electron 主进程中实际加载并建立一个会话，用于确认是否需要
 * 针对 Electron 重新构建（electron-rebuild）。
 */

const { app } = require('electron')

app.disableHardwareAcceleration()

const TIMEOUT_MS = 15000

setTimeout(() => {
  console.error('[失败] 15 秒内未完成验证，进程可能已挂起')
  app.exit(1)
}, TIMEOUT_MS)

app.whenReady().then(() => {
  console.log('Electron:', process.versions.electron)
  console.log('Node:', process.versions.node)
  console.log('原生模块 ABI:', process.versions.modules)

  let pty
  try {
    pty = require('node-pty')
  } catch (error) {
    console.error('[失败] node-pty 无法在 Electron 中加载')
    console.error(error && error.message ? error.message : String(error))
    console.error('提示：需要针对 Electron ABI 重新构建原生模块。')
    app.exit(1)
    return
  }

  console.log('[通过] node-pty 已在 Electron 中加载')

  const isWindows = process.platform === 'win32'
  const shell = isWindows
    ? process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'
    : process.env.SHELL || '/bin/bash'

  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }

  let child
  try {
    child = pty.spawn(shell, isWindows ? ['/c', 'echo ELECTRON_PTY_OK'] : ['-c', 'echo ELECTRON_PTY_OK'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env,
      ...(isWindows ? { useConpty: true } : {})
    })
  } catch (error) {
    console.error('[失败] PTY 会话创建失败')
    console.error(error && error.message ? error.message : String(error))
    app.exit(1)
    return
  }

  let output = ''
  child.onData((data) => {
    output += data
  })

  child.onExit(({ exitCode }) => {
    console.log('会话退出码:', exitCode)
    if (output.includes('ELECTRON_PTY_OK')) {
      console.log('[通过] Electron 环境下伪终端会话工作正常')
      app.exit(0)
    } else {
      console.error('[失败] 未捕获预期输出')
      app.exit(1)
    }
  })
})
