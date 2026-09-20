/**
 * M3-3 / M3-4 验证：重新定位与信任重确认、退出前活动会话提示。
 *
 * 覆盖推进计划 M3-3、M3-4 的退出条件：
 *   - 重新定位到新目录后，登记指向新位置，且**信任被撤销**（目录身份变了）
 *   - 目标目录已被其它项目登记、目录不存在、目标与当前相同，各自有明确结果
 *   - 重新定位不移动、不复制、不删除任何磁盘内容
 *   - 退出时若无活动会话直接放行；有会话则先询问，取消不产生副作用
 *   - 没有界面可问、渲染进程崩溃时不得让应用卡在无法关闭的状态
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-m3-lifecycle.mts
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry, createRegistryStore } from '../src/main/modules/project-registry.ts'
import { createQuitCoordinator, type QuitCoordinatorDeps } from '../src/main/modules/quit-coordinator.ts'

const keepFixture = process.argv.includes('--keep')
const root = join(tmpdir(), 'workbench-m3-lifecycle-fixture')
const appDataDir = join(root, 'app-data')
const originalDir = join(root, 'original-project')
const movedDir = join(root, 'moved-project')
const otherDir = join(root, 'other-project')
const storePath = join(appDataDir, 'projects.json')

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

function buildFixture(): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(originalDir, 'src'), { recursive: true })
  mkdirSync(join(movedDir, 'src'), { recursive: true })
  mkdirSync(otherDir, { recursive: true })
  mkdirSync(appDataDir, { recursive: true })
  writeFileSync(join(originalDir, 'README.md'), '# 原目录\n')
  writeFileSync(join(movedDir, 'README.md'), '# 新目录\n')
  writeFileSync(join(movedDir, 'src', 'index.ts'), 'export const moved = true\n')
}

/** 构造一个可控的退出协调器替身，记录所有外部动作。 */
function makeQuitHarness(options: { sessionCount: number; canPrompt: boolean }) {
  const events: string[] = []
  let sessionCount = options.sessionCount
  let canPrompt = options.canPrompt
  let promptCount = 0
  let disposeCount = 0
  let quitCount = 0

  const deps: QuitCoordinatorDeps = {
    activeSessionCount: () => sessionCount,
    canPrompt: () => canPrompt,
    prompt: (count) => {
      promptCount += 1
      events.push(`prompt:${count}`)
    },
    disposeServices: () => {
      disposeCount += 1
      events.push('dispose')
    },
    quit: () => {
      quitCount += 1
      events.push('quit')
    }
  }

  return {
    coordinator: createQuitCoordinator(deps),
    events,
    promptCount: () => promptCount,
    disposeCount: () => disposeCount,
    quitCount: () => quitCount,
    setSessionCount: (value: number) => {
      sessionCount = value
    },
    setCanPrompt: (value: boolean) => {
      canPrompt = value
    }
  }
}

