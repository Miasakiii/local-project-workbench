import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  createSettingsStore,
  createStartupLookup,
  decideStartupView,
  sanitizeDefaultShell,
  type StartupProjectState
} from '../../src/main/modules/app-settings'
import { DEFAULT_TERMINAL_PREFERENCES } from '../../src/shared/terminal-settings'
import type { SettingsResult } from '../../src/shared/ipc'

const baseSettings: SettingsResult = {
  restoreLastProject: false,
  lastProjectId: null,
  editorPath: null,
  terminal: { ...DEFAULT_TERMINAL_PREFERENCES }
}

function withSettingsFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'settings.json')
}

test('默认 Shell 白名单只接受 pwsh / powershell / cmd', () => {
  assert.equal(sanitizeDefaultShell('pwsh'), 'pwsh')
  assert.equal(sanitizeDefaultShell('powershell'), 'powershell')
  assert.equal(sanitizeDefaultShell('cmd'), 'cmd')
  for (const value of ['', 'bash', 'PWSH', 'C:\\Windows\\System32\\cmd.exe', null, 1]) {
    assert.equal(sanitizeDefaultShell(value), '')
  }
})

test('启动开关关闭时停留项目库且不解释', () => {
  const view = decideStartupView({ ...baseSettings, lastProjectId: 'p1' }, () => ({ status: 'available' }))
  assert.deepEqual(view, { projectId: null, notice: null })
})

test('从未打开过项目时停留项目库', () => {
  const view = decideStartupView({ ...baseSettings, restoreLastProject: true }, () => ({ status: 'available' }))
  assert.deepEqual(view, { projectId: null, notice: null })
})

test('上次项目可用时直接恢复', () => {
  const view = decideStartupView({ ...baseSettings, restoreLastProject: true, lastProjectId: 'p1' }, () => ({
    status: 'available'
  }))
  assert.deepEqual(view, { projectId: 'p1', notice: null })
})

test('登记已移除与目录不可用分别说明原因', () => {
  const unregistered = decideStartupView({ ...baseSettings, restoreLastProject: true, lastProjectId: 'p1' }, () => ({
    status: 'unregistered'
  }))
  assert.equal(unregistered.projectId, null)
  assert.match(unregistered.notice ?? '', /不在登记列表/)

  const unavailable = decideStartupView(
    { ...baseSettings, restoreLastProject: true, lastProjectId: 'p1' },
    (): StartupProjectState => ({ status: 'unavailable', displayName: '演示项目', reason: '目录不存在' })
  )
  assert.equal(unavailable.projectId, null)
  assert.match(unavailable.notice ?? '', /演示项目/)
  assert.match(unavailable.notice ?? '', /目录不存在/)
})

test('启动查询区分未登记、不可用与可用', () => {
  const lookup = createStartupLookup({
    get: (projectId) => (projectId === 'known' ? { displayName: 'Known' } : null),
    resolveRoot: (projectId) => (projectId === 'known' ? { ok: true } : { ok: false, reason: '目录不存在' })
  })

  assert.deepEqual(lookup('known'), { status: 'available' })
  assert.deepEqual(lookup('missing'), { status: 'unregistered' })
  assert.deepEqual(lookup('gone'), { status: 'unregistered' })
})

test('设置持久化写入校验后的终端偏好，未给出的字段保持原值', (t) => {
  const file = withSettingsFile(t)
  const store = createSettingsStore(file)
  assert.deepEqual(store.get(), baseSettings)

  store.update({ restoreLastProject: true, terminal: { defaultShell: 'cmd', fontSize: 17 } })
  store.recordActiveProject('p1')
  store.setEditorPath('C:\\Apps\\Code.exe')

  const reloaded = createSettingsStore(file).get()
  assert.equal(reloaded.restoreLastProject, true)
  assert.equal(reloaded.lastProjectId, 'p1')
  assert.equal(reloaded.editorPath, 'C:\\Apps\\Code.exe')
  assert.equal(reloaded.terminal.defaultShell, 'cmd')
  assert.equal(reloaded.terminal.fontSize, 17)
  assert.equal(reloaded.terminal.lineHeight, DEFAULT_TERMINAL_PREFERENCES.lineHeight)

  // 非法字段只回落到该字段的默认值，不连带重置其它合法偏好。
  store.update({ terminal: { defaultShell: 'bash' } })
  assert.equal(store.get().terminal.defaultShell, '')
  assert.equal(store.get().terminal.fontSize, 17)

  // 越界值在落盘前被夹回区间。
  store.update({ terminal: { fontSize: 999, scrollback: 5 } })
  assert.equal(store.get().terminal.fontSize, 24)
  assert.equal(store.get().terminal.scrollback, 1000)

  store.setEditorPath('')
  assert.equal(store.get().editorPath, null)
})

test('旧版扁平 defaultShell 在升级时迁移到终端偏好', (t) => {
  const file = withSettingsFile(t)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      data: { restoreLastProject: true, lastProjectId: 'p1', editorPath: null, defaultShell: 'pwsh' }
    }),
    'utf8'
  )

  const migrated = createSettingsStore(file).get()
  assert.equal(migrated.restoreLastProject, true)
  assert.equal(migrated.terminal.defaultShell, 'pwsh')
  assert.equal(migrated.terminal.fontSize, DEFAULT_TERMINAL_PREFERENCES.fontSize)
  assert.equal(migrated.terminal.startupDirectory, DEFAULT_TERMINAL_PREFERENCES.startupDirectory)
})

test('已有 terminal 对象时忽略旧字段，损坏字段逐项回落', (t) => {
  const file = withSettingsFile(t)
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      data: {
        restoreLastProject: false,
        lastProjectId: null,
        editorPath: null,
        defaultShell: 'cmd',
        terminal: { fontSize: 'bad', cursorStyle: 'beam' }
      }
    }),
    'utf8'
  )

  const settings = createSettingsStore(file).get()
  assert.equal(settings.terminal.defaultShell, '')
  assert.equal(settings.terminal.fontSize, DEFAULT_TERMINAL_PREFERENCES.fontSize)
  assert.equal(settings.terminal.cursorStyle, DEFAULT_TERMINAL_PREFERENCES.cursorStyle)
  assert.equal(settings.terminal.minContrastRatio, DEFAULT_TERMINAL_PREFERENCES.minContrastRatio)
})
