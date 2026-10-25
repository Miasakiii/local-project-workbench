import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createSettingsStore,
  createStartupLookup,
  decideStartupView,
  sanitizeDefaultShell,
  type StartupProjectState
} from '../../src/main/modules/app-settings'
import type { SettingsResult } from '../../src/shared/ipc'

const baseSettings: SettingsResult = {
  restoreLastProject: false,
  lastProjectId: null,
  editorPath: null,
  defaultShell: ''
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
  const view = decideStartupView(
    { ...baseSettings, restoreLastProject: true, lastProjectId: 'p1' },
    () => ({ status: 'available' })
  )
  assert.deepEqual(view, { projectId: 'p1', notice: null })
})

test('登记已移除与目录不可用分别说明原因', () => {
  const unregistered = decideStartupView(
    { ...baseSettings, restoreLastProject: true, lastProjectId: 'p1' },
    () => ({ status: 'unregistered' })
  )
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
    resolveRoot: (projectId) =>
      projectId === 'known' ? { ok: true } : { ok: false, reason: '目录不存在' }
  })

  assert.deepEqual(lookup('known'), { status: 'available' })
  assert.deepEqual(lookup('missing'), { status: 'unregistered' })
  assert.deepEqual(lookup('gone'), { status: 'unregistered' })
})

test('设置持久化只写入校验后的值', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')

  const store = createSettingsStore(file)
  assert.deepEqual(store.get(), baseSettings)

  store.update({ restoreLastProject: true, defaultShell: 'cmd' })
  store.recordActiveProject('p1')
  store.setEditorPath('C:\\Apps\\Code.exe')

  const reloaded = createSettingsStore(file).get()
  assert.equal(reloaded.restoreLastProject, true)
  assert.equal(reloaded.defaultShell, 'cmd')
  assert.equal(reloaded.lastProjectId, 'p1')
  assert.equal(reloaded.editorPath, 'C:\\Apps\\Code.exe')

  store.update({ defaultShell: 'bash' })
  assert.equal(store.get().defaultShell, '')

  store.setEditorPath('')
  assert.equal(store.get().editorPath, null)
})
