/**
 * M1 端到端冒烟验证：在真实 Electron 运行时下加载构建产物，
 * 通过渲染进程实际调用 IPC，确认界面契约与安全基线成立。
 *
 * 覆盖：
 *   1. 主进程启动无异常，窗口加载构建后的渲染层
 *   2. 预加载层白名单成立：存在 workbench API，且不存在 require／process／ipcRenderer
 *   3. 项目列表、文件列表、Markdown 预览、Git 快照、终端创建经 IPC 端到端可用
 *   4. 页面导航被阻止（外链不改变当前地址）
 *
 * 用法：
 *   node scripts/smoke-m1.cjs          # 父进程模式（推荐，会清理 ELECTRON_RUN_AS_NODE）
 *   electron scripts/smoke-m1.cjs      # 直接运行子进程模式
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

  const fixtureRoot = path.join(os.tmpdir(), 'workbench-smoke-m1')
  const projectDir = path.join(fixtureRoot, 'project')
  const secondDir = path.join(fixtureRoot, 'second-project')

  function buildFixture() {
    removeTree(fixtureRoot)
    fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
    fs.mkdirSync(secondDir, { recursive: true })
    fs.writeFileSync(
      path.join(projectDir, 'README.md'),
      '# 冒烟项目\n\n用于端到端验证的项目简介段落。\n\n![图](assets/logo.png)\n\n<script>alert(1)</script>\n'
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
      Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行内容`).join('\n') + '\n'
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

    const loaded = await waitForLoad(window, 15000)
    record('渲染层加载完成', loaded, loaded ? 'did-finish-load' : '超时')

    // 等待预加载层注入
    await new Promise((resolve) => setTimeout(resolve, 600))

    const surface = await window.webContents.executeJavaScript(`(() => ({
      hasWorkbench: typeof window.workbench === 'object' && window.workbench !== null,
      projectList: typeof window.workbench?.project?.list,
      filePreview: typeof window.workbench?.file?.preview,
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
        surface.terminalCreate === 'function' &&
        surface.systemOpenExternal === 'function',
      `project.list=${surface.projectList} file.preview=${surface.filePreview}`
    )
    record(
      '渲染进程无 Node 能力泄漏',
      surface.leakedRequire === 'undefined' &&
        surface.leakedProcess === 'undefined' &&
        surface.leakedIpc === 'undefined',
      `require=${surface.leakedRequire} process=${surface.leakedProcess} ipcRenderer=${surface.leakedIpc}`
    )
    record('界面已挂载', surface.domReady > 0, `.app 节点数=${surface.domReady}`)

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
    record(
      '项目外路径经 IPC 被拒绝',
      escapeAttempt?.kind === 'error',
      String(escapeAttempt?.message)
    )

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
      sidebarProjects.count === 2 && sidebarProjects.names.includes('冒烟项目') && sidebarProjects.names.includes('第二项目'),
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
    record(
      '两个标签各自保持独立会话',
      twoTabs.liveDots === 2,
      `运行中的标签=${twoTabs.liveDots}`
    )
    record(
      '同一时刻只显示一个终端视图',
      twoTabs.visibleHosts === 1,
      `可见终端=${twoTabs.visibleHosts}`
    )
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
    record(
      '关闭当前项目后自动切到其余已打开项目',
      afterClose.title === '冒烟项目',
      `当前=${String(afterClose.title)}`
    )

    // 文件树：目录可展开（页面切换改为头部分段控件）
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('.segmented button')].find((item) => item.textContent.includes('文件'))
      if (button) button.click()
    })()`)
    await waitFor(`document.querySelectorAll('.tree-row').length > 0`)

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

    // 视觉基线：样式表未生效或类名漂移时这几项会失败
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
      typeof visual.selectedBackground === 'string' && visual.selectedBackground.includes('0, 122, 255'),
      String(visual.selectedBackground)
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
    record(
      '再次点击同一文件夹收起',
      afterToggle === beforeExpand,
      `${afterExpand} 行 → ${afterToggle} 行`
    )

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
    record(
      '收起全部可恢复为根层视图',
      collapseAllWorks === true && afterCollapseAll === beforeExpand,
      `收起后 ${afterCollapseAll} 行（根层 ${beforeExpand} 行）`
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
      Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行内容`).join('\n') +
        '\n外部追加标记行\n'
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
    record(
      '删除后提供返回目录入口',
      afterDelete.hasBack === true,
      `按钮存在=${String(afterDelete.hasBack)}`
    )
    record(
      '删除后文件树移除该条目',
      afterDelete.stillListed === false,
      `仍在列表=${String(afterDelete.stillListed)}`
    )

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
      textClicked === true && typeof untrackedDiff.note === 'string' && untrackedDiff.note.includes('没有 Git 历史基线'),
      String(untrackedDiff.note).slice(0, 48)
    )
    record(
      '未跟踪文件按当前内容呈现',
      untrackedDiff.chips.some((chip) => chip.includes('无 Git 基线')) && untrackedDiff.lines > 0,
      `${untrackedDiff.chips.join(' / ')} 行数=${untrackedDiff.lines}`
    )

    report()
  }

  function report() {
    console.log('=== M1 端到端冒烟验证 ===')
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

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  runChild()
} else {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const result = spawnSync(ELECTRON_BIN, [__filename], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true
  })
  process.stdout.write(result.stdout || '')
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.status === null ? 1 : result.status)
}
