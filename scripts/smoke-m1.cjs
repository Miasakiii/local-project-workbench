/**
 * M1 端到端冒烟验证：在真实 Electron 运行时下加载构建产物，
 * 通过渲染进程实际调用 IPC，确认界面契约与安全基线成立。
 *
 * 覆盖：
 *   1. 主进程启动无异常，窗口加载构建后的渲染层
 *   2. 预加载层白名单成立：存在 workbench API，且不存在 require／process／ipcRenderer
 *   3. 项目列表、文件列表、Markdown 预览、Git 快照、终端创建经 IPC 端到端可用
 *   4. 页面导航被阻止（外链不改变当前地址）
 *   5. 界面交互：文件操作、重新定位、退出前会话提示
 *   6. 启动位置（C09／验收场景 10）：分三个阶段，各自是**一次真实进程启动**——
 *      main（开关关闭 → 停留项目库，并在结束时开启开关、打开一个项目）、
 *      restore（重启 → 直接进入上次项目；移除登记后重载 → 说明原因；随后关闭开关）、
 *      restore-off（重启 → 回到项目库）。跨阶段的只有应用数据目录里的 settings.json。
 *
 * 用法：
 *   node scripts/smoke-m1.cjs          # 父进程模式（推荐，会清理 ELECTRON_RUN_AS_NODE 并按阶段派生）
 *   electron scripts/smoke-m1.cjs      # 直接运行子进程模式（WORKBENCH_SMOKE_PHASE 选择阶段）
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

/**
 * 递归删除目录。
 *
 * Windows 上 Git 的对象文件带只读属性，直接 rmSync 会以 EPERM 失败，
 * 因此先清除只读位再删除，并允许重试。
 */
function removeTree(target) {
  if (!fs.existsSync(target)) return
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
        fs.chmodSync(full, 0o666)
      } catch {
        // 忽略：可能已被删除
      }
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return
    } catch {
      // 稍后重试：文件可能刚被释放
    }
  }
}

/**
 * 断言构建产物不早于源码。
 *
 * 本脚本验证的是 `out/` 下的构建产物，而构建并不在验证脚本内部发生。
 * 若产物陈旧，这里会静默地验证旧代码，让「验证通过」失去意义——
 * 因此宁可明确失败并提示重新构建，也不接受测到的不是当前源码。
 */
function assertArtifactsFresh() {
  const artifacts = [
    path.join(ROOT, 'out', 'main', 'index.js'),
    path.join(ROOT, 'out', 'preload', 'index.js'),
    path.join(ROOT, 'out', 'renderer', 'index.html')
  ]

  for (const artifact of artifacts) {
    if (!fs.existsSync(artifact)) {
      process.stderr.write(`构建产物不存在：${path.relative(ROOT, artifact)}\n请先执行 npm run build。\n`)
      process.exit(2)
    }
  }

  const oldestArtifact = Math.min(...artifacts.map((artifact) => fs.statSync(artifact).mtimeMs))

  let newestSource = 0
  const stack = [path.join(ROOT, 'src')]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const stat = fs.statSync(full)
      if (stat.mtimeMs > newestSource) newestSource = stat.mtimeMs
    }
  }

  if (newestSource > oldestArtifact) {
    process.stderr.write(
      '构建产物早于源码，冒烟验证会测到旧代码，已中止。\n' +
        `  最早产物：${new Date(oldestArtifact).toISOString()}\n` +
        `  最新源码：${new Date(newestSource).toISOString()}\n` +
        '请先执行 npm run build（或改用 npm run verify:all）。\n'
    )
    process.exit(2)
  }
}

/* ==================== 子进程：真实 Electron 内执行 ==================== */

