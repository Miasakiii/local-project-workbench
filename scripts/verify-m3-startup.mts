/**
 * C09 / 验收场景 10 验证：应用级偏好与「恢复上次项目」。
 *
 * 覆盖：
 *   - 默认关闭：没有 settings.json 时启动停留项目库，且不会因为「读不到」而猜开
 *   - 持久化：开关与上次项目跨「重启」（新 store 实例读同一文件）保持
 *   - 读入容错：垃圾值、损坏文件、未知字段一律回退到安全的默认值
 *   - 恢复判定：开启/关闭、首次启动、上次项目可用、已移除登记、目录不可用五分支
 *   - 与登记表集成：真实目录移动、移除登记、重新定位后的可用性判定
 *   - 边界：恢复不看信任；关闭时不做任何目录查询；偏好只落应用数据目录
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-m3-startup.mts
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore, createStartupLookup, decideStartupView } from '../src/main/modules/app-settings.ts'
import { createRegistry, createRegistryStore } from '../src/main/modules/project-registry.ts'
import type { SettingsResult } from '../src/shared/ipc.ts'

const keepFixture = process.argv.includes('--keep')
const root = join(tmpdir(), 'workbench-m3-startup-fixture')
const appDataDir = join(root, 'app-data')
const settingsPath = join(appDataDir, 'settings.json')
const registryPath = join(appDataDir, 'projects.json')
const projectA = join(root, 'project-a')
const projectB = join(root, 'project-b')
const projectC = join(root, 'project-c')

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
  for (const dir of [appDataDir, projectA, projectB, projectC]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(projectA, 'README.md'), '# 甲项目\n')
  writeFileSync(join(projectB, 'README.md'), '# 乙项目\n')
  writeFileSync(join(projectC, 'README.md'), '# 丙项目\n')
}

/** 模拟一次新的应用启动：丢弃内存缓存，重新从磁盘读。 */
function freshSettings() {
  return createSettingsStore(settingsPath)
}

