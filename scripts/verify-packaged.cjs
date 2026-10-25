/**
 * 分发产物验证：在 electron-builder 的真实打包产物上做端到端检查。
 *
 * 与 `smoke:m1` 的分工：
 *   - `smoke:m1` 验证「源码构建出的 out/ 产物」，靠向主进程注入测试脚本驱动界面；
 *   - 本脚本验证「打包后的安装目录」，改用 CDP（远程调试协议）从外部驱动界面，
 *     不依赖应用内部的任何测试钩子，因此能覆盖那些只有打包才会暴露的问题：
 *     asar 归档、语言包裁剪、原生模块解包、生产依赖裁剪是否破坏了功能。
 *
 * 用法：
 *   node scripts/verify-packaged.cjs           # 需先执行 npm run pack:dir
 *   node scripts/verify-packaged.cjs --keep    # 失败时保留临时目录便于排查
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..')

/** 允许用 --dir=<路径> 指定其它产物目录（默认 release/win-unpacked）。 */
const dirArg = process.argv.find((item) => item.startsWith('--dir='))
const UNPACKED = dirArg === undefined ? path.join(ROOT, 'release', 'win-unpacked') : path.resolve(dirArg.slice(6))

const DEBUG_PORT = 9333
const KEEP = process.argv.includes('--keep')

/**
 * B1 软渲染回退实验开关：VERIFY_PACKAGED_GL_FLAGS 透传追加的 Chromium 参数，
 * 例如 --use-gl=swiftshader。默认不传，行为与从前完全一致；用于在无 GPU 环境
 * 显式指定软件渲染后端复测（R11／GPU DLL 裁剪判定的证据之一）。
 */
const extraGlFlags = (process.env.VERIFY_PACKAGED_GL_FLAGS ?? '')
  .split(' ')
  .map((item) => item.trim())
  .filter((item) => item.length > 0)

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '[通过]' : '[失败]'} ${name} — ${detail}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 打包目录里的主程序：体积最大的那个 .exe（其余是内部工具）。 */
function findExecutable() {
  const candidates = fs
    .readdirSync(UNPACKED)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .map((name) => ({ name, size: fs.statSync(path.join(UNPACKED, name)).size }))
    .sort((left, right) => right.size - left.size)
  if (candidates.length === 0) throw new Error('打包目录中没有找到可执行文件')
  return path.join(UNPACKED, candidates[0].name)
}

/**
 * 预置登记数据，让界面有可操作的项目（主进程惰性读取该文件）。
 *
 * 项目以**已信任**状态预置，且必须同时写入 `rootIdentity`（目录物理身份
 * `dev + ino`）：信任授予自 2026-10-22 起是独立特权通道（`project:trust`，
 * 授予时主进程弹原生确认框），CDP 驱动下无人能点掉原生框，无法在验证流程内
 * 完成授信；而主进程对写操作与终端一律按登记表的 `trusted` 复核（纵深防御），
 * 旧记录缺少身份绑定时还会被降级——因此预置「已信任」的同时必须绑定当前目录
 * 的物理身份，否则终端创建仍会被拒。这样本验证覆盖的是「登记表信任 +
 * 身份绑定均通过后，主进程放行终端创建」这条生产路径。
 */
function seedUserData(userDataDir, projectDir) {
  fs.mkdirSync(userDataDir, { recursive: true })
  const file = path.join(userDataDir, 'projects.json')
  // 与主进程 captureRootIdentity 同一口径：BigInt 读取避免 64 位文件索引丢精度
  const stats = fs.statSync(projectDir, { bigint: true })
  const rootIdentity = stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      data: {
        projects: [
          {
            id: 'verify-project',
            displayName: '打包验证项目',
            originalPath: projectDir,
            normalizedIdentity: fs.realpathSync.native(projectDir),
            descriptionOverride: null,
            readmePath: null,
            pinned: false,
            lastOpenedAt: new Date().toISOString(),
            trusted: true,
            rootIdentity,
            isGitRepository: false
          }
        ]
      }
    })
  )
}

/** 等待渲染进程的调试目标出现。 */
async function waitForPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = '尚未就绪'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page !== undefined) return page
      lastError = `目标数 ${targets.length}，暂无 page 类型`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(300)
  }
  throw new Error(`等待渲染进程调试目标超时：${lastError}`)
}

function createCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  const pending = new Map()
  let nextId = 1

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('调试通道连接失败')))
  })

  function send(method, params) {
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }

  return { ready, send, close: () => socket.close() }
}

/** 在渲染进程中求值；异常直接抛出，避免把「求值失败」误判为「断言通过」。 */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails !== undefined) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(`渲染进程求值异常：${description}`)
  }
  return result.result.value
}

