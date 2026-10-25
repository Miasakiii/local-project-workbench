/**
 * P5 验收：真实 ACL 拒绝删除。
 *
 * 与 verify-trash-real-m0.cjs 的分工：
 *   - 前者验证真实回收站对占用、受保护项与项目外边界的处理；
 *   - 本脚本用 icacls 给当前用户写入 DENY(DELETE)，验证生产删除路径在真实
 *     权限拒绝下逐项失败并保留源文件，而不是伪装成成功或降级为永久删除。
 *
 * 用法：
 *   node scripts/verify-acl-real.cjs      # 父进程模式（推荐）
 *   electron scripts/verify-acl-real.cjs  # 子进程模式
 *
 * 仅 Windows 可运行（依赖 icacls）。脚本只操作系统临时目录下的独立样例，
 * 结束时恢复 ACL 并清理，不接触用户项目或真实用户数据。
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const ROOT = path.join(__dirname, '..')
const ELECTRON_BIN = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const fixtureRoot = path.join(os.tmpdir(), 'workbench-p5-acl')
const projectDir = path.join(fixtureRoot, 'project')

/* ==================== 子进程：真实 Electron 内执行 ==================== */

function runChild() {
  const electronModule = require('electron')
  if (typeof electronModule === 'string') {
    process.stderr.write('当前进程以 ELECTRON_RUN_AS_NODE 模式启动，无法使用 shell.trashItem。\n')
    process.exit(2)
  }

  const { app, shell } = electronModule
  const { execFileSync } = require('node:child_process')

  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('no-sandbox')

  const checks = []
  const check = (name, pass, detail) => checks.push({ name, pass, detail })

  function buildBundle() {
    const esbuild = require('esbuild')
    const outFile = path.join(os.tmpdir(), `workbench-p5-acl-bundle-${process.pid}.cjs`)
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

  function buildFixture() {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, 'acl.txt'), 'acl target')
    fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'keep target')
  }

  function currentSid() {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
      ],
      { encoding: 'utf8' }
    ).trim()
  }

  function applyDenyDelete(filePath, sid) {
    execFileSync('icacls', [filePath, '/deny', `*${sid}:(D)`], { stdio: 'pipe' })
  }

  function removeDeny(filePath, sid) {
    try {
      execFileSync('icacls', [filePath, '/remove:d', `*${sid}`], { stdio: 'pipe' })
    } catch {
      // 清理阶段尽力而为；真实失败由「恢复后可删除」断言暴露
    }
  }

  async function main() {
    const sid = currentSid()
    const aclPath = path.join(projectDir, 'acl.txt')
    buildFixture()
    applyDenyDelete(aclPath, sid)

    const bundlePath = buildBundle()
    const fileAccess = require(bundlePath)
    let trashCalls = 0
    const trash = (absolutePath) => {
      trashCalls += 1
      return shell.trashItem(absolutePath)
    }

    console.log('=== P5 验证：真实 ACL 拒绝删除 ===')
    console.log(`Electron ${process.versions.electron}　Node ${process.versions.node}`)
    console.log(`样例目录：${fixtureRoot}`)
    console.log(`拒绝主体：*${sid}:(D)\n`)

    const denied = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['acl.txt'],
      trusted: true,
      trash
    })
    const deniedItem = denied.items[0]
    check(
      '真实 ACL 拒绝删除并报告无权限',
      deniedItem.status === 'failed' &&
        deniedItem.reason === 'permission-denied' &&
        /没有权限/.test(String(deniedItem.message)) &&
        fs.existsSync(aclPath),
      `status=${deniedItem.status} reason=${String(deniedItem.reason)} message=${String(deniedItem.message)}`
    )
    check(
      '拒绝不会被计为成功、不存在或静默跳过',
      denied.ok === 0 &&
        denied.failed === 1 &&
        denied.aborted === false &&
        deniedItem.reason !== 'not-found' &&
        fs.existsSync(aclPath),
      `ok=${denied.ok} failed=${denied.failed} aborted=${denied.aborted}`
    )
    check('无权限项不会进入回收站调用', trashCalls === 0, `trashCalls=${trashCalls}`)

    removeDeny(aclPath, sid)
    const restored = await fileAccess.deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['acl.txt'],
      trusted: true,
      trash
    })
    check(
      '恢复 ACL 后同一文件可正常送入回收站',
      restored.ok === 1 && !fs.existsSync(aclPath),
      `ok=${restored.ok} failed=${restored.failed} exists=${fs.existsSync(aclPath)}`
    )

    let passed = 0
    for (const item of checks) {
      if (item.pass) passed += 1
      console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
    }
    console.log(`\n合计：${passed}/${checks.length} 项通过`)

    try {
      fs.rmSync(fixtureRoot, { recursive: true, force: true })
    } catch {
      // 清理失败不冒充验证失败
    }
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

if (process.platform !== 'win32') {
  console.error('真实 ACL 删除验证仅支持 Windows。')
  process.exit(1)
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  runChild()
} else {
  const { spawn } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(ELECTRON_BIN, [__filename], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))

  const watchdog = setTimeout(() => {
    process.stderr.write('真实 ACL 验证超过 120 秒，已终止。\n')
    child.kill()
    process.exit(1)
  }, 120000)

  child.on('error', (error) => {
    clearTimeout(watchdog)
    process.stderr.write(`无法启动 Electron：${error.message}\n`)
    process.exit(1)
  })

  child.on('exit', (code) => {
    clearTimeout(watchdog)
    process.exit(code === null ? 1 : code)
  })
}
