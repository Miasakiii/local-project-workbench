/**
 * G3b 验证：编辑器路径的持久化与回退（设计稿 4.2「用指定编辑器打开」）。
 *
 * 纯 Node：settings 存临时文件，不依赖 Electron／显示会话。spawn 真正拉起编辑器属
 * 环境相关、不在此断言；这里验证编辑器路径能否被设置、持久化、清空与缺省回退，
 * 且不影响其它偏好字段。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-g3b-editor.mts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettingsStore } from '../src/main/modules/app-settings.ts'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

const dir = mkdtempSync(join(tmpdir(), 'lpw-g3b-'))
try {
  const file = join(dir, 'settings.json')
  const store = createSettingsStore(file)

  check('默认 editorPath 为 null（未设置）', store.get().editorPath === null, String(store.get().editorPath))

  const editor = process.platform === 'win32' ? 'C:\\ed\\Code.exe' : '/usr/local/bin/code'
  store.setEditorPath(editor)
  check('setEditorPath 生效', store.get().editorPath === editor, String(store.get().editorPath))

  // 重新打开同一文件，模拟重启后读回
  const reopened = createSettingsStore(file)
  check('持久化后可读回', reopened.get().editorPath === editor, String(reopened.get().editorPath))

  store.setEditorPath(null)
  check('setEditorPath(null) 清空', store.get().editorPath === null, String(store.get().editorPath))

  store.setEditorPath('')
  check('空串按 null 处理', store.get().editorPath === null, String(store.get().editorPath))

  const withEditor = createSettingsStore(file)
  withEditor.setRestoreLastProject(true)
  check(
    '设编辑器不破坏其它偏好',
    withEditor.get().editorPath === null && withEditor.get().restoreLastProject === true,
    JSON.stringify(withEditor.get())
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}

let passed = 0
for (const item of checks) {
  if (item.pass) {
    passed += 1
  } else {
    console.error(`  [失败] ${item.name} — ${item.detail}`)
  }
}
console.log(`合计：${passed}/${checks.length} 项通过`)
process.exitCode = passed === checks.length ? 0 : 1