async function main() {
  if (!fs.existsSync(UNPACKED)) {
    console.error(`未找到打包产物：${path.relative(ROOT, UNPACKED)}`)
    console.error('请先执行 npm run pack:dir。')
    process.exit(1)
  }

  const executable = findExecutable()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-pack-'))
  const userDataDir = path.join(tempRoot, 'userData')
  const projectDir = path.join(tempRoot, 'project')

  fs.mkdirSync(projectDir, { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# 打包验证项目\n\n用于验证打包产物可用。\n')
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), '第一行\n第二行\n')
  fs.mkdirSync(path.join(projectDir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(projectDir, 'docs', 'guide.md'), '# 指南\n')
  seedUserData(userDataDir, projectDir)

  console.log('=== 分发产物验证（真实打包目录 + CDP 驱动）===\n')
  console.log(`可执行文件：${path.relative(ROOT, executable)}`)
  console.log(`临时用户数据：${userDataDir}`)
  if (extraGlFlags.length > 0) console.log(`追加 GL 参数：${extraGlFlags.join(' ')}`)
  console.log('')

  // 与 smoke-m1 / measure-framework 同一约定：部分环境会注入 ELECTRON_RUN_AS_NODE，
  // 该变量会让 Electron 以纯 Node 启动（拒绝 --remote-debugging-port 等 Chromium
  // 参数，表现为 "bad option"），派生子进程必须显式删除。
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE

  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      // 与本机其它 Electron 验证脚本一致：无显示会话时 GPU 沙箱会初始化失败
      '--disable-gpu-sandbox',
      '--no-sandbox',
      ...extraGlFlags
    ],
    { cwd: UNPACKED, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv }
  )

  let childOutput = ''
  child.stdout.on('data', (chunk) => {
    childOutput += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    childOutput += String(chunk)
  })

  let cdp = null
  try {
    const target = await waitForPageTarget(45000)
    cdp = createCdp(target.webSocketDebuggerUrl)
    await cdp.ready
    await cdp.send('Runtime.enable')

    // 等待界面渲染完成
    let ready = false
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      ready = await evaluate(cdp, `document.querySelector('.app') !== null`)
      if (!ready) await sleep(250)
    }
    check('打包产物能启动并渲染主界面', ready, ready ? '.app 已挂载' : '.app 未出现')

    const bridge = await evaluate(
      cdp,
      `(() => {
        const w = window
        return {
          hasWorkbench: typeof w.workbench === 'object' && w.workbench !== null,
          projectList: typeof w.workbench?.project?.list === 'function',
          terminalCreate: typeof w.workbench?.terminal?.create === 'function',
          requireType: typeof w.require,
          processType: typeof w.process,
          ipcRendererType: typeof w.ipcRenderer
        }
      })()`
    )
    check(
      '预加载白名单桥在打包后仍可用',
      bridge.hasWorkbench && bridge.projectList && bridge.terminalCreate,
      `workbench=${bridge.hasWorkbench} project.list=${bridge.projectList} terminal.create=${bridge.terminalCreate}`
    )
    check(
      '打包后未暴露 Node 能力',
      bridge.requireType === 'undefined' &&
        bridge.processType === 'undefined' &&
        bridge.ipcRendererType === 'undefined',
      `require=${bridge.requireType} process=${bridge.processType} ipcRenderer=${bridge.ipcRendererType}`
    )

    // GPU 对照验收：记录 Chromium 实际选择的后端（硬件 ANGLE 或 SwiftShader），
    // 同一断言在默认与 VERIFY_PACKAGED_GL_FLAGS=--use-angle=swiftshader 下都成立。
    const graphics = await evaluate(
      cdp,
      `(() => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
        if (gl === null) return { webgl: false, renderer: null, vendor: null, version: null }
        const info = gl.getExtension('WEBGL_debug_renderer_info')
        return {
          webgl: true,
          renderer: info === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
          vendor: info === null ? gl.getParameter(gl.VENDOR) : gl.getParameter(info.UNMASKED_VENDOR_WEBGL),
          version: gl.getParameter(gl.VERSION)
        }
      })()`
    )
    check(
      '渲染进程可创建 WebGL 上下文',
      graphics.webgl === true,
      `renderer=${String(graphics.renderer)} vendor=${String(graphics.vendor)} version=${String(graphics.version)}`
    )

    const fontStack = await evaluate(
      cdp,
      `getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()`
    )
    check('样式表已从 asar 正常加载', fontStack.includes('-apple-system'), `--font-ui=${fontStack.slice(0, 48)}…`)

    const card = await evaluate(
      cdp,
      `(() => {
        const node = document.querySelector('.project-card')
        return node === null ? null : { text: node.textContent ?? '' }
      })()`
    )
    check(
      '项目库渲染出预置项目',
      card?.text.includes('打包验证项目') === true,
      card === null ? '未找到项目卡片' : `卡片文本=${card.text.slice(0, 40)}`
    )

    // 打开项目：验证文件树（读盘能力）在打包后可用
    const opened = await evaluate(
      cdp,
      `(() => {
        const card = [...document.querySelectorAll('.project-card')].find((item) => item.textContent.includes('打包验证项目'))
        if (card === undefined) return false
        const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '打开')
        if (button === undefined) return false
        button.click()
        return true
      })()`
    )
    let treeRows = 0
    for (let attempt = 0; attempt < 40 && treeRows === 0; attempt += 1) {
      // 项目页默认落在「概览」，文件树在「文件」分段下
      await evaluate(
        cdp,
        `(() => {
          const button = [...document.querySelectorAll('.segmented button')].find((item) => item.textContent.includes('文件'))
          if (button !== undefined) button.click()
          return true
        })()`
      )
      treeRows = await evaluate(cdp, `document.querySelectorAll('.tree-row').length`)
      if (treeRows === 0) await sleep(250)
    }
    check('打包后可打开项目并列出文件', opened && treeRows > 0, `点击打开=${opened} 文件树行数=${treeRows}`)

    // 终端：验证被裁剪过的 node-pty 在打包产物中确实可用。
    // 信任走预置登记数据（已信任 + 绑定的目录物理身份，见 seedUserData）——
    // 授予信任是独立特权通道，会弹主进程原生确认框，CDP 驱动下无法代为确认；
    // 主进程仍按登记表的 trusted 与身份绑定复核（纵深防御），本项覆盖的是
    // 「信任与身份均通过后放行终端创建」的生产路径。
    const terminal = await evaluate(
      cdp,
      `(async () => {
        const api = window.workbench
        const created = await api.terminal.create({ projectId: 'verify-project', relativePath: '', cols: 80, rows: 24 })
        const data = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 8000)
          const off = api.terminal.onData((payload) => {
            if (payload.sessionId !== created.sessionId || !payload.data) return
            clearTimeout(timer)
            off()
            resolve(payload.data)
          })
        })
        await api.terminal.dispose(created.sessionId)
        return { created, data }
      })()`
    )
    check(
      '裁剪后的 node-pty 在打包产物中可用',
      terminal.data !== null && terminal.data.length > 0,
      `shell=${terminal.created.shell} 收到 ${terminal.data === null ? 0 : terminal.data.length} 字节`
    )

    // 界面终端挂载：确认 xterm 真正渲染，且 WebGL 可用时必须使用画布后端。
    // 软件渲染（--use-angle=swiftshader）仍应成功挂载；无 WebGL 时才允许 DOM 回退。
    const terminalUi = await evaluate(
      cdp,
      `(async () => {
        const toggle = document.querySelector('.terminal-toggle')
        if (toggle === null) return { mounted: false, reason: 'no-toggle' }
        toggle.click()
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          const host = document.querySelector('.terminal-host')
          const screen = host === null ? null : host.querySelector('.xterm-screen')
          if (screen !== null) {
            await new Promise((resolve) => setTimeout(resolve, 800))
            const canvas = host.querySelector('canvas')
            return {
              mounted: true,
              canvas: canvas !== null,
              canvasWidth: canvas?.width ?? 0,
              canvasHeight: canvas?.height ?? 0,
              state: document.querySelector('.terminal-status-state')?.textContent ?? null
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        return { mounted: false, reason: 'timeout' }
      })()`
    )
    check(
      '终端在打包产物中挂载并运行',
      terminalUi.mounted === true && String(terminalUi.state).includes('运行中'),
      terminalUi.mounted === true
        ? `状态=${String(terminalUi.state)} 画布=${terminalUi.canvasWidth}x${terminalUi.canvasHeight}`
        : `未挂载：${String(terminalUi.reason)}`
    )
    check(
      '终端渲染后端与 WebGL 能力一致',
      terminalUi.mounted === true && (graphics.webgl !== true || terminalUi.canvas === true),
      `WebGL=${graphics.webgl} xterm=${terminalUi.canvas === true ? 'canvas' : 'dom'} renderer=${String(graphics.renderer)}`
    )

    const chinese = await evaluate(
      cdp,
      `document.body.textContent.includes('项目') || document.body.textContent.includes('还没有登记')`
    )
    check('界面中文文案正常（语言包裁剪未破坏渲染）', chinese === true, chinese ? '检测到中文文案' : '未检测到中文文案')

    check(
      '运行期间无致命错误输出',
      !/Uncaught|FATAL|GPU process isn't usable/i.test(childOutput),
      childOutput.trim() === '' ? '无输出' : childOutput.trim().split('\n')[0].slice(0, 80)
    )
  } catch (error) {
    check('验证流程执行完成', false, error instanceof Error ? error.message : String(error))
  } finally {
    if (cdp !== null) cdp.close()
    child.kill()
    await sleep(1200)
    if (child.exitCode === null) child.kill('SIGKILL')
    if (!KEEP) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
      } catch {
        // 忽略：临时目录清理失败不影响结论
      }
    } else {
      console.log(`\n已保留临时目录：${tempRoot}`)
    }
  }

  const passed = results.filter((item) => item.pass).length
  console.log(`\n合计：${passed}/${results.length} 项通过`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本异常：', error)
  process.exit(1)
})
