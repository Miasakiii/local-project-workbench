/**
 * 终端信任门验证：主进程侧的纵深防御。
 *
 * 背景：终端具备当前用户的系统权限，可以读写项目之外的任何位置。界面上的三个创建入口
 * （头部主按钮、Ctrl+`、文件栏右键「在此目录新建终端」）都各自拦过一次「未信任不创建」，
 * 但 2026-09-21 的代码审查中发现 `terminal:create` 主进程并不复核信任——一旦将来新增
 * 入口漏检，或调用方绕过界面直接走 IPC，就会开出特权会话。本轮把信任判定补在主进程
 * （`PtySessionManager.create` 的第一道门，与目录复核并列，值来自登记表）。
 *
 * 本套件纯 Node 运行（node-pty 不依赖 Electron ABI，M0-1 已验证），断言：
 *   - 未信任一律拒绝，且**不创建任何进程**（判定在 spawn 之前）
 *   - 信任值不信任界面类型：非布尔、undefined 都按未信任处理
 *   - 判定顺序：未信任时先报信任，连目录复核都不必走到
 *   - 信任通过后原有复核全部照旧：空目录／不存在／不是文件夹仍然拒绝
 *   - 信任通过后主路径不被破坏：真建会话、可写、可 dispose、幂等 dispose
 *   - IPC 侧读的是登记表的 trusted（该层由 smoke:m1 端到端验证）
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-terminal-trust.mts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtySessionManager } from '../src/main/modules/pty-session.ts'
import type { TerminalCreateRequest } from '../src/shared/ipc.ts'

const keepFixture = process.argv.includes('--keep')
const root = join(tmpdir(), 'workbench-terminal-trust')
const goodCwd = join(root, 'cwd')
const fileTarget = join(goodCwd, 'marker.txt')
const subCwd = join(goodCwd, 'sub')
const missingCwd = join(root, 'no-such-dir')

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

/** 纯 Node 替身：只满足 create 用到的两个方法 */
function fakeSender(): Parameters<PtySessionManager['create']>[0] {
  return {
    isDestroyed: () => false,
    send: () => {}
  } as unknown as Parameters<PtySessionManager['create']>[0]
}

function request(overrides: Partial<TerminalCreateRequest> = {}): TerminalCreateRequest {
  return { projectId: 'p1', relativePath: '', cols: 80, rows: 24, ...overrides }
}

/** 捕获一次 create 的抛错；不抛则返回 null（cwd 即主进程解析后的启动目录） */
function captureError(manager: PtySessionManager, trusted: boolean, cwd: string, req = request()): string | null {
  try {
    manager.create(fakeSender(), req, cwd, trusted)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * 删除样例目录，带重试。
 *
 * Windows 上刚 kill 掉的 shell 进程可能仍把启动目录当作当前工作目录而短暂占用，
 * 直接 rmSync 会以 EPERM 失败；这不是被测逻辑的问题，重试即可。
 */
function removeFixture(): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
    }
  }
}

async function main(): void {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 上一轮可能留下被 ConPTY 占用的目录（见 removeFixture 说明）；幂等 mkdir 复用即可
  }
  mkdirSync(subCwd, { recursive: true })
  writeFileSync(fileTarget, 'x')

  const manager = new PtySessionManager()

  /* ---------- 未信任：一律拒绝，且不创建进程 ---------- */

  const untrusted = captureError(manager, false, goodCwd)
  check('未信任项目的终端创建被拒绝', untrusted?.includes('信任'), String(untrusted))
  check('拒绝时没有创建任何会话', manager.activeCount === 0, `活动会话=${manager.activeCount}`)

  // 界面可能传任何形态；主进程只认真实布尔 true
  for (const value of [undefined, null, 'yes', 0, 1]) {
    const message = captureError(manager, value as unknown as boolean, goodCwd)
    check(`信任值 ${JSON.stringify(value) ?? String(value)} 按未信任处理`, message?.includes('信任'), String(message))
  }
  check('非布尔信任值同样没有创建会话', manager.activeCount === 0, `活动会话=${manager.activeCount}`)

  /* ---------- 判定顺序：未信任时先报信任，不必走到目录复核 ---------- */

  const untrustedMissing = captureError(manager, false, missingCwd)
  check(
    '未信任且目录不存在时仍先报信任',
    untrustedMissing?.includes('信任') && !untrustedMissing.includes('启动目录'),
    String(untrustedMissing)
  )
  const untrustedEmpty = captureError(manager, false, '')
  check(
    '未信任且目录为空串时仍先报信任',
    untrustedEmpty?.includes('信任') && !untrustedEmpty.includes('启动目录'),
    String(untrustedEmpty)
  )

  /* ---------- 信任通过后，原有复核全部照旧 ---------- */

  const emptyCwd = captureError(manager, true, '')
  check('信任通过后仍拒绝空启动目录', emptyCwd?.includes('启动目录不能为空'), String(emptyCwd))
  const missing = captureError(manager, true, missingCwd)
  check('信任通过后仍复核目录存在性', missing?.includes('启动目录不存在'), String(missing))
  const notDirectory = captureError(manager, true, fileTarget)
  check('信任通过后仍复核目标是否为文件夹', notDirectory?.includes('启动目录不是文件夹'), String(notDirectory))
  check('上述失败路径都没有留下会话', manager.activeCount === 0, `活动会话=${manager.activeCount}`)

  /* ---------- 信任通过后主路径不被破坏：真建会话 ---------- */

  const created = manager.create(fakeSender(), request(), goodCwd, true)
  check(
    '信任通过后可以创建会话',
    typeof created.sessionId === 'string' && created.sessionId.length > 0 && typeof created.shell === 'string',
    `shell=${created.shell}`
  )
  check('会话记入活动列表', manager.activeCount === 1, `活动会话=${manager.activeCount}`)
  check('启动目录落在传入值上', created.cwd === goodCwd, created.cwd)

  const nested = manager.create(fakeSender(), request({ relativePath: 'sub' }), subCwd, true)
  check('子目录可作为启动目录', nested.cwd === subCwd, nested.cwd)

  manager.write({ sessionId: created.sessionId, data: '' })
  check('会话可写入（不抛错）', true, '空写入即视为可寻址')

  manager.dispose(created.sessionId)
  manager.dispose(nested.sessionId)
  check('dispose 后活动会话归零', manager.activeCount === 0, `活动会话=${manager.activeCount}`)

  manager.dispose(created.sessionId)
  check('重复 dispose 不抛错', manager.activeCount === 0, `活动会话=${manager.activeCount}`)

  /* ---------- 输出 ---------- */

  console.log('=== 终端信任门验证：主进程纵深防御 ===')
  console.log(`样例目录：${root}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${checks.length} 项通过`)

  const ok = passed === checks.length
  if (keepFixture) {
    console.log(`\n样例目录已保留：${root}`)
  } else {
    const cleaned = await removeFixture()
    console.log(cleaned ? `样例目录已清理：${root}` : `样例目录有残留（ConPTY 短暂持有，下一轮复用）：${root}`)
  }

  process.exit(ok ? 0 : 1)
}

await main()
