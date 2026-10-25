import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TERMINAL_PREFERENCES,
  mergeTerminalPreferences,
  sanitizeTerminalPreferences,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_LETTER_SPACING_DEFAULT,
  TERMINAL_LINE_HEIGHT_DEFAULT,
  TERMINAL_MIN_CONTRAST_DEFAULT,
  TERMINAL_SCROLLBACK_DEFAULT,
  TERMINAL_SCROLLBACK_MIN
} from '../../src/shared/terminal-settings'

test('默认终端偏好覆盖全部字段且通过自身校验', () => {
  assert.deepEqual(sanitizeTerminalPreferences(DEFAULT_TERMINAL_PREFERENCES), DEFAULT_TERMINAL_PREFERENCES)
})

test('非对象输入整体回落到默认值', () => {
  for (const value of [undefined, null, 42, 'terminal', true, []]) {
    assert.deepEqual(sanitizeTerminalPreferences(value), DEFAULT_TERMINAL_PREFERENCES)
  }
})

test('逐字段独立回退：非法枚举与类型不影响其它合法字段', () => {
  const sanitized = sanitizeTerminalPreferences({
    defaultShell: 'cmd',
    startupDirectory: 'somewhere',
    fontFamily: 'comic',
    fontSize: 18,
    lineHeight: 'tall',
    letterSpacing: 0.5,
    cursorStyle: 'beam',
    cursorBlink: 'yes',
    minContrastRatio: 10,
    scrollback: 50000,
    copyOnSelect: 1,
    linkOpenBehavior: 'auto'
  })

  assert.equal(sanitized.defaultShell, 'cmd')
  assert.equal(sanitized.startupDirectory, 'root')
  assert.equal(sanitized.fontFamily, 'default')
  assert.equal(sanitized.fontSize, 18)
  assert.equal(sanitized.lineHeight, TERMINAL_LINE_HEIGHT_DEFAULT)
  assert.equal(sanitized.letterSpacing, 0.5)
  assert.equal(sanitized.cursorStyle, 'bar')
  assert.equal(sanitized.cursorBlink, true)
  assert.equal(sanitized.minContrastRatio, 10)
  assert.equal(sanitized.scrollback, 50000)
  assert.equal(sanitized.copyOnSelect, false)
  assert.equal(sanitized.linkOpenBehavior, 'ask')
})

test('数值越界被夹回区间，小数按字段精度四舍五入', () => {
  const sanitized = sanitizeTerminalPreferences({
    fontSize: 999,
    lineHeight: 1.238,
    letterSpacing: -1,
    minContrastRatio: 0,
    scrollback: 200
  })
  assert.equal(sanitized.fontSize, TERMINAL_FONT_SIZE_MAX)
  assert.equal(sanitized.lineHeight, 1.24)
  assert.equal(sanitized.letterSpacing, 0)
  assert.equal(sanitized.minContrastRatio, 1)
  assert.equal(sanitized.scrollback, TERMINAL_SCROLLBACK_MIN)

  assert.equal(sanitizeTerminalPreferences({ fontSize: 1 }).fontSize, TERMINAL_FONT_SIZE_MIN)
})

test('非有限数值回落默认值而不是夹取', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const sanitized = sanitizeTerminalPreferences({ fontSize: value, lineHeight: value, scrollback: value })
    assert.equal(sanitized.fontSize, TERMINAL_FONT_SIZE_DEFAULT)
    assert.equal(sanitized.lineHeight, TERMINAL_LINE_HEIGHT_DEFAULT)
    assert.equal(sanitized.scrollback, TERMINAL_SCROLLBACK_DEFAULT)
  }
})

test('枚举白名单：startupDirectory / cursorStyle / linkOpenBehavior', () => {
  assert.equal(sanitizeTerminalPreferences({ startupDirectory: 'current' }).startupDirectory, 'current')
  assert.equal(sanitizeTerminalPreferences({ cursorStyle: 'block' }).cursorStyle, 'block')
  assert.equal(sanitizeTerminalPreferences({ cursorStyle: 'underline' }).cursorStyle, 'underline')
  assert.equal(sanitizeTerminalPreferences({ linkOpenBehavior: 'always' }).linkOpenBehavior, 'always')
  assert.equal(sanitizeTerminalPreferences({ linkOpenBehavior: 'off' }).linkOpenBehavior, 'off')
  assert.equal(sanitizeTerminalPreferences({ fontFamily: 'consolas' }).fontFamily, 'consolas')
})

test('局部更新只改给出的字段，其余保持当前值', () => {
  const current = { ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 18, copyOnSelect: true }
  const merged = mergeTerminalPreferences(current, { fontSize: 20, defaultShell: 'pwsh' })
  assert.equal(merged.fontSize, 20)
  assert.equal(merged.defaultShell, 'pwsh')
  assert.equal(merged.copyOnSelect, true)
  assert.equal(merged.lineHeight, current.lineHeight)

  // 非法候选值回落到该字段默认值，而不是保留旧值
  const invalid = mergeTerminalPreferences(current, { fontSize: '20' })
  assert.equal(invalid.fontSize, TERMINAL_FONT_SIZE_DEFAULT)
  assert.equal(invalid.copyOnSelect, true)
})

test('非对象补丁返回当前值的副本', () => {
  const current = { ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 16 }
  for (const patch of [undefined, null, 'patch', 7]) {
    const merged = mergeTerminalPreferences(current, patch)
    assert.deepEqual(merged, current)
    assert.notEqual(merged, current)
  }
})

test('布尔字段只接受布尔值', () => {
  assert.equal(sanitizeTerminalPreferences({ cursorBlink: false }).cursorBlink, false)
  assert.equal(sanitizeTerminalPreferences({ copyOnSelect: true }).copyOnSelect, true)
  assert.equal(sanitizeTerminalPreferences({ cursorBlink: 0 }).cursorBlink, true)
  assert.equal(sanitizeTerminalPreferences({ copyOnSelect: 'true' }).copyOnSelect, false)
})

test('字母间距默认值与最小值不同，确保默认开启轻微字距', () => {
  assert.equal(DEFAULT_TERMINAL_PREFERENCES.letterSpacing, TERMINAL_LETTER_SPACING_DEFAULT)
  assert.ok(TERMINAL_LETTER_SPACING_DEFAULT > 0)
  assert.equal(DEFAULT_TERMINAL_PREFERENCES.minContrastRatio, TERMINAL_MIN_CONTRAST_DEFAULT)
})