function main(): void {
  buildFixture()

  const registry = createRegistry(createRegistryStore(storePath))
  const original = registry.register(originalDir)
  const other = registry.register(otherDir)
  const originalId = original.project?.id ?? ''
  const otherId = other.project?.id ?? ''

  /* ---------- M3-3 重新定位 ---------- */

  check('登记原目录', original.status === 'added', `status=${original.status}`)

  // 信任原目录，用于验证「身份变化即撤销信任」
  registry.update(originalId, { trusted: true })
  check(
    '原目录已设为信任',
    registry.get(originalId)?.trusted === true,
    `trusted=${String(registry.get(originalId)?.trusted)}`
  )

  // 1. 目标目录已被其它项目登记
  {
    const outcome = registry.relocate(originalId, otherDir)
    check(
      '目标目录已被其它项目登记时拒绝',
      outcome.status === 'duplicate' && outcome.project?.id === originalId,
      `status=${outcome.status} message=${outcome.message}`
    )
    check(
      '拒绝后原登记未被改动',
      registry.get(originalId)?.normalizedIdentity === original.project?.normalizedIdentity,
      '身份未变'
    )
  }

  // 2. 目标目录不存在
  {
    const outcome = registry.relocate(originalId, join(root, 'does-not-exist'))
    check(
      '目标目录不存在时拒绝',
      outcome.status === 'unavailable',
      `status=${outcome.status} message=${outcome.message}`
    )
  }

  // 3. 目标与当前相同
  {
    const outcome = registry.relocate(originalId, originalDir)
    check('目标与当前位置相同时判为未改动', outcome.status === 'unchanged', `status=${outcome.status}`)
    check(
      '未改动时不重置信任',
      outcome.trustReset === false && registry.get(originalId)?.trusted === true,
      'trusted 仍为 true'
    )
  }

  // 4. 未登记的项目
  {
    const outcome = registry.relocate('not-a-real-id', movedDir)
    check('未登记的项目无法重新定位', outcome.status === 'not-found', `status=${outcome.status}`)
  }

  // 5. 正常重新定位：身份更新 + 信任撤销
  {
    const before = registry.get(originalId)
    const outcome = registry.relocate(originalId, movedDir)
    const after = registry.get(originalId)

    check('重新定位成功', outcome.status === 'relocated' && outcome.project !== null, `status=${outcome.status}`)
    check(
      '登记指向新目录的真实路径身份',
      after !== null && after.normalizedIdentity !== before?.normalizedIdentity,
      `${String(before?.normalizedIdentity)} → ${String(after?.normalizedIdentity)}`
    )
    check('原始路径同步更新', after?.originalPath === movedDir, String(after?.originalPath))
    check('项目 ID 保持不变', after?.id === originalId, String(after?.id))
    check(
      '目录身份变化后撤销信任',
      outcome.trustReset === true && after?.trusted === false,
      `trustReset=${String(outcome.trustReset)} trusted=${String(after?.trusted)}`
    )
    check('提示中说明需要重新确认', outcome.message.includes('重新确认'), outcome.message)
    check(
      '重新定位不移动磁盘内容',
      existsSync(join(originalDir, 'README.md')) && existsSync(join(movedDir, 'README.md')),
      '原目录与新目录的文件都仍在'
    )
    check(
      '其它项目的登记未受影响',
      registry.get(otherId)?.normalizedIdentity === other.project?.normalizedIdentity,
      '其它项目身份未变'
    )

    // 落盘后再读取，确认是持久化结果而不是内存假象
    const reloaded = createRegistry(createRegistryStore(storePath)).get(originalId)
    check(
      '重新定位结果已持久化',
      reloaded?.normalizedIdentity === after?.normalizedIdentity && reloaded?.trusted === false,
      `identity=${String(reloaded?.normalizedIdentity)} trusted=${String(reloaded?.trusted)}`
    )
  }

  // 6. 重新定位后原目录可被再次登记（去重按真实身份，而不是按记录）
  {
    const again = registry.register(originalDir)
    check('旧目录可被重新登记为独立项目', again.status === 'added', `status=${again.status}`)
    check('两条记录指向不同目录', registry.list().length === 3, `记录数=${registry.list().length}`)
  }

  /* ---------- M3-4 退出前活动会话提示 ---------- */

  // 1. 没有活动会话：直接放行
  {
    const harness = makeQuitHarness({ sessionCount: 0, canPrompt: true })
    const blocked = harness.coordinator.requestQuit()
    check('无活动会话时退出不被阻止', blocked === false, `blocked=${String(blocked)}`)
    check('无活动会话时不发询问', harness.promptCount() === 0, `prompt=${harness.promptCount()}`)
  }

  // 2. 有活动会话：阻止退出并询问
  {
    const harness = makeQuitHarness({ sessionCount: 2, canPrompt: true })
    const blocked = harness.coordinator.requestQuit()
    check('有活动会话时阻止退出', blocked === true, `blocked=${String(blocked)}`)
    check('询问携带会话数量', harness.events.includes('prompt:2'), harness.events.join(' / '))
    check('询问阶段不清理会话', harness.disposeCount() === 0 && harness.quitCount() === 0, '未 dispose、未 quit')
  }

  // 3. 重复触发只问一次（窗口 close 与 before-quit 会各触发一次）
  {
    const harness = makeQuitHarness({ sessionCount: 1, canPrompt: true })
    harness.coordinator.requestQuit()
    harness.coordinator.requestQuit()
    harness.coordinator.requestQuit()
    check('重复触发只发一次询问', harness.promptCount() === 1, `prompt=${harness.promptCount()}`)
  }

  // 4. 用户取消：应用继续运行，会话不受影响
  {
    const harness = makeQuitHarness({ sessionCount: 3, canPrompt: true })
    harness.coordinator.requestQuit()
    harness.coordinator.resolve(false)
    check('取消退出后不清理会话', harness.disposeCount() === 0 && harness.quitCount() === 0, '未 dispose、未 quit')
    check(
      '取消退出后状态复位',
      harness.coordinator.pending === false && harness.coordinator.confirmed === false,
      'pending=false confirmed=false'
    )

    // 取消后再次请求退出应当重新询问
    const blockedAgain = harness.coordinator.requestQuit()
    check(
      '取消后可再次发起退出询问',
      blockedAgain === true && harness.promptCount() === 2,
      `prompt=${harness.promptCount()}`
    )
  }

  // 5. 用户确认：结束会话并退出
  {
    const harness = makeQuitHarness({ sessionCount: 2, canPrompt: true })
    harness.coordinator.requestQuit()
    harness.coordinator.resolve(true)
    check('确认退出后清理会话', harness.disposeCount() === 1, `dispose=${harness.disposeCount()}`)
    check('确认退出后调用退出', harness.quitCount() === 1, `quit=${harness.quitCount()}`)
    check(
      '确认后不再询问',
      harness.coordinator.requestQuit() === false && harness.promptCount() === 1,
      `prompt=${harness.promptCount()}`
    )
  }

  // 6. 没有界面可问：不阻塞退出
  {
    const harness = makeQuitHarness({ sessionCount: 5, canPrompt: false })
    const blocked = harness.coordinator.requestQuit()
    check('无界面可询问时不阻止退出', blocked === false, `blocked=${String(blocked)}`)
    check('无界面时也不发询问', harness.promptCount() === 0, `prompt=${harness.promptCount()}`)
  }

  // 7. 询问发出后渲染进程消失：不卡死
  {
    const harness = makeQuitHarness({ sessionCount: 1, canPrompt: true })
    harness.coordinator.requestQuit()
    harness.coordinator.abandonPrompt()
    check(
      '渲染进程消失后结束并退出',
      harness.quitCount() === 1 && harness.disposeCount() === 1,
      `quit=${harness.quitCount()}`
    )
    check(
      '渲染进程消失后状态复位',
      harness.coordinator.pending === false && harness.coordinator.confirmed === true,
      'pending=false confirmed=true'
    )
  }

  // 8. 会话在询问期间自行结束：放行退出时不重复清理
  {
    const harness = makeQuitHarness({ sessionCount: 1, canPrompt: true })
    harness.coordinator.requestQuit()
    harness.setSessionCount(0)
    harness.coordinator.resolve(true)
    check(
      '会话已自行结束时确认退出仍然安全',
      harness.quitCount() === 1 && harness.disposeCount() === 1,
      `quit=${harness.quitCount()} dispose=${harness.disposeCount()}`
    )
  }

  /* ---------- 输出 ---------- */

  console.log('=== M3-3 / M3-4 验证：重新定位与信任重确认、退出前会话提示 ===')
  console.log(`样例目录：${root}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${checks.length} 项通过`)

  if (keepFixture) console.log(`\n样例目录已保留：${root}`)
  else rmSync(root, { recursive: true, force: true })

  process.exit(passed === checks.length ? 0 : 1)
}

main()
