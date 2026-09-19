/**
 * M0-5 技术验证（二）：真实系统回收站。
 *
 * 与 verify-file-ops-m0.mts 的分工：
 *   - 前者在纯 Node 下用注入的回收站能力验证**处理逻辑**（中止、逐项报告、分类）。
 *   - 本脚本在真实 Electron 运行时下用 `shell.trashItem` 验证**真实回收站行为**，
 *     包括被独占句柄锁定的文件是否被正确拒绝并保留源文件。
 *
 * 用法：
 *   node scripts/verify-trash-real-m0.cjs      # 父进程模式（推荐）
 *   electron scripts/verify-trash-real-m0.cjs  # 子进程模式
 *
 * 脚本自带父/子进程模式：部分执行环境会注入 ELECTRON_RUN_AS_NODE=1，
 * 使 Electron 以纯 Node 启动（`require('electron')` 只返回二进制路径）。
 * 父进程模式会显式清除该变量后再派生 Electron。
 *
 * 脚本不创建窗口，仅使用主进程能力；结束后不残留样例目录。
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const fixtureRoot = path.join(os.tmpdir(), 'workbench-m0-5-real')
const projectDir = path.join(fixtureRoot, 'project')
const outsideDir = path.join(fixtureRoot, 'outside')

/* ==================== 子进程：真实 Electron 内执行 ==================== */

