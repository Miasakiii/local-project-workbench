import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type FontSizeStorage,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_MIN_CONTRAST_RATIO,
  TERMINAL_THEME,
  clampTerminalFontSize,
  readTerminalFontSize,
  stepTerminalFontSize,
  writeTerminalFontSize
} from '../../src/renderer/src/components/terminal-appearance'

/** 假存储：只实现字号偏好用到的两个方法。 */
function createStorage(initial: Record<string, string> = {}): FontSizeStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

/** WCAG 相对亮度，用于校验主题前景/背景的对比度门槛。 */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

test('字号归一化：非数值回落到默认值', () => {
  assert.equal(clampTerminalFontSize(undefined), TERMINAL_FONT_SIZE_DEFAULT)
  assert.equal(clampTerminalFontSize(null), TERMINAL_FONT_SIZE_DEFAULT)
  assert.equal(clampTerminalFontSize('16'), TERMINAL_FONT_SIZE_DEFAULT)
  assert.equal(clampTerminalFontSize(Number.NaN), TERMINAL_FONT_SIZE_DEFAULT)
  assert.equal(clampTerminalFontSize(Number.POSITIVE_INFINITY), TERMINAL_FONT_SIZE_DEFAULT)
})

test('字号归一化：四舍五入并夹在区间内', () => {
  assert.equal(clampTerminalFontSize(14.4), 14)
  assert.equal(clampTerminalFontSize(14.6), 15)
  assert.equal(clampTerminalFontSize(1), TERMINAL_FONT_SIZE_MIN)
  assert.equal(clampTerminalFontSize(999), TERMINAL_FONT_SIZE_MAX)
  assert.equal(clampTerminalFontSize(TERMINAL_FONT_SIZE_MIN), TERMINAL_FONT_SIZE_MIN)
  assert.equal(clampTerminalFontSize(TERMINAL_FONT_SIZE_MAX), TERMINAL_FONT_SIZE_MAX)
})

test('读取字号偏好：存储缺失、空串、非法值都回落到默认值', () => {
  assert.equal(readTerminalFontSize(null), TERMINAL_FONT_SIZE_DEFAULT)
  assert.equal(readTerminalFontSize(createStorage({ 'workbench.terminal.fontSize': '' })), TERMINAL_FONT_SIZE_DEFAULT)
  assert.equal(
    readTerminalFontSize(createStorage({ 'workbench.terminal.fontSize': 'abc' })),
    TERMINAL_FONT_SIZE_DEFAULT
  )
  assert.equal(readTerminalFontSize(createStorage({})), TERMINAL_FONT_SIZE_DEFAULT)
})

test('读取字号偏好：合法值生效，超界值被夹回区间', () => {
  assert.equal(readTerminalFontSize(createStorage({ 'workbench.terminal.fontSize': '16' })), 16)
  assert.equal(readTerminalFontSize(createStorage({ 'workbench.terminal.fontSize': '2' })), TERMINAL_FONT_SIZE_MIN)
  assert.equal(readTerminalFontSize(createStorage({ 'workbench.terminal.fontSize': '99' })), TERMINAL_FONT_SIZE_MAX)
})

test('读取字号偏好：存储抛异常时回落到默认值而不是中断终端', () => {
  const throwing: FontSizeStorage = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => undefined
  }
  assert.equal(readTerminalFontSize(throwing), TERMINAL_FONT_SIZE_DEFAULT)
})

test('写入字号偏好：写入的是夹取后的值，并返回实际值', () => {
  const storage = createStorage()
  assert.equal(writeTerminalFontSize(storage, 17), 17)
  assert.equal(storage.data['workbench.terminal.fontSize'], '17')

  assert.equal(writeTerminalFontSize(storage, 3), TERMINAL_FONT_SIZE_MIN)
  assert.equal(storage.data['workbench.terminal.fontSize'], String(TERMINAL_FONT_SIZE_MIN))

  // 存储不可用（null 或写入抛异常）不影响本次缩放结果
  assert.equal(writeTerminalFontSize(null, 15), 15)
  const throwing: FontSizeStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    }
  }
  assert.equal(writeTerminalFontSize(throwing, 18), 18)
})

test('一步缩放：放大缩小各一档，边界处不再变化', () => {
  assert.equal(stepTerminalFontSize(14, 1), 15)
  assert.equal(stepTerminalFontSize(14, -1), 13)
  assert.equal(stepTerminalFontSize(TERMINAL_FONT_SIZE_MAX, 1), TERMINAL_FONT_SIZE_MAX)
  assert.equal(stepTerminalFontSize(TERMINAL_FONT_SIZE_MIN, -1), TERMINAL_FONT_SIZE_MIN)
})

test('字体栈显式覆盖中文字形（不能只留西文等宽字体）', () => {
  assert.match(TERMINAL_FONT_FAMILY, /Microsoft YaHei UI|Noto Sans SC/)
  assert.match(TERMINAL_FONT_FAMILY, /Cascadia Mono/)
  assert.ok(TERMINAL_FONT_FAMILY.endsWith('monospace'))
})

test('主题 16 色齐全且都是合法色值', () => {
  const keys = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite'
  ] as const
  for (const key of keys) {
    assert.match(TERMINAL_THEME[key], /^#[0-9a-f]{6}$/, `${key} 不是合法 hex`)
    // 背景块用的 black 允许低对比度；其余 15 色在深色背景上都要达到 AA
    if (key !== 'black') {
      const ratio = contrastRatio(TERMINAL_THEME[key], TERMINAL_THEME.background)
      assert.ok(ratio >= 4.5, `${key} 对比度不足：${ratio.toFixed(2)}`)
    }
  }
})

test('默认前景/背景达到 AAA，brightBlack 达到 AA（优化前 brightest 灰在 1.5:1 量级）', () => {
  assert.ok(contrastRatio(TERMINAL_THEME.foreground, TERMINAL_THEME.background) >= 7)
  assert.ok(contrastRatio(TERMINAL_THEME.brightBlack, TERMINAL_THEME.background) >= 4.5)
})

test('最小对比度设置落在 xterm 合法区间且不低于 AA', () => {
  assert.ok(TERMINAL_MIN_CONTRAST_RATIO >= 4.5)
  assert.ok(TERMINAL_MIN_CONTRAST_RATIO <= 21)
})
