import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SIDEBAR_OPEN,
  LEGACY_SIDEBAR_PREFERENCE_KEY,
  parseLegacySidebarPreference,
  sanitizeSidebarPreference
} from '../../src/shared/sidebar-settings'

test('旧 localStorage 键名与历史版本一致，迁移才找得到旧值', () => {
  assert.equal(LEGACY_SIDEBAR_PREFERENCE_KEY, 'workbench.sidebarOpen')
})

test('默认展开，落盘校验只接受布尔，非法值一律回落默认', () => {
  assert.equal(DEFAULT_SIDEBAR_OPEN, true)
  assert.equal(sanitizeSidebarPreference(true), true)
  assert.equal(sanitizeSidebarPreference(false), false)
  for (const value of ['false', 'true', 'FALSE', 0, 1, null, undefined, {}, []]) {
    assert.equal(sanitizeSidebarPreference(value), DEFAULT_SIDEBAR_OPEN)
  }
})

test('旧 localStorage 值解析沿用旧读取语义：仅字符串 false 视为收起', () => {
  assert.equal(parseLegacySidebarPreference('false'), false)
  assert.equal(parseLegacySidebarPreference('true'), true)
  assert.equal(parseLegacySidebarPreference('FALSE'), true)
  assert.equal(parseLegacySidebarPreference('0'), true)
  assert.equal(parseLegacySidebarPreference(''), true)
  assert.equal(parseLegacySidebarPreference(' 收起 '), true)
})

test('旧键不存在时返回 null 表示无需迁移', () => {
  assert.equal(parseLegacySidebarPreference(null), null)
})