function runChild() {
  const electronModule = require('electron')
  if (typeof electronModule === 'string') {
    process.stderr.write('当前进程以 ELECTRON_RUN_AS_NODE 模式启动，无法使用 shell.trashItem。\n')
    process.exit(2)
  }

  const { app, shell } = electronModule
  const { spawn } = require('node:child_process')

  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('no-sandbox')

  const checks = []
  const check = (name, pass, detail) => checks.push({ name, pass, detail })

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** 用 esbuild 把主进程模块打成可 require 的 CommonJS，避免额外构建步骤。 */
  function buildBundle() {
    const esbuild = require('esbuild')
    const outFile = path.join(os.tmpdir(), `workbench-m0-5-bundle-${process.pid}.cjs`)
    esbuild.buildSync({
      entryPoints: [path.join(ROOT, 'src', 'main', 'modules', 'file-access.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      outfile: outFile,
      tsconfig: path.join(ROOT, 'tsconfig.node.json'),
      logLevel: 'silent'
    })
    return outFile
  }

  /**
   * 清理样例目录。
   * 目录联接必须先单独解除：Windows 上递归删除不会移除重解析点，
   * 残留的联接会导致下一次创建时 EEXIST。
   */
  function removeFixture() {
    try {
      fs.unlinkSync(path.join(projectDir, 'junction'))
    } catch {
      // 不存在或已被解除
    }
    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    } catch {
      // 忽略：可能有文件仍被占用
    }
  }

  function buildFixture() {
    removeFixture()
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'folder'), { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'file.txt'), 'content')
    fs.writeFileSync(path.join(projectDir, 'folder', 'inner.txt'), 'inner')
    fs.writeFileSync(path.join(projectDir, 'locked.txt'), 'locked')
    fs.writeFileSync(path.join(projectDir, '.git', 'config'), '[core]')
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret')
    fs.symlinkSync(outsideDir, path.join(projectDir, 'junction'), 'junction')
  }

  /** 用 PowerShell 以「不共享」方式打开文件，构造真实的 Windows 文件占用。 */
  function startExclusiveLock(filePath) {
    const script = [
      '$fs=[System.IO.File]::Open($env:WB_LOCK_PATH,[System.IO.FileMode]::Open,',
      '[System.IO.FileAccess]::Read,[System.IO.FileShare]::None);',
      'Start-Sleep -Seconds 40;',
      '$fs.Close()'
    ].join('')
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, WB_LOCK_PATH: filePath },
      stdio: 'ignore',
      windowsHide: true
    })
  }

  async function main() {
    const trash = (absolutePath) => shell.trashItem(absolutePath)

    buildFixture()
    const bundlePath = buildBundle()
    const fileAccess = require(bundlePath)

    console.log('=== M0-5 技术验证（二）：真实系统回收站 ===')
    console.log(`Electron ${process.versions.electron}　Node ${process.versions.node}`)
    console.log(`样例目录：${fixtureRoot}\n`)

    /* ---------- 1. 回收站可用性探测 ---------- */
    const probe = await fileAccess.probeTrashAvailability(trash)
    check('系统回收站可用性探测', probe.available === true, probe.message)

    /* ---------- 2. 文件与目录真实送入回收站 ---------- */
    const fileResult = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['file.txt'],
      trusted: true,
      trash
    })
    check(
      '文件送入回收站',
      fileResult.ok === 1 && !fs.existsSync(path.join(projectDir, 'file.txt')),
      `ok=${fileResult.ok} failed=${fileResult.failed}`
    )

    const dirResult = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['folder'],
      trusted: true,
      trash
    })
    check(
      '文件夹送入回收站',
      dirResult.ok === 1 && !fs.existsSync(path.join(projectDir, 'folder')),
      `ok=${dirResult.ok} failed=${dirResult.failed}`
    )

    /* ---------- 3. 被独占句柄占用的文件 ---------- */
    const lockedPath = path.join(projectDir, 'locked.txt')
    const lockProcess = startExclusiveLock(lockedPath)
    await wait(2500)

    const lockedResult = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['locked.txt'],
      trusted: true,
      trash
    })
    const lockedItem = lockedResult.items[0]
    check(
      '被占用文件被拒绝且源文件保留',
      lockedItem.status === 'failed' && fs.existsSync(lockedPath),
      `status=${lockedItem.status} reason=${String(lockedItem.reason)}`
    )
    check('占用类失败不导致整批中止', lockedResult.aborted === false, `aborted=${lockedResult.aborted}`)

    try {
      lockProcess.kill()
    } catch {
      // 进程可能已自行结束
    }

    /* ---------- 4. 受保护项与项目外目标 ---------- */
    const protectedResult = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['', '.git', '.git/config'],
      trusted: true,
      trash
    })
    check(
      '项目根与 .git 不提供删除',
      protectedResult.items.every((item) => item.status === 'skipped' && item.reason === 'protected-entry'),
      protectedResult.items.map((item) => `${item.relativePath || '(根)'}:${item.status}`).join(', ')
    )

    const escapeResult = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['junction/secret.txt'],
      trusted: true,
      trash
    })
    check(
      '经目录联接指向项目外被拒绝',
      escapeResult.items[0].reason === 'outside-project' && fs.existsSync(path.join(outsideDir, 'secret.txt')),
      `reason=${String(escapeResult.items[0].reason)}`
    )

    /* ---------- 5. 不可信项目 ---------- */
    fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'keep')
    const untrusted = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['keep.txt'],
      trusted: false,
      trash
    })
    check(
      '不可信项目拒绝写操作',
      untrusted.aborted === true && fs.existsSync(path.join(projectDir, 'keep.txt')),
      `abortReason=${String(untrusted.abortReason)}`
    )

    /* ---------- 输出 ---------- */
    let passed = 0
    for (const item of checks) {
      if (item.pass) passed += 1
      console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
    }
    console.log(`\n合计：${passed}/${checks.length} 项通过`)

    removeFixture()
    try {
      fs.rmSync(bundlePath, { force: true })
    } catch {
      // 忽略
    }

    app.exit(passed === checks.length ? 0 : 1)
  }

  app
    .whenReady()
    .then(main)
    .catch((error) => {
      console.error('验证异常：', error)
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
    timeout: 180000,
    windowsHide: true
  })
  process.stdout.write(result.stdout || '')
  if (result.stderr) process.stderr.write(result.stderr)
  process.exit(result.status === null ? 1 : result.status)
}