function readSettingsFile(): SettingsResult | null {
  if (!existsSync(settingsPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const data = (parsed as { data?: unknown }).data
    if (data === null || typeof data !== 'object') return null
    return data as SettingsResult
  } catch {
    return null
  }
}

/** 走一遍主进程的判定路径：偏好 + 登记表 → 启动位置。 */
function startupViewFor(settings: SettingsResult, registry: ReturnType<typeof createRegistry>) {
  return decideStartupView(settings, createStartupLookup(registry))
}

function main(): void {
  buildFixture()

  /* ---------- 默认值与持久化 ---------- */

  {
    const store = freshSettings()
    const initial = store.get()
    check(
      '没有 settings.json 时开关为关闭',
      initial.restoreLastProject === false && initial.lastProjectId === null,
      JSON.stringify(initial)
    )
    check('只读取不会创建 settings.json', !existsSync(settingsPath), `存在=${String(existsSync(settingsPath))}`)

    const view = startupViewFor(initial, createRegistry(createRegistryStore(registryPath)))
    check('默认启动停留项目库且不解释', view.projectId === null && view.notice === null, JSON.stringify(view))
  }

  {
    const store = freshSettings()
    store.setRestoreLastProject(true)
    check('开启开关后写入磁盘', readSettingsFile()?.restoreLastProject === true, JSON.stringify(readSettingsFile()))

    const reopened = freshSettings().get()
    check('重启后开关仍为开启', reopened.restoreLastProject === true, JSON.stringify(reopened))

    store.setRestoreLastProject(false)
    check('关闭开关后重启仍为关闭', freshSettings().get().restoreLastProject === false, '回到默认行为')
  }

  {
    const store = freshSettings()
    store.setRestoreLastProject(true)
    store.recordActiveProject('project-x')
    const first = store.get()
    check('记录上次项目', first.lastProjectId === 'project-x', JSON.stringify(first))

    store.recordActiveProject('project-y')
    check(
      '后打开的项目覆盖上次项目',
      freshSettings().get().lastProjectId === 'project-y',
      JSON.stringify(freshSettings().get())
    )

    const before = store.get()
    store.recordActiveProject('')
    store.recordActiveProject(undefined as unknown as string)
    check(
      '空值不会清除上次项目',
      freshSettings().get().lastProjectId === before.lastProjectId,
      JSON.stringify(freshSettings().get())
    )

    check(
      '记录上次项目不改动开关',
      freshSettings().get().restoreLastProject === true,
      JSON.stringify(freshSettings().get())
    )
  }

  /* ---------- 读入容错：坏数据一律回退到不恢复 ---------- */

  {
    writeFileSync(
      settingsPath,
      JSON.stringify({ version: 1, data: { restoreLastProject: 'yes', lastProjectId: 42 } }),
      'utf8'
    )
    const loaded = freshSettings().get()
    check(
      '非布尔开关值按关闭处理',
      loaded.restoreLastProject === false && loaded.lastProjectId === null,
      JSON.stringify(loaded)
    )

    writeFileSync(settingsPath, '{ 这不是 JSON', 'utf8')
    const afterCorrupt = freshSettings().get()
    const quarantined = readdirSync(appDataDir).filter((name) => name.includes('settings.json.corrupt-'))
    check(
      'settings.json 损坏时回退为不恢复',
      afterCorrupt.restoreLastProject === false && afterCorrupt.lastProjectId === null,
      JSON.stringify(afterCorrupt)
    )
    check('损坏文件被保留而非静默丢弃', quarantined.length === 1, quarantined.join(', '))

    writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 1,
        data: { restoreLastProject: true, lastProjectId: '', unknownField: { nested: true } }
      }),
      'utf8'
    )
    const sanitized = freshSettings().get()
    check(
      '空串上次项目按「从未打开」处理，未知字段被丢弃',
      sanitized.lastProjectId === null && !('unknownField' in sanitized),
      JSON.stringify(sanitized)
    )

    rmSync(settingsPath, { force: true })
  }

  /* ---------- 恢复判定的五个分支 ---------- */

  {
    const settings: SettingsResult = { restoreLastProject: false, lastProjectId: 'p1' }
    let lookedUp: string[] = []
    const view = decideStartupView(settings, (projectId) => {
      lookedUp.push(projectId)
      return { status: 'available' }
    })
    check('开关关闭时即使有上次项目也不恢复', view.projectId === null && view.notice === null, JSON.stringify(view))
    check('开关关闭时不查询任何目录', lookedUp.length === 0, `查询次数=${lookedUp.length}`)
    lookedUp = []

    const firstRun = decideStartupView({ restoreLastProject: true, lastProjectId: null }, (projectId) => {
      lookedUp.push(projectId)
      return { status: 'available' }
    })
    check(
      '首次启动（从未打开过项目）停留项目库且不解释',
      firstRun.projectId === null && firstRun.notice === null && lookedUp.length === 0,
      JSON.stringify(firstRun)
    )

    const restored = decideStartupView({ restoreLastProject: true, lastProjectId: 'p1' }, (projectId) => {
      lookedUp.push(projectId)
      return { status: 'available' }
    })
    check(
      '开启且上次项目可用时直接恢复',
      restored.projectId === 'p1' && restored.notice === null,
      JSON.stringify(restored)
    )
    check(
      '判定只查询上次项目本身，不遍历或扫描目录',
      lookedUp.length === 1 && lookedUp[0] === 'p1',
      `查询=${lookedUp.join(',')}`
    )

    const unregistered = decideStartupView({ restoreLastProject: true, lastProjectId: 'p1' }, () => ({
      status: 'unregistered'
    }))
    check(
      '上次项目已移除登记时说明原因',
      unregistered.projectId === null && String(unregistered.notice).includes('不在登记列表'),
      String(unregistered.notice)
    )

    const unavailable = decideStartupView({ restoreLastProject: true, lastProjectId: 'p1' }, () => ({
      status: 'unavailable',
      displayName: '甲项目',
      reason: '目录不存在或不可访问'
    }))
    check(
      '上次项目目录不可用时说明项目与原因',
      unavailable.projectId === null &&
        String(unavailable.notice).includes('甲项目') &&
        String(unavailable.notice).includes('目录不存在或不可访问'),
      String(unavailable.notice)
    )
  }

  /* ---------- 与登记表的集成：真实目录、真实记录 ---------- */

  {
    const registry = createRegistry(createRegistryStore(registryPath))
    const a = registry.register(projectA)
    const b = registry.register(projectB)
    const aId = a.project?.id ?? ''
    const bId = b.project?.id ?? ''
    check('样例项目登记成功', a.status === 'added' && b.status === 'added', `${a.status}/${b.status}`)

    const store = freshSettings()
    store.setRestoreLastProject(true)
    registry.update(aId, { trusted: true })
    store.recordActiveProject(aId)

    const trustedRestored = startupViewFor(store.get(), registry)
    check(
      '已信任项目可恢复',
      trustedRestored.projectId === aId && trustedRestored.notice === null,
      JSON.stringify(trustedRestored)
    )

    // 未信任项目同样恢复：恢复的是浏览位置，写权限与终端另说
    store.recordActiveProject(bId)
    const untrustedRestored = startupViewFor(store.get(), registry)
    const bProject = registry.get(bId)
    check(
      '恢复不看信任：未信任项目也直接打开（仍为只读浏览）',
      untrustedRestored.projectId === bId && bProject?.trusted === false,
      `恢复=${String(untrustedRestored.projectId)} trusted=${String(bProject?.trusted)}`
    )
  }

  {
    const registry = createRegistry(createRegistryStore(registryPath))
    const c = registry.register(projectC)
    const cId = c.project?.id ?? ''
    const store = freshSettings()
    store.setRestoreLastProject(true)
    store.recordActiveProject(cId)

    check(
      '移除登记不会改动上次项目',
      registry.remove(cId) && freshSettings().get().lastProjectId === cId,
      JSON.stringify(freshSettings().get())
    )
    const removedView = startupViewFor(store.get(), registry)
    check(
      '移除登记后重启停留项目库并说明',
      removedView.projectId === null && String(removedView.notice).includes('不在登记列表'),
      String(removedView.notice)
    )
  }

  {
    const registry = createRegistry(createRegistryStore(registryPath))
    const goneDir = join(root, 'will-move')
    mkdirSync(goneDir, { recursive: true })
    writeFileSync(join(goneDir, 'README.md'), '# 会搬走的项目\n')
    const gone = registry.register(goneDir)
    const goneId = gone.project?.id ?? ''

    const store = freshSettings()
    store.setRestoreLastProject(true)
    store.recordActiveProject(goneId)
    registry.update(goneId, { trusted: true })

    renameSync(goneDir, join(root, 'moved-here'))
    const movedView = startupViewFor(store.get(), registry)
    check(
      '目录被移走后停留项目库并说明原因',
      movedView.projectId === null && String(movedView.notice).includes('will-move'),
      String(movedView.notice)
    )
    check(
      '目录不可用时不因恢复而重建目录',
      !existsSync(goneDir) && existsSync(join(root, 'moved-here', 'README.md')),
      '原位置仍不存在，新位置内容完好'
    )

    // 重新定位后位置更新，恢复应指向新目录；身份变化会撤销信任，但恢复本身不受影响
    const relocated = registry.relocate(goneId, join(root, 'moved-here'))
    const relocatedView = startupViewFor(store.get(), registry)
    check(
      '重新定位后可以恢复',
      relocated.status === 'relocated' && relocatedView.projectId === goneId && relocatedView.notice === null,
      `status=${relocated.status} 恢复=${String(relocatedView.projectId)}`
    )
    check(
      '重新定位撤销信任后仍只恢复浏览位置（不附带写权限）',
      registry.get(goneId)?.trusted === false && relocated.trustReset === true,
      `trusted=${String(registry.get(goneId)?.trusted)} trustReset=${String(relocated.trustReset)}`
    )
  }

  /* ---------- 边界：偏好只写应用数据目录 ---------- */

  {
    const listing = (dir: string): string[] => readdirSync(dir).sort().join(',')
    const beforeA = listing(projectA)
    const beforeB = listing(projectB)
    const store = freshSettings()
    store.setRestoreLastProject(true)
    store.recordActiveProject('anything')
    store.setRestoreLastProject(false)
    check(
      '开关闭过程序没有向任何用户项目写入文件',
      listing(projectA) === beforeA && listing(projectB) === beforeB,
      `${beforeA} | ${beforeB}`
    )
    check('settings.json 位于应用数据目录', existsSync(settingsPath), settingsPath)
  }

  /* ---------- 输出 ---------- */

  console.log('=== C09 验证：应用级偏好与「恢复上次项目」 ===')
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