function runChild() {
  const electronModule = require('electron')
  if (typeof electronModule === 'string') {
    process.stderr.write('当前进程以 ELECTRON_RUN_AS_NODE 模式启动，无法创建窗口。\n')
    process.exit(2)
  }

  const { app, BrowserWindow } = electronModule

  // 无显示会话且受限的执行环境下，Chromium 的 GPU 进程可能因沙箱初始化失败
  // 而反复退出，最终以 `GPU process isn't usable. Goodbye.` 终止整个应用。
  // 这些开关只作用于本验证脚本，不影响应用本身的运行配置。
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('no-sandbox')

  const results = []
  const record = (name, pass, detail) => results.push({ name, pass, detail })

  /**
   * 本轮验证的阶段。三个阶段串起来才是验收场景 10 的完整表述：
   * 首次启动停留项目库（main）→ 开启后**重启**直接进入上次项目（restore）
   * → 关闭后**重启**回到项目库（restore-off）。
   * 「重启」由父进程分别派生真实进程实现，偏好与上次项目通过应用数据目录跨进程传递。
   */
  const phase = process.env.WORKBENCH_SMOKE_PHASE || 'main'
  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
  const readSettings = () => {
    try {
      return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).data
    } catch {
      return null
    }
  }

  const fixtureRoot = path.join(os.tmpdir(), 'workbench-smoke-m1')
  const projectDir = path.join(fixtureRoot, 'project')
  const secondDir = path.join(fixtureRoot, 'second-project')
  /** 重新定位的目标目录：模拟「第二项目」被移动后的新位置 */
  const relocatedDir = path.join(fixtureRoot, 'second-project-moved')

  function buildFixture() {
    removeTree(fixtureRoot)
    // 上一轮若中途失败，会把「恢复上次项目」留在开启状态，下一次启动就会直接进项目页，
    // 让「首次启动停留项目库」这类断言测到污染的起点。只在 main 阶段重置——
    // restore / restore-off 两个阶段靠的正是 main 留下的这份偏好文件。
    if (phase === 'main') fs.rmSync(settingsFile(), { force: true })
    fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'target'), { recursive: true })
    fs.mkdirSync(relocatedDir, { recursive: true })
    fs.writeFileSync(path.join(relocatedDir, 'README.md'), '# 第二项目（已移动）\n\n重新定位验证目标。\n')
    fs.mkdirSync(secondDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'README.md'),
      '# 冒烟项目\n\n用于端到端验证的项目简介段落。\n\n![图](assets/logo.png)\n\n' +
        '![徽标](https://badge.example/logo.png)\n\n<script>alert(1)</script>\n'
    )
    fs.writeFileSync(
      path.join(projectDir, 'assets', 'logo.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64'
      )
    )
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const value: number = 1\n')
    fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'hello\n')
    fs.writeFileSync(
      path.join(projectDir, 'long.txt'),
      `${Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行内容`).join('\n')}\n`
    )
    fs.writeFileSync(path.join(secondDir, 'README.md'), '# 第二项目\n\n用于验证项目切换与会话保持。\n')
    fs.writeFileSync(path.join(secondDir, 'plain.txt'), 'second\n')

    // 冒烟项目做成真实 Git 仓库，并留下四类变更供变更页与差异视图验证
    const run = (args) => execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', windowsHide: true })
    run(['init', '--quiet'])
    run(['config', 'user.email', 'smoke@example.com'])
    run(['config', 'user.name', 'smoke'])
    run(['config', 'core.autocrlf', 'false'])
    fs.writeFileSync(path.join(projectDir, 'tracked.txt'), ['第一行', '第二行', '第三行', ''].join('\n'))
    run(['add', 'tracked.txt', 'README.md'])
    run(['commit', '--quiet', '-m', '初始提交'])
    // 未暂存：改两行
    fs.writeFileSync(path.join(projectDir, 'tracked.txt'), ['第一行已改', '第二行', '新增行', ''].join('\n'))
    // 已暂存：新增并暂存一个文件
    fs.writeFileSync(path.join(projectDir, 'staged.txt'), '暂存内容\n')
    run(['add', 'staged.txt'])
  }

  /** 预置登记数据：主进程按需惰性读取该文件 */
  function seedRegistry() {
    const file = path.join(app.getPath('userData'), 'projects.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const base = {
      descriptionOverride: null,
      readmePath: null,
      pinned: false,
      trusted: false,
      isGitRepository: false
    }
    // 冒烟项目单独覆盖 isGitRepository
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          version: 1,
          data: {
            projects: [
              {
                ...base,
                id: 'smoke-project',
                displayName: '冒烟项目',
                originalPath: projectDir,
                normalizedIdentity: fs.realpathSync.native(projectDir),
                lastOpenedAt: new Date(Date.now() + 1000).toISOString(),
                isGitRepository: true
              },
              {
                ...base,
                id: 'smoke-second',
                displayName: '第二项目',
                originalPath: secondDir,
                normalizedIdentity: fs.realpathSync.native(secondDir),
                lastOpenedAt: new Date().toISOString()
              }
            ],
            viewStates: []
          }
        },
        null,
        2
      ),
      'utf8'
    )
  }

  function waitForWindow(timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        const windows = BrowserWindow.getAllWindows()
        if (windows.length > 0) {
          clearInterval(timer)
          resolve(windows[0])
          return
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          resolve(null)
        }
      }, 100)
    })
  }

  function waitForLoad(window, timeoutMs) {
    return new Promise((resolve) => {
      if (!window.webContents.isLoading()) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), timeoutMs)
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  /** 重新加载渲染层：等同于关掉窗口再打开应用——主进程与磁盘上的偏好都保持原样 */
  function reloadWindow(window, settleMs = 700) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000)
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        setTimeout(() => resolve(true), settleMs)
      })
      window.webContents.reload()
    })
  }

  /**
   * restore / restore-off 阶段：只验证启动位置（C09，验收场景 10）。
   * 应用已作为**新进程**启动，因此「直接进入上次项目」不依赖任何点击。
   */
  async function runStartupPhase(window) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const evaluate = (source) => window.webContents.executeJavaScript(source)
    const waitFor = async (source, timeoutMs = 8000) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        if (await evaluate(source)) return true
        await sleep(150)
      }
      return false
    }
    const onLibrary = `document.querySelectorAll('.library-page').length > 0`
    const noticeText = `document.querySelector('.inline-notice.banner')?.textContent ?? null`

    if (phase === 'restore') {
      const carried = readSettings()
      record(
        '上一轮运行留下的开关状态为开启',
        carried !== null && carried.restoreLastProject === true,
        `settings.json=${JSON.stringify(carried)}`
      )

      const landedDirectly = await waitFor(
        `(() => {
          const slot = document.querySelector('.project-slot:not(.hidden)')
          return slot?.querySelector('h1')?.textContent === '第二项目'
        })()`
      )
      record('开启开关后重启直接进入上次项目', landedDirectly === true, landedDirectly ? '已进入第二项目' : '未进入')
      record(
        '恢复成功时不显示说明条',
        (await evaluate(`document.querySelectorAll('.inline-notice.banner').length`)) === 0,
        `说明条数=${String(await evaluate(`document.querySelectorAll('.inline-notice.banner').length`))}`
      )

      // 恢复不了的两种情形：上次项目已从登记移除 → 停留项目库并说明原因
      await evaluate(`(async () => {
        const list = await window.workbench.project.list()
        const target = list.find((item) => item.displayName === '第二项目')
        if (!target) return null
        return await window.workbench.project.remove({ projectId: target.id })
      })()`)
      await sleep(400)
      await reloadWindow(window)
      const backOnLibrary = await waitFor(onLibrary)
      const removalNotice = await evaluate(noticeText)
      record(
        '上次项目已移除登记时停留项目库并说明',
        backOnLibrary === true && String(removalNotice).includes('不在登记列表'),
        String(removalNotice).slice(0, 48)
      )
      record(
        '移除登记后仍记录着上次项目（开关未动）',
        readSettings()?.restoreLastProject === true && String(readSettings()?.lastProjectId).length > 0,
        `settings.json=${JSON.stringify(readSettings())}`
      )

      // 关掉开关，并把关闭状态留给下一次真实启动（开关已迁至设置页）
      const openedSettings = await evaluate(`(() => {
        const settings = document.querySelector('.sidebar-settings')
        if (settings) settings.click()
        return settings !== null
      })()`)
      const settingsForToggleOff = await waitFor(`document.querySelectorAll('.settings-page').length > 0`)
      const toggled = await evaluate(`(() => {
        const input = document.querySelector('.settings-page .pref-toggle input[type="checkbox"]')
        if (!input) return 'missing'
        if (input.checked) input.click()
        return 'off'
      })()`)
      await sleep(500)
      const afterDisable = readSettings()
      record(
        '关闭开关后持久化为关闭',
        openedSettings === true &&
          settingsForToggleOff === true &&
          toggled === 'off' &&
          afterDisable !== null &&
          afterDisable.restoreLastProject === false,
        `设置页=${String(settingsForToggleOff)} 界面=${String(toggled)} settings.json=${JSON.stringify(afterDisable)}`
      )
      return
    }

    // restore-off：开关已关闭，重启应回到项目库且不产生任何说明
    const carried = readSettings()
    record(
      '上一轮运行已把开关留在关闭状态',
      carried !== null && carried.restoreLastProject === false,
      JSON.stringify(carried)
    )
    const stayedOnLibrary = await waitFor(onLibrary)
    const mountedProjects = await evaluate(`document.querySelectorAll('.project-slot').length`)
    record(
      '关闭开关后重启回到项目库',
      stayedOnLibrary === true && mountedProjects === 0,
      `项目库=${String(stayedOnLibrary)} 已挂载项目页=${String(mountedProjects)}`
    )
    record(
      '默认停留项目库时不显示恢复说明',
      (await evaluate(noticeText)) === null,
      `说明条=${String(await evaluate(noticeText))}`
    )
  }

  async function main() {
    buildFixture()
    seedRegistry()

    // 载入真实主进程（注册 IPC 与创建窗口）
    require(path.join(ROOT, 'out', 'main', 'index.js'))

    const window = await waitForWindow(15000)
    record('主进程启动并创建窗口', window !== null, window === null ? '未创建窗口' : '已创建')

    if (window === null) {
      report()
      return
    }

    // 无显示会话的环境里窗口不会被判定为「可见」，Chromium 会据此节流动画与计时器，
    // 导致宽度过渡、样式重算停在中间状态，使样式断言随机失败。
    // 这只影响本验证脚本的观测稳定性，不改变应用自身的节流策略。
    window.webContents.setBackgroundThrottling(false)

    const loaded = await waitForLoad(window, 15000)
    record('渲染层加载完成', loaded, loaded ? 'did-finish-load' : '超时')

    // 等待预加载层注入
    await new Promise((resolve) => setTimeout(resolve, 600))

    if (phase !== 'main') {
      await runStartupPhase(window)
      report()
      return
    }

    // 界面交互用的三个小工具：统一在这里定义，供后续各段使用
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const evaluate = (source) => window.webContents.executeJavaScript(source)
    const waitFor = async (source, timeoutMs = 6000) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        if (await evaluate(source)) return true
        await sleep(150)
      }
      return false
    }

    const surface = await window.webContents.executeJavaScript(`(() => ({
      hasWorkbench: typeof window.workbench === 'object' && window.workbench !== null,
      projectList: typeof window.workbench?.project?.list,
      filePreview: typeof window.workbench?.file?.preview,
      fileCreate: typeof window.workbench?.file?.create,
      fileTransfer: typeof window.workbench?.file?.transfer,
      fileRename: typeof window.workbench?.file?.rename,
      fileDelete: typeof window.workbench?.file?.deleteToTrash,
      projectRelocate: typeof window.workbench?.project?.relocate,
      confirmQuit: typeof window.workbench?.app?.confirmQuit,
      onQuitRequested: typeof window.workbench?.app?.onQuitRequested,
      terminalCreate: typeof window.workbench?.terminal?.create,
      systemOpenExternal: typeof window.workbench?.system?.openExternal,
      leakedRequire: typeof window.require,
      leakedProcess: typeof window.process,
      leakedIpc: typeof window.ipcRenderer,
      domReady: document.querySelectorAll('.app').length
    }))()`)

    record('预加载层暴露白名单接口', surface.hasWorkbench === true, `workbench=${String(surface.hasWorkbench)}`)
    record(
      '关键接口齐备',
      surface.projectList === 'function' &&
        surface.filePreview === 'function' &&
        surface.fileCreate === 'function' &&
        surface.fileTransfer === 'function' &&
        surface.fileRename === 'function' &&
        surface.fileDelete === 'function' &&
        surface.projectRelocate === 'function' &&
        surface.confirmQuit === 'function' &&
        surface.onQuitRequested === 'function' &&
        surface.terminalCreate === 'function' &&
        surface.systemOpenExternal === 'function',
      `project.list=${surface.projectList} file.preview=${surface.filePreview} file.create=${surface.fileCreate} file.transfer=${surface.fileTransfer}`
    )
    record(
      '渲染进程无 Node 能力泄漏',
      surface.leakedRequire === 'undefined' &&
        surface.leakedProcess === 'undefined' &&
        surface.leakedIpc === 'undefined',
      `require=${surface.leakedRequire} process=${surface.leakedProcess} ipcRenderer=${surface.leakedIpc}`
    )
    record('界面已挂载', surface.domReady > 0, `.app 节点数=${surface.domReady}`)

    // C09 的默认行为：开关未开启时启动停留在项目库（尚无任何点击）
    const bootView = await window.webContents.executeJavaScript(`(() => ({
      library: document.querySelectorAll('.library-page').length,
      projects: document.querySelectorAll('.project-slot').length,
      notice: document.querySelectorAll('.inline-notice.banner').length,
      settingsEntry: document.querySelectorAll('.sidebar-settings').length,
      libraryToggles: document.querySelectorAll('.library-page .pref-toggle').length,
      libraryEditor: document.querySelectorAll('.library-actions .editor-clear').length
    }))()`)
    record(
      '首次启动停留项目库且不显示恢复说明',
      bootView.library === 1 && bootView.projects === 0 && bootView.notice === 0,
      `项目库=${bootView.library} 项目页=${bootView.projects} 说明条=${bootView.notice}`
    )
    record('侧边栏左下角提供设置入口', bootView.settingsEntry === 1, `设置入口数=${bootView.settingsEntry}`)
    record(
      '项目库不再承载应用级设置（开关与编辑器已迁至设置页）',
      bootView.libraryToggles === 0 && bootView.libraryEditor === 0,
      `偏好开关=${bootView.libraryToggles} 编辑器入口=${bootView.libraryEditor}`
    )

    /* ---------- 设置页：应用级偏好收拢在一处（界面重构三项·阶段 2） ---------- */

    await evaluate(
      `(() => { const button = document.querySelector('.sidebar-settings'); if (button) button.click() })()`
    )
    const settingsShown = await waitFor(`document.querySelectorAll('.settings-page').length > 0`)
    const settingsView = await evaluate(`(() => ({
      groups: [...document.querySelectorAll('.settings-group h2')].map((item) => item.textContent),
      shellOptions: [...document.querySelectorAll('.settings-group select option')].map((item) => item.value),
      shellValue: document.querySelector('.settings-group select')?.value ?? null,
      restoreToggle: document.querySelector('.settings-page .pref-toggle input[type="checkbox"]')?.checked ?? null,
      editorText: document.querySelector('.settings-page .settings-value')?.textContent ?? null,
      aboutText: [...document.querySelectorAll('.settings-page .settings-value')].map((item) => item.textContent).join(' / '),
      projectSlots: document.querySelectorAll('.project-slot').length
    }))()`)
    record('侧边栏设置入口可打开设置页', settingsShown === true, `设置页=${String(settingsShown)}`)
    record(
      '设置页承载编辑器、终端、启动与关于四组',
      ['编辑器', '终端', '启动', '关于'].every((title) => settingsView.groups.includes(title)),
      `分组=${settingsView.groups.join(' / ')}`
    )
    record(
      '终端默认 Shell 提供白名单四项且缺省为自动探测',
      settingsView.shellOptions.join(',') === ',pwsh,powershell,cmd' && settingsView.shellValue === '',
      `选项=${settingsView.shellOptions.join(',')} 当前=${String(settingsView.shellValue)}`
    )
    record(
      '设置页的「恢复上次项目」开关默认关闭',
      settingsView.restoreToggle === false,
      `勾选=${String(settingsView.restoreToggle)}`
    )
    record(
      '编辑器缺省为未设置',
      typeof settingsView.editorText === 'string' && settingsView.editorText.includes('未设置'),
      String(settingsView.editorText)
    )
    record('关于展示 Electron 版本', settingsView.aboutText.includes('Electron '), settingsView.aboutText.slice(0, 60))

    // 默认 Shell 经设置页写入应用数据目录（白名单值，主进程持久化）
    await evaluate(`(() => {
      const select = document.querySelector('.settings-group select')
      if (!select) return false
      select.value = 'cmd'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    const shellPersisted = await (async () => {
      const started = Date.now()
      while (Date.now() - started < 5000) {
        if (readSettings()?.defaultShell === 'cmd') return true
        await sleep(120)
      }
      return false
    })()
    record('默认 Shell 经设置页写入 settings.json', shellPersisted === true, JSON.stringify(readSettings()))

    // 改回自动探测：偏好是持久状态，验证脚本结束时把它留回默认值
    await evaluate(`(() => {
      const select = document.querySelector('.settings-group select')
      if (!select) return false
      select.value = ''
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    const shellRestored = await (async () => {
      const started = Date.now()
      while (Date.now() - started < 5000) {
        if (readSettings()?.defaultShell === '') return true
        await sleep(120)
      }
      return false
    })()
    record('默认 Shell 可改回自动探测并持久化', shellRestored === true, JSON.stringify(readSettings()))

    await evaluate(
      `(() => { const button = document.querySelector('.sidebar-library'); if (button) button.click() })()`
    )
    const backToLibrary = await waitFor(`document.querySelectorAll('.library-page').length > 0`)
    record('从设置页可回到项目库', backToLibrary === true, `项目库=${String(backToLibrary)}`)

    // 端到端 IPC：项目列表
    const projects = await window.webContents.executeJavaScript('window.workbench.project.list()')
    record(
      '项目列表经 IPC 可用且简介取自 README',
      Array.isArray(projects) &&
        projects.length === 2 &&
        projects.some((item) => item.descriptionSource === 'readme' && String(item.description).includes('端到端验证')),
      `数量=${Array.isArray(projects) ? projects.length : 'N/A'}`
    )

    const projectId =
      projects?.find((item) => item.displayName === '冒烟项目')?.id ?? projects?.[0]?.id ?? 'smoke-project'

    const listing = await window.webContents.executeJavaScript(
      `window.workbench.file.list({ projectId: ${JSON.stringify(projectId)}, relativePath: '' })`
    )
    record(
      '文件列表经 IPC 可用',
      listing?.error === null &&
        Array.isArray(listing?.entries) &&
        listing.entries.some((entry) => entry.name === 'README.md'),
      `条目数=${listing?.entries?.length ?? 'N/A'} error=${String(listing?.error)}`
    )

    const preview = await window.webContents.executeJavaScript(
      `window.workbench.file.preview({ projectId: ${JSON.stringify(projectId)}, relativePath: 'README.md' })`
    )
    record(
      'Markdown 预览经 IPC 可用且脚本被移除',
      preview?.kind === 'markdown' &&
        typeof preview?.markdown?.html === 'string' &&
        !/<script/i.test(preview.markdown.html) &&
        !/\ssrc\s*=/i.test(preview.markdown.html),
      `kind=${String(preview?.kind)} 阻止项=${preview?.markdown?.blocked?.length ?? 'N/A'}`
    )
    record(
      '项目内图片进入待加载清单',
      Array.isArray(preview?.markdown?.assets) && preview.markdown.assets.includes('assets/logo.png'),
      (preview?.markdown?.assets ?? []).join(', ')
    )

    const asset = await window.webContents.executeJavaScript(
      `window.workbench.file.readAsset({ projectId: ${JSON.stringify(projectId)}, relativePath: 'assets/logo.png' })`
    )
    record(
      '图片资源经 IPC 读取为 data URL',
      asset?.status === 'ok' && String(asset?.dataUrl).startsWith('data:image/png;base64,'),
      `status=${String(asset?.status)}`
    )

    const escapeAttempt = await window.webContents.executeJavaScript(
      `window.workbench.file.preview({ projectId: ${JSON.stringify(projectId)}, relativePath: '../../Windows/win.ini' })`
    )
    record('项目外路径经 IPC 被拒绝', escapeAttempt?.kind === 'error', String(escapeAttempt?.message))

    const snapshot = await window.webContents.executeJavaScript(
      `window.workbench.git.snapshot({ projectId: ${JSON.stringify(projectId)}, sequence: 1 })`
    )
    record(
      'Git 快照经 IPC 返回可区分结构',
      snapshot !== null && typeof snapshot === 'object' && 'stale' in snapshot,
      `stale=${String(snapshot?.stale)} error=${String(snapshot?.error)}`
    )

    const terminal = await window.webContents.executeJavaScript(
      `window.workbench.terminal.create({ projectId: ${JSON.stringify(projectId)}, relativePath: '', cols: 80, rows: 24 })`
    )
    record(
      '终端会话经 IPC 创建',
      typeof terminal?.sessionId === 'string' && terminal.sessionId.length > 0,
      `sessionId=${String(terminal?.sessionId)} shell=${String(terminal?.shell)}`
    )
    if (typeof terminal?.sessionId === 'string') {
      await window.webContents.executeJavaScript(
        `window.workbench.terminal.dispose(${JSON.stringify(terminal.sessionId)})`
      )
      record('终端会话可关闭', true, '已 dispose')
    }

    // 导航限制：尝试跳转到外链，地址不应改变
    const before = window.webContents.getURL()
    await window.webContents.executeJavaScript(
      `(() => { try { window.location.href = 'https://example.com/blocked' } catch (error) { /* 忽略 */ } })()`
    )
    await new Promise((resolve) => setTimeout(resolve, 800))
    const after = window.webContents.getURL()
    record('页面导航被阻止', before === after, `before=${before.slice(-28)} after=${after.slice(-28)}`)

    /* ---------- 界面交互：终端面板开关与文件树展开 ---------- */

    // 进入项目页（在项目库卡片上点击「打开」）
    const opened = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.project-card')].find((item) => item.textContent.includes('冒烟项目'))
      if (!card) return false
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '打开')
      if (!button) return false
      button.click()
      return true
    })()`)
    record('项目库卡片可打开项目', opened === true, opened ? '已进入项目页' : '未找到「打开」按钮')
    await waitFor(`document.querySelectorAll('.project-page').length > 0`)

    /* ---------- 网络图片按项目授权（设计稿 4.3 / G1） ---------- */

    const registryFile = path.join(app.getPath('userData'), 'projects.json')
    const readRegistryFlag = (projectId) => {
      try {
        const raw = JSON.parse(fs.readFileSync(registryFile, 'utf8'))
        const item = (raw?.data?.projects ?? []).find((project) => project.id === projectId)
        return item === undefined ? null : item.allowNetworkImages
      } catch {
        return null
      }
    }
    const waitRegistryFlag = async (projectId, expected) => {
      const started = Date.now()
      while (Date.now() - started < 5000) {
        if (readRegistryFlag(projectId) === expected) return true
        await sleep(120)
      }
      return false
    }
    const blockedToggle = () => evaluate(`(document.querySelector('.blocked-toggle')?.textContent ?? '').trim()`)
    /** 概览页的介绍文件是异步读取的，断言前必须等它落地，否则测到的是「还没渲染」 */
    const switchPresent = await waitFor(
      `document.querySelector('.remote-image-policy input[type="checkbox"]') !== null`
    )

    const policySwitch = await evaluate(`(() => {
      const label = document.querySelector('.remote-image-policy')
      const box = label === null ? null : label.querySelector('input[type="checkbox"]')
      return {
        present: label !== null,
        checked: box === null ? null : box.checked,
        text: label === null ? '' : label.textContent
      }
    })()`)
    record(
      'README 区出现「允许本项目加载网络图片」开关',
      switchPresent && policySwitch.present && policySwitch.checked === false,
      `存在=${String(policySwitch.present)} 勾选=${String(policySwitch.checked)}`
    )
    record(
      '开关旁写明代为抓取与限制条件',
      policySwitch.text.includes('由应用代为抓取') && policySwitch.text.includes('本机或内网'),
      policySwitch.text.slice(0, 46)
    )
    record(
      '旧登记记录（无该字段）按默认关闭处理',
      readRegistryFlag('smoke-project') === false,
      `projects.json 字段=${String(readRegistryFlag('smoke-project'))}`
    )

    const blockedBeforeSeen = await waitFor(
      `(() => { const t = document.querySelector('.blocked-toggle'); return t !== null && t.textContent.includes('网络资源') })()`
    )
    const blockedBefore = await blockedToggle()
    record('未授权：远程图片计入被阻止清单', blockedBeforeSeen && blockedBefore.includes('网络资源'), blockedBefore)

    await evaluate(`(() => {
      const box = document.querySelector('.remote-image-policy input[type="checkbox"]')
      if (box !== null) box.click()
    })()`)
    const granted = await waitRegistryFlag('smoke-project', true)
    record('勾选后授权写入 projects.json', granted, `allowNetworkImages=${String(readRegistryFlag('smoke-project'))}`)
    record(
      '授权只写应用数据目录，不在用户项目内留文件',
      !fs.existsSync(path.join(projectDir, 'projects.json')) && !fs.existsSync(path.join(projectDir, 'settings.json')),
      projectDir
    )

    // 授权改变的是一次新的预览请求，等预览回到「不再计网络资源」再取界面状态
    const grantedViewSeen = await waitFor(
      `(() => { const t = document.querySelector('.blocked-toggle'); return t === null || !t.textContent.includes('网络资源') })()`
    )
    const afterGrant = await evaluate(`(() => {
      const images = [...document.querySelectorAll('.markdown-body img')]
      return {
        blocked: (document.querySelector('.blocked-toggle')?.textContent ?? '').trim(),
        httpSrc: images.filter((image) => /^https?:/i.test(image.getAttribute('src') ?? '')).length
      }
    })()`)
    record(
      '授权后远程图片不再计入「网络资源」被阻止项',
      grantedViewSeen && !afterGrant.blocked.includes('网络资源'),
      afterGrant.blocked
    )
    // a11y：内容区为 tabpanel，且当前分段控件 tab 通过 aria-controls 指向它
    const tabpanelLinked = await evaluate(`(() => {
      const main = document.querySelector('.project-content')
      const selected = document.querySelector('.segmented [role="tab"][aria-selected="true"]')
      return (
        !!main &&
        main.getAttribute('role') === 'tabpanel' &&
        !!selected &&
        selected.getAttribute('aria-controls') === main.id
      )
    })()`)
    record('内容区为 tabpanel 且与分段控件关联', tabpanelLinked === true, `tabpanel 关联=${String(tabpanelLinked)}`)
    const grantedDoc = await evaluate(
      `window.workbench.file.preview({ projectId: ${JSON.stringify(projectId)}, relativePath: 'README.md' })`
    )
    record(
      '授权后主进程把远程图片改标为待取资源（仍不写出 src）',
      (grantedDoc?.markdown?.remoteAssets ?? []).includes('https://badge.example/logo.png') &&
        (grantedDoc?.markdown?.html ?? '').includes('data-remote=') &&
        !/\ssrc\s*=/i.test(grantedDoc?.markdown?.html ?? ''),
      `remote=${(grantedDoc?.markdown?.remoteAssets ?? []).join(', ')}`
    )
    record(
      '渲染层从不直连远程地址（DOM 内无 http(s) 的 img[src]）',
      afterGrant.httpSrc === 0,
      `httpSrc 数=${afterGrant.httpSrc}`
    )

    const remoteExplained = await waitFor(`(() => {
      const scope = document.querySelector('.markdown-preview')
      const text = scope === null ? '' : scope.textContent
      return text.includes('badge.example') || text.includes('部分网络图片未加载') ||
        [...document.querySelectorAll('.markdown-body img.md-image')].length > 0
    })()`)
    const remoteState = await evaluate(`(() => {
      const loaded = [...document.querySelectorAll('.markdown-body img')].filter(
        (image) => (image.getAttribute('data-remote') ?? '').includes('badge.example') && image.classList.contains('md-image')
      ).length
      const placeholders = [...document.querySelectorAll('.md-image-placeholder')].map((node) => node.textContent).join(' / ')
      return { loaded, placeholders }
    })()`)
    record(
      '远程图片要么经主进程取回、要么如实说明，不静默空白',
      remoteExplained,
      `已加载=${remoteState.loaded} 占位=${remoteState.placeholders.slice(0, 60)}`
    )

    await evaluate(`(() => {
      const box = document.querySelector('.remote-image-policy input[type="checkbox"]')
      if (box !== null) box.click()
    })()`)
    const revoked = await waitRegistryFlag('smoke-project', false)
    record('取消勾选即撤销授权并持久化', revoked, `allowNetworkImages=${String(readRegistryFlag('smoke-project'))}`)
    const blockedAgainSeen = await waitFor(
      `(() => { const t = document.querySelector('.blocked-toggle'); return t !== null && t.textContent.includes('网络资源') })()`
    )
    record('撤销后下一次预览回到阻止形态', blockedAgainSeen, await blockedToggle())

    /* ---------- 侧边栏：项目列表 ---------- */

    const sidebarProjects = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.sidebar-item')]
      return {
        count: items.length,
        names: items.map((item) => item.querySelector('.sidebar-item-name')?.textContent ?? ''),
        activeName: document.querySelector('.sidebar-item.active .sidebar-item-name')?.textContent ?? null,
        activeMarked: document.querySelector('.sidebar-item.active .sidebar-item-main')?.getAttribute('aria-current') ?? null,
        libraryActive: document.querySelector('.sidebar-library.active') === null
      }
    })()`)
    record(
      '侧边栏列出全部项目',
      sidebarProjects.count === 2 &&
        sidebarProjects.names.includes('冒烟项目') &&
        sidebarProjects.names.includes('第二项目'),
      `数量=${sidebarProjects.count} 名称=${sidebarProjects.names.join(' / ')}`
    )
    record(
      '侧边栏标记当前项目',
      sidebarProjects.activeName === '冒烟项目' && sidebarProjects.activeMarked === 'true',
      `当前=${String(sidebarProjects.activeName)} aria-current=${String(sidebarProjects.activeMarked)}`
    )

    /* ---------- 侧边栏收起 ---------- */

    const sidebarBefore = await evaluate(`(() => {
      const nav = document.querySelector('.sidebar')
      const content = document.querySelector('.project-content')
      return {
        navWidth: nav === null ? -1 : Math.round(nav.getBoundingClientRect().width),
        contentWidth: content === null ? 0 : Math.round(content.getBoundingClientRect().width),
        hasToggle: document.querySelector('.icon-button') !== null
      }
    })()`)
    record(
      '项目侧边栏可收起',
      sidebarBefore.hasToggle === true && sidebarBefore.navWidth > 100,
      `开关=${String(sidebarBefore.hasToggle)} 宽度=${sidebarBefore.navWidth}px`
    )

    await evaluate(`(() => { const button = document.querySelector('.icon-button'); if (button) button.click() })()`)
    await sleep(450)
    const sidebarCollapsed = await evaluate(`(() => {
      const nav = document.querySelector('.sidebar')
      const content = document.querySelector('.project-content')
      return {
        collapsed: nav !== null && nav.classList.contains('collapsed'),
        navWidth: nav === null ? -1 : Math.round(nav.getBoundingClientRect().width),
        contentWidth: content === null ? 0 : Math.round(content.getBoundingClientRect().width),
        hiddenFromA11y: nav !== null && nav.getAttribute('aria-hidden') === 'true',
        tabbable: [...document.querySelectorAll('.sidebar-item-main, .sidebar-library')]
          .filter((item) => item.tabIndex >= 0).length
      }
    })()`)
    record(
      '点击开关可收起侧边栏',
      sidebarCollapsed.collapsed === true && sidebarCollapsed.navWidth === 0,
      `collapsed=${String(sidebarCollapsed.collapsed)} 宽度=${sidebarCollapsed.navWidth}px`
    )
    record(
      '收起后内容区变宽',
      sidebarCollapsed.contentWidth > sidebarBefore.contentWidth,
      `${sidebarBefore.contentWidth}px → ${sidebarCollapsed.contentWidth}px`
    )
    record(
      '收起后侧边栏退出无障碍树与 Tab 顺序',
      sidebarCollapsed.hiddenFromA11y === true && sidebarCollapsed.tabbable === 0,
      `aria-hidden=${String(sidebarCollapsed.hiddenFromA11y)} 可聚焦项=${sidebarCollapsed.tabbable}`
    )

    await evaluate(
      `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true })) })()`
    )
    await sleep(450)
    const sidebarRestored = await evaluate(`(() => {
      const nav = document.querySelector('.sidebar')
      return {
        collapsed: nav !== null && nav.classList.contains('collapsed'),
        width: nav === null ? -1 : Math.round(nav.getBoundingClientRect().width)
      }
    })()`)
    record(
      'Ctrl+B 可切换侧边栏',
      sidebarRestored.collapsed === false && sidebarRestored.width > 100,
      `collapsed=${String(sidebarRestored.collapsed)} 宽度=${sidebarRestored.width}px`
    )

    // 终端面板不应常驻底部
    const docked = await evaluate(`(() => ({
      panels: document.querySelectorAll('.terminal-panel').length,
      contentHeight: Math.round(document.querySelector('.project-content')?.getBoundingClientRect().height ?? 0),
      pageHeight: Math.round(document.querySelector('.project-page')?.getBoundingClientRect().height ?? 0)
    }))()`)
    record(
      '终端面板默认不占用底部空间',
      docked.panels === 0,
      `面板数=${docked.panels}（内容区 ${docked.contentHeight}px / 页面 ${docked.pageHeight}px）`
    )

    // 未信任项目点击终端应先确认信任
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('终端 ·'))
      if (button) button.click()
    })()`)
    const trustShown = await waitFor(`document.querySelectorAll('.modal-backdrop').length > 0`)
    record('未信任项目创建终端前先确认信任', trustShown === true, trustShown ? '已弹出确认' : '未弹出')

    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.modal button')].find((item) => item.textContent.includes('信任并创建终端'))
      if (button) button.click()
    })()`)
    const panelOpened = await waitFor(`(() => {
      const panel = document.querySelector('.terminal-panel')
      if (!panel) return false
      return Math.round(panel.getBoundingClientRect().height) > 100
    })()`)
    record('确认信任后终端面板打开并创建会话', panelOpened === true, panelOpened ? '面板可见' : '面板未出现')

    // 拖拽终端面板上边缘调整高度（不使用滑动条）
    const sliderCount = await evaluate(`document.querySelectorAll('input[type="range"]').length`)
    record('界面中没有滑动条', sliderCount === 0, `range 输入框数=${sliderCount}`)

    const dragUp = await evaluate(`(() => {
      const handle = document.querySelector('.terminal-resize')
      const panel = document.querySelector('.terminal-panel')
      if (!handle || !panel) return null
      const before = Math.round(panel.getBoundingClientRect().height)
      const top = handle.getBoundingClientRect().top + 3
      const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 }
      handle.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { clientX: 400, clientY: top })))
      handle.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, base, { clientX: 400, clientY: top - 80 })))
      handle.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { clientX: 400, clientY: top - 80 })))
      return { before }
    })()`)
    await sleep(300)
    const heightAfterDrag = await evaluate(
      `Math.round(document.querySelector('.terminal-panel').getBoundingClientRect().height)`
    )
    record(
      '拖拽上边缘可增高终端面板',
      dragUp !== null && heightAfterDrag === dragUp.before + 80,
      `${String(dragUp?.before)}px → ${heightAfterDrag}px（位移 80px）`
    )

    const dragDown = await evaluate(`(() => {
      const handle = document.querySelector('.terminal-resize')
      const panel = document.querySelector('.terminal-panel')
      if (!handle || !panel) return null
      const before = Math.round(panel.getBoundingClientRect().height)
      const top = handle.getBoundingClientRect().top + 3
      const base = { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', button: 0, buttons: 1 }
      handle.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { clientX: 400, clientY: top })))
      handle.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, base, { clientX: 400, clientY: top + 140 })))
      handle.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { clientX: 400, clientY: top + 140 })))
      return { before }
    })()`)
    await sleep(300)
    const heightAfterShrink = await evaluate(
      `Math.round(document.querySelector('.terminal-panel').getBoundingClientRect().height)`
    )
    record(
      '拖拽上边缘可减小终端面板',
      dragDown !== null && heightAfterShrink === dragDown.before - 140,
      `${String(dragDown?.before)}px → ${heightAfterShrink}px（位移 -140px）`
    )

    await evaluate(`(() => {
      const handle = document.querySelector('.terminal-resize')
      if (!handle) return false
      const top = handle.getBoundingClientRect().top + 3
      const base = { bubbles: true, cancelable: true, pointerId: 5, pointerType: 'mouse', button: 0, buttons: 1 }
      handle.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { clientX: 400, clientY: top })))
      handle.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, base, { clientX: 400, clientY: top + 4000 })))
      handle.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { clientX: 400, clientY: top + 4000 })))
      return true
    })()`)
    await sleep(300)
    const heightClamped = await evaluate(
      `Math.round(document.querySelector('.terminal-panel').getBoundingClientRect().height)`
    )
    record('拖拽高度有下限约束', heightClamped === 120, `下限约束后 ${String(heightClamped)}px`)

    /* ---------- 终端多标签（M2-5） ---------- */

    const firstTab = await evaluate(`(() => ({
      tabs: document.querySelectorAll('.terminal-tab').length,
      liveDots: document.querySelectorAll('.terminal-tab .tab-dot.live').length,
      labels: [...document.querySelectorAll('.terminal-tab-label')].map((item) => item.textContent.trim())
    }))()`)
    record(
      '终端面板显示标签条',
      firstTab.tabs === 1 && firstTab.liveDots === 1,
      `标签=${firstTab.tabs} 运行中=${firstTab.liveDots} 名称=${firstTab.labels.join(',')}`
    )

    // 新建第二个标签
    await evaluate(`(() => {
      const add = document.querySelector('.terminal-tab-add')
      if (add) add.click()
    })()`)
    await sleep(1200)
    const twoTabs = await evaluate(`(() => ({
      tabs: document.querySelectorAll('.terminal-tab').length,
      liveDots: document.querySelectorAll('.terminal-tab .tab-dot.live').length,
      activeTabs: document.querySelectorAll('.terminal-tab.active').length,
      visibleHosts: [...document.querySelectorAll('.terminal-host-wrap')]
        .filter((host) => !host.classList.contains('hidden')).length,
      badge: document.querySelector('.terminal-title .badge')?.textContent ?? null
    }))()`)
    record(
      '可新建第二个终端标签',
      twoTabs.tabs === 2 && twoTabs.activeTabs === 1,
      `标签=${twoTabs.tabs} 活动=${twoTabs.activeTabs}`
    )
    record('两个标签各自保持独立会话', twoTabs.liveDots === 2, `运行中的标签=${twoTabs.liveDots}`)
    record('同一时刻只显示一个终端视图', twoTabs.visibleHosts === 1, `可见终端=${twoTabs.visibleHosts}`)
    record(
      '头部汇总运行中的会话数',
      typeof twoTabs.badge === 'string' && twoTabs.badge.includes('2 个会话运行中'),
      String(twoTabs.badge)
    )

    // 关闭第二个标签
    await evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.terminal-tab')]
      const last = tabs[tabs.length - 1]
      const close = last?.querySelector('.terminal-tab-close')
      if (close) close.click()
    })()`)
    await sleep(900)
    const afterTabClose = await evaluate(`(() => ({
      tabs: document.querySelectorAll('.terminal-tab').length,
      liveDots: document.querySelectorAll('.terminal-tab .tab-dot.live').length
    }))()`)
    record(
      '关闭标签后其余会话不受影响',
      afterTabClose.tabs === 1 && afterTabClose.liveDots === 1,
      `标签=${afterTabClose.tabs} 运行中=${afterTabClose.liveDots}`
    )

    // 收起：面板隐藏但终端组件仍挂载，会话不终止
    const collapsed = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.terminal-panel button')].find((item) => item.textContent.includes('收起'))
      if (button) button.click()
      return button !== undefined
    })()`)
    await sleep(400)
    const collapseState = await evaluate(`(() => {
      const panel = document.querySelector('.terminal-panel')
      const host = document.querySelector('.terminal-host')
      return {
        collapsed: panel !== null && panel.classList.contains('closed'),
        panelDisplay: panel === null ? 'none' : getComputedStyle(panel).display,
        hostStillMounted: host !== null,
        headerLabel: [...document.querySelectorAll('button')].some((item) => item.textContent.includes('会话运行中'))
      }
    })()`)
    record(
      '收起后终端面板不再占用布局',
      collapsed === true && collapseState.collapsed === true && collapseState.panelDisplay === 'none',
      `closed=${String(collapseState.collapsed)} display=${collapseState.panelDisplay}`
    )
    record(
      '收起不终止会话（终端组件保持挂载）',
      collapseState.hostStillMounted === true && collapseState.headerLabel === true,
      `host 挂载=${String(collapseState.hostStillMounted)} 头部显示会话运行中=${String(collapseState.headerLabel)}`
    )

    /* ---------- 侧边栏：终端运行提示 ---------- */

    const runningIndicator = await evaluate(`(() => ({
      runningDots: document.querySelectorAll('.sidebar-dot.running').length,
      liveMarks: [...document.querySelectorAll('.sidebar-mark.live')].map((item) => item.textContent),
      summary: document.querySelector('.sidebar-running')?.textContent ?? null
    }))()`)
    record(
      '侧边栏标记有终端运行的项目',
      runningIndicator.runningDots === 1 && runningIndicator.liveMarks.includes('终端'),
      `脉冲点=${runningIndicator.runningDots} 标记=${runningIndicator.liveMarks.join(',')}`
    )
    record(
      '侧边栏汇总运行中的终端数量',
      typeof runningIndicator.summary === 'string' && runningIndicator.summary.includes('1 个终端运行中'),
      String(runningIndicator.summary)
    )

    /* ---------- 侧边栏：切换项目与会话保持 ---------- */

    const switchToSecond = await evaluate(`(() => {
      const item = [...document.querySelectorAll('.sidebar-item-main')]
        .find((button) => button.textContent.includes('第二项目'))
      if (!item) return false
      item.click()
      return true
    })()`)
    await sleep(700)
    const onSecond = await evaluate(`(() => {
      const headers = [...document.querySelectorAll('.project-page')]
        .filter((page) => page.closest('.project-slot')?.classList.contains('hidden') !== true)
      const header = headers[0] ?? null
      const terminalButton = header === null
        ? null
        : [...header.querySelectorAll('button.chip')].find((button) => button.textContent.includes('终端 ·'))
      return {
        visiblePages: headers.length,
        title: header?.querySelector('h1')?.textContent ?? null,
        terminalLabel: terminalButton?.textContent ?? null,
        runningDots: document.querySelectorAll('.sidebar-dot.running').length
      }
    })()`)
    record(
      '点击侧边栏可切换项目',
      switchToSecond === true && onSecond.title === '第二项目' && onSecond.visiblePages === 1,
      `可见项目页=${onSecond.visiblePages} 标题=${String(onSecond.title)}`
    )
    record(
      '切换后新项目没有终端会话',
      typeof onSecond.terminalLabel === 'string' && onSecond.terminalLabel.includes('未创建'),
      String(onSecond.terminalLabel)
    )
    record(
      '原项目的终端仍在运行（会话未因切换终止）',
      onSecond.runningDots === 1,
      `运行中的终端项目数=${onSecond.runningDots}`
    )

    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.sidebar-item-main')]
        .find((button) => button.textContent.includes('冒烟项目'))
      if (item) item.click()
    })()`)
    await sleep(700)
    const backToFirst = await evaluate(`(() => {
      const headers = [...document.querySelectorAll('.project-page')]
        .filter((page) => page.closest('.project-slot')?.classList.contains('hidden') !== true)
      const header = headers[0] ?? null
      const terminalButton = header === null
        ? null
        : [...header.querySelectorAll('button.chip')].find((button) => button.textContent.includes('终端 ·'))
      const host = header?.querySelector('.terminal-host')
      return {
        title: header?.querySelector('h1')?.textContent ?? null,
        terminalLabel: terminalButton?.textContent ?? null,
        terminalMounted: host !== null && host !== undefined
      }
    })()`)
    record(
      '切回原项目后终端会话仍在运行',
      backToFirst.title === '冒烟项目' &&
        typeof backToFirst.terminalLabel === 'string' &&
        backToFirst.terminalLabel.includes('会话运行中') &&
        backToFirst.terminalMounted === true,
      `标题=${String(backToFirst.title)} 终端=${String(backToFirst.terminalLabel)}`
    )

    const multiOpen = await evaluate(`(() => ({
      closeButtons: document.querySelectorAll('.sidebar-item-close').length,
      openDots: document.querySelectorAll('.sidebar-dot.on, .sidebar-dot.running').length
    }))()`)
    record(
      '多个项目可同时保持打开',
      multiOpen.closeButtons === 2 && multiOpen.openDots === 2,
      `关闭按钮=${multiOpen.closeButtons} 已打开标记=${multiOpen.openDots}`
    )

    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.sidebar-item')]
        .find((row) => row.textContent.includes('第二项目'))
      const button = item?.querySelector('.sidebar-item-close')
      if (button) button.click()
    })()`)
    await sleep(700)
    const afterClose = await evaluate(`(() => ({
      closeButtons: document.querySelectorAll('.sidebar-item-close').length,
      registered: document.querySelectorAll('.sidebar-item').length,
      title: document.querySelector('.project-slot:not(.hidden) h1')?.textContent ?? null
    }))()`)
    record(
      '关闭项目后仍保留登记',
      afterClose.closeButtons === 1 && afterClose.registered === 2,
      `已打开=${afterClose.closeButtons} 已登记=${afterClose.registered}`
    )
    record('关闭当前项目后自动切到其余已打开项目', afterClose.title === '冒烟项目', `当前=${String(afterClose.title)}`)

    // 文件树：目录可展开（页面切换改为头部分段控件）
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.segmented button')].find((item) => item.textContent.includes('文件'))
      if (button) button.click()
    })()`)
    await waitFor(`document.querySelectorAll('.tree-row').length > 0`)

    // M3 文件操作入口：通过真实界面点击，使用页面内替身响应原生 prompt/confirm。
    const clickToolbarButton = async (text) =>
      evaluate(`(() => {
        const button = [...document.querySelectorAll('.browser-actions button')]
          .find((item) => item.textContent.includes(${JSON.stringify(text)}))
        if (!button || button.disabled) return false
        button.click()
        return true
      })()`)
    const clickTreeEntry = async (name) =>
      evaluate(`(() => {
        const label = [...document.querySelectorAll('.tree-label')]
          .find((item) => item.querySelector('.name')?.textContent.trim() === ${JSON.stringify(name)})
        if (!label) return false
        label.click()
        return true
      })()`)
    await evaluate(`(() => { window.prompt = () => 'ui-created.txt'; return true })()`)
    const createClicked = await clickToolbarButton('新建文件')
    const createdVisible = await waitFor(`document.querySelectorAll('.tree-label .name').length > 0 &&
      [...document.querySelectorAll('.tree-label .name')].some((item) => item.textContent.trim() === 'ui-created.txt')`)
    record(
      '界面新建文件入口可用',
      createClicked === true && createdVisible === true,
      `点击=${String(createClicked)} 可见=${String(createdVisible)}`
    )

    await evaluate(`(() => { window.prompt = () => 'ui-renamed.txt'; return true })()`)
    const renameClicked = await clickToolbarButton('重命名')
    const renamedVisible = await waitFor(`([...document.querySelectorAll('.tree-label .name')]
      .some((item) => item.textContent.trim() === 'ui-renamed.txt'))`)
    record(
      '界面重命名入口可用',
      renameClicked === true && renamedVisible === true,
      `点击=${String(renameClicked)} 可见=${String(renamedVisible)}`
    )

    const copySourceSelected = await clickTreeEntry('ui-renamed.txt')
    const copyClicked = await clickToolbarButton('复制')
    const targetSelectedForCopy = await clickTreeEntry('target')
    const pasteCopyClicked = await clickToolbarButton('粘贴')
    const copiedVisible = await waitFor(
      `document.querySelectorAll('.tree-row[title*="target/ui-renamed.txt"]').length > 0`,
      2500
    )
    record(
      '界面复制粘贴入口可用',
      copySourceSelected === true &&
        copyClicked === true &&
        targetSelectedForCopy === true &&
        pasteCopyClicked === true &&
        copiedVisible === true,
      `选择源=${String(copySourceSelected)} 复制=${String(copyClicked)} 选择目标=${String(targetSelectedForCopy)} 粘贴=${String(pasteCopyClicked)}`
    )

    await evaluate(`(() => {
      const root = [...document.querySelectorAll('.breadcrumb button')]
        .find((item) => item.textContent.trim() === '项目根')
      if (root) root.click()
    })()`)
    await sleep(250)
    await evaluate(`(() => { window.prompt = () => 'ui-cut.txt'; return true })()`)
    const createCutClicked = await clickToolbarButton('新建文件')
    const cutCreated = await waitFor(`([...document.querySelectorAll('.tree-label .name')]
      .some((item) => item.textContent.trim() === 'ui-cut.txt'))`)
    const cutSourceSelected = await clickTreeEntry('ui-cut.txt')
    const cutClicked = await clickToolbarButton('剪切')
    const targetSelectedForCut = await clickTreeEntry('target')
    const pasteCutClicked = await clickToolbarButton('粘贴')
    const cutMoved = await waitFor(`document.querySelectorAll('.tree-row[title*="target/ui-cut.txt"]').length > 0`)
    record(
      '界面剪切粘贴入口可用',
      createCutClicked === true &&
        cutCreated === true &&
        cutSourceSelected === true &&
        cutClicked === true &&
        targetSelectedForCut === true &&
        pasteCutClicked === true &&
        cutMoved === true,
      `新建=${String(createCutClicked)} 剪切=${String(cutClicked)} 粘贴=${String(pasteCutClicked)}`
    )

    await evaluate(`(() => { window.confirm = () => true; return true })()`)
    const deleteTargetSelected = await clickTreeEntry('ui-cut.txt')
    const deleteClicked = await clickToolbarButton('删除')
    const deleted = await waitFor(`!([...document.querySelectorAll('.tree-label .name')]
      .some((item) => item.textContent.trim() === 'ui-cut.txt'))`)
    record(
      '界面删除入口可用且进入回收站流程',
      deleteTargetSelected === true && deleteClicked === true && deleted === true,
      `选择=${String(deleteTargetSelected)} 删除=${String(deleteClicked)} 已移除=${String(deleted)}`
    )

    const beforeExpand = await evaluate(`document.querySelectorAll('.tree-row').length`)
    const expandable = await evaluate(`document.querySelectorAll('.tree-row .twisty:not(.placeholder)').length`)
    record('文件树提供可展开的目录', expandable > 0, `可展开目录数=${expandable}`)

    const tooltips = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.tree-row')]
      const withTitle = rows.filter((row) => (row.getAttribute('title') || '').length > 0)
      const sample = rows.length === 0 ? null : rows[0].getAttribute('title')
      return { total: rows.length, withTitle: withTitle.length, sample }
    })()`)
    record(
      '文件树每行都有悬浮提示',
      tooltips.total > 0 && tooltips.withTitle === tooltips.total,
      `${tooltips.withTitle}/${tooltips.total} 行带 title`
    )
    record(
      '悬浮提示首行为条目名称',
      typeof tooltips.sample === 'string' && (tooltips.sample.split('\n')[0] ?? '').length > 0,
      JSON.stringify(tooltips.sample)
    )

    // 键盘可达性（P0-3）：roving tabindex —— 恰一个 treeitem 可被 Tab 进入；
    // 聚焦首行后按 ↓ 把焦点与选中移到下一行。分步等待 React 提交后再断言。
    const treeTabbable = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[role="treeitem"]')]
      return { total: items.length, tabbable: items.filter((el) => el.getAttribute('tabindex') === '0').length }
    })()`)
    await evaluate(`(() => { const first = document.querySelector('[role="treeitem"]'); if (first) first.focus() })()`)
    await sleep(80)
    await evaluate(`(() => {
      const active = document.activeElement
      if (active && active.getAttribute('role') === 'treeitem') {
        active.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      }
    })()`)
    await sleep(120)
    const keyboardTree = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[role="treeitem"]')]
      const active = document.activeElement
      return {
        total: items.length,
        activeIndex: items.indexOf(active),
        selected: active === null ? null : active.getAttribute('aria-selected'),
        tabbable: items.filter((el) => el.getAttribute('tabindex') === '0').length
      }
    })()`)
    record(
      '方向键可在文件树中移动焦点与选中',
      treeTabbable.total >= 2 &&
        treeTabbable.tabbable === 1 &&
        keyboardTree.activeIndex === 1 &&
        keyboardTree.selected === 'true' &&
        keyboardTree.tabbable === 1,
      JSON.stringify({ before: treeTabbable, after: keyboardTree })
    )

    // 点击文件夹整行（不是箭头）即可展开
    const rowClicked = await evaluate(`(() => {
      const label = document.querySelector('.tree-row .tree-label')
      if (!label) return false
      label.click()
      return true
    })()`)
    await sleep(600)
    const afterExpand = await evaluate(`document.querySelectorAll('.tree-row').length`)
    record(
      '点击文件夹整行即可展开',
      rowClicked === true && afterExpand > beforeExpand,
      `${beforeExpand} 行 → ${afterExpand} 行`
    )

    const chevronRotated = await evaluate(`document.querySelectorAll('.tree-row .twisty.expanded').length`)
    record('展开态由箭头旋转体现', chevronRotated > 0, `旋转箭头数=${chevronRotated}`)

    // 视觉基线：样式表未生效或类名漂移时这几项会失败。
    //
    // 先显式建立选中态再测量：此前的断言依赖「上一次点击留下的选中态」，
    // 而文件操作后的异步刷新可能已把选中态清掉，导致该项随机失败。
    // 用「项目根」清空选中 + Ctrl 点击选中一行（Ctrl 点击不展开／收起目录），
    // 因此不会改变后续断言依赖的展开状态。
    await evaluate(`(() => {
      const root = [...document.querySelectorAll('.breadcrumb button')]
        .find((item) => item.textContent.trim() === '项目根')
      if (root) root.click()
    })()`)
    await evaluate(`(() => {
      const label = document.querySelector('.tree-row .tree-label')
      if (label) label.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    })()`)
    const selectionReady = await waitFor(`document.querySelectorAll('.tree-row.selected').length > 0`, 3000)
    const visual = await evaluate(`(() => {
      const row = document.querySelector('.tree-row.selected')
      const glyph = document.querySelector('.tree-label .glyph')
      const chevron = document.querySelector('.twisty.expanded .chevron')
      return {
        fontFamily: getComputedStyle(document.body).fontFamily,
        selectedBackground: row === null ? null : getComputedStyle(row).backgroundColor,
        glyphTag: glyph === null ? null : glyph.tagName.toLowerCase(),
        chevronTransform: chevron === null ? null : getComputedStyle(chevron).transform
      }
    })()`)
    record(
      'Apple 风格字体栈生效',
      typeof visual.fontFamily === 'string' && visual.fontFamily.includes('-apple-system'),
      String(visual.fontFamily).slice(0, 48)
    )
    record(
      '选中行使用系统蓝低透明度填充',
      selectionReady === true &&
        typeof visual.selectedBackground === 'string' &&
        visual.selectedBackground.includes('0, 122, 255'),
      `选中态=${String(selectionReady)} 背景=${String(visual.selectedBackground)}`
    )
    record('目录图标为内联 SVG', visual.glyphTag === 'svg', `glyph=${String(visual.glyphTag)}`)
    record(
      '箭头旋转由 CSS 变换实现',
      typeof visual.chevronTransform === 'string' && visual.chevronTransform !== 'none',
      String(visual.chevronTransform)
    )

    // 再次点击同一行应收起
    await evaluate(`(() => {
      const label = document.querySelector('.tree-row .tree-label')
      if (label) label.click()
    })()`)
    await sleep(500)
    const afterToggle = await evaluate(`document.querySelectorAll('.tree-row').length`)
    record('再次点击同一文件夹收起', afterToggle === beforeExpand, `${afterExpand} 行 → ${afterToggle} 行`)

    // 箭头仍可独立控制展开
    await evaluate(`(() => {
      const twisty = document.querySelector('.tree-row .twisty:not(.placeholder)')
      if (twisty) twisty.click()
    })()`)
    await sleep(600)
    const afterTwisty = await evaluate(`document.querySelectorAll('.tree-row').length`)
    record('箭头仍可独立控制展开', afterTwisty > beforeExpand, `${beforeExpand} 行 → ${afterTwisty} 行`)

    const collapseAllWorks = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.browser-actions button')].find((item) => item.textContent.includes('收起全部'))
      if (!button) return false
      button.click()
      return true
    })()`)
    await sleep(300)
    const afterCollapseAll = await evaluate(`document.querySelectorAll('.tree-row').length`)
    const rootRowCount = await evaluate(
      `([...document.querySelectorAll('.tree-row')].filter((row) => row.style.paddingLeft === '4px').length)`
    )
    record(
      '收起全部可恢复为根层视图',
      collapseAllWorks === true && afterCollapseAll === rootRowCount,
      `收起后 ${afterCollapseAll} 行（根层 ${rootRowCount} 行）`
    )

    // 拖拽分栏分隔线调整文件树宽度
    const splitDrag = await evaluate(`(() => {
      const handle = document.querySelector('.split-resize')
      const tree = document.querySelector('.file-tree')
      if (!handle || !tree) return null
      const before = Math.round(tree.getBoundingClientRect().width)
      const rect = handle.getBoundingClientRect()
      const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1 }
      handle.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { clientX: rect.left + 3, clientY: rect.top + 40 })))
      handle.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, base, { clientX: rect.left + 73, clientY: rect.top + 40 })))
      handle.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { clientX: rect.left + 73, clientY: rect.top + 40 })))
      return { before }
    })()`)
    await sleep(300)
    const treeWidthAfter = await evaluate(
      `Math.round(document.querySelector('.file-tree').getBoundingClientRect().width)`
    )
    record(
      '拖拽分隔线可调整文件树宽度',
      splitDrag !== null && treeWidthAfter === splitDrag.before + 70,
      `${String(splitDrag?.before)}px → ${treeWidthAfter}px（位移 70px）`
    )

    const previewStillVisible = await evaluate(`(() => {
      const preview = document.querySelector('.preview-pane')
      return preview !== null && Math.round(preview.getBoundingClientRect().width) > 200
    })()`)
    record('分栏调整后预览区仍可用', previewStillVisible === true, '预览区宽度 > 200px')

    /* ---------- 受控文件监听与预览重载（M2-3 / M2-4） ---------- */

    // 外部新建文件 → 文件树刷新
    fs.writeFileSync(path.join(projectDir, '外部新增.txt'), 'external\n')
    await sleep(2200)
    const afterExternalCreate = await evaluate(`(() => ({
      hasNewFile: [...document.querySelectorAll('.tree-row')].some((row) =>
        (row.getAttribute('title') || '').startsWith('外部新增.txt')),
      rows: document.querySelectorAll('.tree-row').length
    }))()`)
    record(
      '外部新建文件后文件树自动刷新',
      afterExternalCreate.hasNewFile === true,
      `行数=${afterExternalCreate.rows} 命中=${String(afterExternalCreate.hasNewFile)}`
    )

    // 选中长文件并滚动，再在外部改写 → 预览重载且保留滚动位置
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.tree-row')]
        .find((item) => (item.getAttribute('title') || '').startsWith('long.txt'))
      const label = row?.querySelector('.tree-label')
      if (label) label.click()
    })()`)
    await waitFor(`document.querySelectorAll('.text-block').length > 0`, 8000)
    const scrolled = await evaluate(`(() => {
      const body = document.querySelector('.preview-body')
      if (!body) return -1
      body.scrollTop = 420
      return body.scrollTop
    })()`)
    record('预览可滚动', typeof scrolled === 'number' && scrolled > 0, `scrollTop=${String(scrolled)}`)

    fs.writeFileSync(
      path.join(projectDir, 'long.txt'),
      `${Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行内容`).join('\n')}\n外部追加标记行\n`
    )
    await sleep(2400)
    const afterExternalEdit = await evaluate(`(() => {
      const body = document.querySelector('.preview-body')
      const text = document.querySelector('.text-block')?.textContent ?? ''
      return {
        scrollTop: body === null ? -1 : Math.round(body.scrollTop),
        reloaded: text.includes('外部追加标记行')
      }
    })()`)
    record(
      '外部保存后预览自动重载',
      afterExternalEdit.reloaded === true,
      `含新内容=${String(afterExternalEdit.reloaded)}`
    )
    record(
      '重载后保留滚动位置',
      Math.abs(afterExternalEdit.scrollTop - 420) <= 4,
      `重载前 420 → 重载后 ${String(afterExternalEdit.scrollTop)}`
    )

    // 外部删除文件 → 保留提示页并提供返回目录
    fs.rmSync(path.join(projectDir, 'long.txt'))
    await sleep(2400)
    const afterDelete = await evaluate(`(() => {
      const empty = document.querySelector('.preview-empty')
      return {
        text: empty?.textContent ?? null,
        hasBack: [...document.querySelectorAll('.preview-empty button')]
          .some((button) => button.textContent.includes('返回目录')),
        stillListed: [...document.querySelectorAll('.tree-row')].some((row) =>
          (row.getAttribute('title') || '').startsWith('long.txt'))
      }
    })()`)
    record(
      '文件被删除后保留提示页',
      typeof afterDelete.text === 'string' && afterDelete.text.includes('已不在磁盘上'),
      String(afterDelete.text).slice(0, 40)
    )
    record('删除后提供返回目录入口', afterDelete.hasBack === true, `按钮存在=${String(afterDelete.hasBack)}`)
    record('删除后文件树移除该条目', afterDelete.stillListed === false, `仍在列表=${String(afterDelete.stillListed)}`)

    /* ---------- 变更页与只读差异（M2-1 / M2-2） ---------- */

    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.segmented button')].find((item) => item.textContent.includes('变更'))
      if (button) button.click()
    })()`)
    const changesLoaded = await waitFor(`document.querySelectorAll('.change-group').length > 0`, 12000)
    record('变更页显示变更分组', changesLoaded === true, changesLoaded ? '已加载' : '超时')

    const groupInfo = await evaluate(`(() => {
      const groups = [...document.querySelectorAll('.change-group')]
      return {
        labels: groups.map((group) => group.querySelector('strong')?.textContent ?? ''),
        files: document.querySelectorAll('.change-file').length,
        summary: document.querySelector('.changes-summary')?.textContent ?? ''
      }
    })()`)
    record(
      '分组包含未暂存、已暂存与未跟踪',
      ['未暂存', '已暂存', '未跟踪'].every((label) => groupInfo.labels.includes(label)),
      `分组=${groupInfo.labels.join(' / ')}`
    )
    record(
      '顶部显示分支与变更文件数',
      groupInfo.summary.includes('分支') && groupInfo.summary.includes('变更文件'),
      groupInfo.summary.trim().slice(0, 60)
    )

    // 点击未暂存文件 → 读取差异
    await evaluate(`(() => {
      const group = [...document.querySelectorAll('.change-group')]
        .find((item) => item.querySelector('strong')?.textContent === '未暂存')
      const file = group?.querySelector('.change-file')
      if (file) file.click()
    })()`)
    const diffLoaded = await waitFor(`document.querySelectorAll('.diff-line').length > 0`, 12000)
    const diffInfo = await evaluate(`(() => ({
      adds: document.querySelectorAll('.diff-line.add').length,
      removes: document.querySelectorAll('.diff-line.remove').length,
      hunks: document.querySelectorAll('.diff-hunk').length,
      chips: [...document.querySelectorAll('.diff-pane .chip')].map((chip) => chip.textContent),
      newLineNumbers: [...document.querySelectorAll('.diff-line.add .diff-gutter:nth-child(2)')]
        .map((cell) => cell.textContent).slice(0, 4),
      stat: document.querySelector('.diff-stat')?.textContent ?? null
    }))()`)
    record(
      '差异视图渲染增删行与 hunk',
      diffLoaded === true && diffInfo.adds > 0 && diffInfo.removes > 0 && diffInfo.hunks > 0,
      `+${diffInfo.adds} -${diffInfo.removes} hunk=${diffInfo.hunks}`
    )
    record(
      '差异视图标注比较对象',
      diffInfo.chips.some((chip) => chip.includes('工作区')),
      diffInfo.chips.join(' / ')
    )
    record(
      '新增行带新文件行号',
      diffInfo.newLineNumbers.length > 0 && diffInfo.newLineNumbers.every((value) => value.length > 0),
      `新行号=${diffInfo.newLineNumbers.join(',')}`
    )
    record(
      '差异视图显示增删统计',
      typeof diffInfo.stat === 'string' && diffInfo.stat.includes('+') && diffInfo.stat.includes('−'),
      String(diffInfo.stat)
    )

    // 未跟踪分组：第一个是二进制图片，逐个验证两条路径
    const clickUntracked = async (fileName) =>
      evaluate(`(() => {
        const group = [...document.querySelectorAll('.change-group')]
          .find((item) => item.querySelector('strong')?.textContent === '未跟踪')
        if (!group) return false
        const file = [...group.querySelectorAll('.change-file')]
          .find((item) => (item.querySelector('.change-file-name')?.textContent ?? '') === ${JSON.stringify(fileName)})
        if (!file) return false
        file.click()
        return true
      })()`)

    const binaryClicked = await clickUntracked('logo.png')
    await sleep(900)
    const binaryDiff = await evaluate(`(() => ({
      body: document.querySelector('.diff-pane .preview-empty')?.textContent ?? null,
      chips: [...document.querySelectorAll('.diff-pane .chip')].map((chip) => chip.textContent)
    }))()`)
    record(
      '二进制文件不提供逐行差异',
      binaryClicked === true && typeof binaryDiff.body === 'string' && binaryDiff.body.includes('二进制'),
      String(binaryDiff.body).slice(0, 40)
    )

    const textClicked = await clickUntracked('notes.txt')
    await sleep(900)
    const untrackedDiff = await evaluate(`(() => ({
      note: document.querySelector('.diff-note')?.textContent ?? null,
      chips: [...document.querySelectorAll('.diff-pane .chip')].map((chip) => chip.textContent),
      lines: document.querySelectorAll('.diff-line').length
    }))()`)
    record(
      '未跟踪文件标注没有 Git 基线',
      textClicked === true &&
        typeof untrackedDiff.note === 'string' &&
        untrackedDiff.note.includes('没有 Git 历史基线'),
      String(untrackedDiff.note).slice(0, 48)
    )
    record(
      '未跟踪文件按当前内容呈现',
      untrackedDiff.chips.some((chip) => chip.includes('无 Git 基线')) && untrackedDiff.lines > 0,
      `${untrackedDiff.chips.join(' / ')} 行数=${untrackedDiff.lines}`
    )

    /* ---------- M3-3 重新定位与信任重确认 ---------- */

    // 回到项目库（重新定位入口在项目卡片上）
    await evaluate(`(() => {
      const back = document.querySelector('.project-header .back')
      if (back) back.click()
    })()`)
    await waitFor(`document.querySelectorAll('.project-card').length > 0`)

    const relocateButtonPresent = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.project-card')]
        .find((item) => item.textContent.includes('第二项目'))
      if (!card) return null
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.includes('重新定位'))
      return button === undefined ? null : { text: button.textContent.trim(), disabled: button.disabled }
    })()`)
    record(
      '项目卡片提供重新定位入口',
      relocateButtonPresent !== null && relocateButtonPresent.disabled === false,
      relocateButtonPresent === null ? '未找到按钮' : `文案=${relocateButtonPresent.text}`
    )

    // 先给「第二项目」授予信任，才能验证「目录变化即撤销信任」而不是「本来就没信任」
    const secondProjectId = await evaluate(`(async () => {
      const list = await window.workbench.project.list()
      const target = list.find((item) => item.displayName === '第二项目')
      if (!target) return null
      await window.workbench.project.update({ projectId: target.id, trusted: true })
      return target.id
    })()`)
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.library-actions button')].find((item) => item.textContent.trim() === '刷新')
      if (button) button.click()
    })()`)
    const trustedBefore = await waitFor(
      `([...document.querySelectorAll('.project-card')]
      .some((card) => card.textContent.includes('第二项目') && card.textContent.includes('已信任')))`,
      5000
    )
    record(
      '重新定位前该项目处于已信任状态',
      secondProjectId !== null && trustedBefore === true,
      `id=${String(secondProjectId)} 已信任=${String(trustedBefore)}`
    )

    // 主进程的目录选择框用替身接管，避免原生对话框阻塞无人值守验证
    const originalShowOpenDialog = electronModule.dialog.showOpenDialog
    electronModule.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [relocatedDir] })
    try {
      await evaluate(`(() => {
        const card = [...document.querySelectorAll('.project-card')]
          .find((item) => item.textContent.includes('第二项目'))
        const button = card === null ? null : [...card.querySelectorAll('button')].find((item) => item.textContent.includes('重新定位'))
        if (button) button.click()
      })()`)
      const relocated = await waitFor(
        `([...document.querySelectorAll('.project-card')]
          .some((card) => card.querySelector('.card-path')?.textContent.includes('second-project-moved')))`,
        8000
      )
      const relocatedCard = await evaluate(`(() => {
        const card = [...document.querySelectorAll('.project-card')]
          .find((item) => item.textContent.includes('第二项目'))
        if (!card) return null
        return {
          path: card.querySelector('.card-path')?.textContent ?? '',
          badges: [...card.querySelectorAll('.chip')].map((chip) => chip.textContent),
          notice: document.querySelector('.inline-notice')?.textContent ?? null
        }
      })()`)
      record(
        '重新定位后卡片指向新目录',
        relocated === true && String(relocatedCard?.path).includes('second-project-moved'),
        String(relocatedCard?.path)
      )
      record(
        '重新定位后撤销信任并说明原因',
        Array.isArray(relocatedCard?.badges) &&
          relocatedCard.badges.includes('只读浏览') &&
          String(relocatedCard?.notice).includes('重新确认'),
        `徽章=${(relocatedCard?.badges ?? []).join(' / ')} 提示=${String(relocatedCard?.notice).slice(0, 40)}`
      )
      // a11y：提示条改为「可聚焦关闭按钮」，键盘用户可定位并激活它
      const noticeDismissible = await (async () => {
        const focusable = await evaluate(`(() => {
          const notice = document.querySelector('.inline-notice.banner-dismissible')
          const button = notice === null ? null : notice.querySelector('.banner-dismiss')
          if (!(button instanceof HTMLElement)) return false
          button.focus()
          return document.activeElement === button
        })()`)
        if (focusable !== true) return false
        await evaluate(`document.querySelector('.inline-notice.banner-dismissible .banner-dismiss')?.click()`)
        const remaining = await evaluate(`document.querySelectorAll('.inline-notice.banner-dismissible').length`)
        return remaining === 0
      })()
      record(
        '提示条可键盘关闭（关闭按钮可聚焦并生效）',
        noticeDismissible === true,
        `可聚焦并关闭 → ${String(noticeDismissible)}`
      )
      record(
        '重新定位不移动磁盘内容',
        fs.existsSync(path.join(secondDir, 'README.md')) && fs.existsSync(path.join(relocatedDir, 'README.md')),
        '原目录与新目录的文件都仍在'
      )
    } finally {
      electronModule.dialog.showOpenDialog = originalShowOpenDialog
    }

    /* ---------- M3-4 退出前活动会话提示 ---------- */

    const liveSessions = await evaluate(`(() => {
      const badges = [...document.querySelectorAll('.terminal-title .badge')].map((item) => item.textContent)
      return badges.join(' / ')
    })()`)
    record('退出前仍有终端会话在运行', String(liveSessions).includes('会话运行中'), String(liveSessions))

    // 触发真实退出：主进程应阻止并询问，而不是静默结束会话
    electronModule.app.quit()
    const quitPromptShown = await waitFor(`document.querySelectorAll('.modal-backdrop').length > 0`, 5000)
    const quitModal = await evaluate(`(() => {
      const modal = document.querySelector('.modal-backdrop .modal')
      return {
        text: modal?.textContent ?? '',
        actions: [...document.querySelectorAll('.modal-backdrop .modal button')].map((item) => item.textContent.trim())
      }
    })()`)
    record(
      '退出前弹出活动会话确认',
      quitPromptShown === true && String(quitModal.text).includes('终端会话'),
      String(quitModal.text).slice(0, 48)
    )
    record(
      '确认框提供取消与退出两个选项',
      Array.isArray(quitModal.actions) &&
        quitModal.actions.some((item) => item.includes('取消')) &&
        quitModal.actions.some((item) => item.includes('退出')),
      (quitModal.actions ?? []).join(' / ')
    )

    // a11y：useModalFocus 打开时把焦点移入框内（只读断言，不发起按键以免扰动退出序列）
    const quitFocusInDialog = await waitFor(
      `(() => { const m = document.querySelector('.modal-backdrop .modal'); return !!m && m.contains(document.activeElement) })()`,
      3000
    )
    record('退出确认框打开即聚焦框内', quitFocusInDialog === true, `焦点在框内=${String(quitFocusInDialog)}`)

    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.modal-backdrop .modal button')]
        .find((item) => item.textContent.trim() === '取消')
      if (button) button.click()
    })()`)
    await sleep(500)
    const afterCancelQuit = await evaluate(`(() => ({
      modals: document.querySelectorAll('.modal-backdrop').length,
      stillMounted: document.querySelectorAll('.app').length
    }))()`)
    record(
      '取消退出后应用继续运行',
      afterCancelQuit.modals === 0 && afterCancelQuit.stillMounted === 1,
      `弹层=${afterCancelQuit.modals} 应用挂载=${afterCancelQuit.stillMounted}`
    )
    const sessionsAfterCancel = await evaluate(`(() => {
      const badges = [...document.querySelectorAll('.terminal-title .badge')].map((item) => item.textContent)
      return badges.join(' / ')
    })()`)
    record('取消退出不结束终端会话', String(sessionsAfterCancel).includes('会话运行中'), String(sessionsAfterCancel))

    /* ---------- C09 场景 10：开启开关并记下上次项目 ---------- */

    const enableClicked = await evaluate(`(() => {
      const settings = document.querySelector('.sidebar-settings')
      if (settings) settings.click()
      return settings !== null
    })()`)
    const settingsForToggle = await waitFor(`document.querySelectorAll('.settings-page').length > 0`)
    const toggledOn = await evaluate(`(() => {
      const input = document.querySelector('.settings-page .pref-toggle input[type="checkbox"]')
      if (!input) return 'missing'
      if (!input.checked) input.click()
      return 'on'
    })()`)
    await sleep(500)
    const afterEnable = readSettings()
    record(
      '勾选开关后写入应用数据目录',
      enableClicked === true &&
        settingsForToggle === true &&
        toggledOn === 'on' &&
        afterEnable !== null &&
        afterEnable.restoreLastProject === true,
      `入口=${String(enableClicked)} 设置页=${String(settingsForToggle)} 界面=${String(toggledOn)} settings.json=${JSON.stringify(afterEnable)}`
    )

    // 从设置页回到项目库，再打开「第二项目」——启动偏好是应用属性，不该影响打开流程
    const backToLibraryForOpen = await evaluate(`(() => {
      const library = document.querySelector('.sidebar-library')
      if (library) library.click()
      return library !== null
    })()`)
    const cardsBack = await waitFor(`document.querySelectorAll('.project-card').length > 0`)
    const openedSecond = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.project-card')]
        .find((item) => item.textContent.includes('第二项目'))
      const button = card === undefined ? null : [...card.querySelectorAll('button')]
        .find((item) => item.textContent.trim() === '打开')
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`)
    const onSecondProject = await waitFor(
      `(() => {
        const slot = document.querySelector('.project-slot:not(.hidden)')
        return slot?.querySelector('h1')?.textContent === '第二项目'
      })()`
    )
    const afterOpen = readSettings()
    record(
      '打开项目即记为上次项目',
      backToLibraryForOpen === true &&
        cardsBack === true &&
        openedSecond === true &&
        onSecondProject === true &&
        String(afterOpen?.lastProjectId).length > 0,
      `回项目库=${String(backToLibraryForOpen)} 点击=${String(openedSecond)} 已进入=${String(onSecondProject)} lastProjectId=${String(afterOpen?.lastProjectId)}`
    )
    record(
      '偏好只写在应用数据目录，不落入用户项目',
      !fs.existsSync(path.join(projectDir, 'settings.json')) &&
        !fs.existsSync(path.join(relocatedDir, 'settings.json')),
      '两个项目目录内都没有 settings.json'
    )

    report()
  }

  function report() {
    console.log(`=== M1 端到端冒烟验证（阶段：${phase}）===`)
    console.log(`Electron ${process.versions.electron}　Node ${process.versions.node}`)
    console.log(`产物：out/main/index.js + out/renderer/index.html\n`)

    let passed = 0
    for (const item of results) {
      if (item.pass) passed += 1
      console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
    }
    console.log(`\n合计：${passed}/${results.length} 项通过`)

    removeTree(fixtureRoot)

    app.exit(passed === results.length ? 0 : 1)
  }

  app
    .whenReady()
    .then(main)
    .catch((error) => {
      console.error('冒烟验证异常：', error)
      app.exit(1)
    })
}

/* ==================== 父进程 ==================== */

/** 阶段顺序即验收场景 10 的时间顺序；后一阶段依赖前一阶段留在应用数据目录里的偏好。 */
const PHASES = [
  { name: 'main', timeout: 120000 },
  { name: 'restore', timeout: 90000 },
  { name: 'restore-off', timeout: 90000 }
]

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  runChild()
} else {
  assertArtifactsFresh()

  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  let passed = 0
  let total = 0
  const perPhase = []

  for (const item of PHASES) {
    const result = spawnSync(ELECTRON_BIN, [__filename], {
      cwd: ROOT,
      env: { ...env, WORKBENCH_SMOKE_PHASE: item.name },
      encoding: 'utf8',
      timeout: item.timeout,
      windowsHide: true
    })

    process.stdout.write(result.stdout || '')
    if (result.stderr) process.stderr.write(result.stderr)

    const matched = /合计：(\d+)\/(\d+) 项通过/.exec(result.stdout || '')
    if (matched === null) {
      // 子进程没跑到汇总行（异常退出或超时），计数不可信，直接终止
      console.error(`阶段 ${item.name} 未产出汇总（退出码 ${String(result.status)}），已中止。`)
      process.exit(1)
    }

    passed += Number(matched[1])
    total += Number(matched[2])
    perPhase.push(`${item.name} ${matched[1]}/${matched[2]}`)

    if (Number(matched[1]) !== Number(matched[2])) break
  }

  console.log(`\n端到端合计：${passed}/${total} 项通过（${perPhase.join(' · ')}）`)
  process.exit(passed === total && perPhase.length === PHASES.length ? 0 : 1)
}
