import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  TERMINAL_MIN_CONTRAST_DEFAULT,
  TERMINAL_MIN_CONTRAST_MAX
} from '../../src/shared/terminal-settings'
import {
  resolveTerminalFontFamily,
  stepTerminalFontSize,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_STACKS,
  TERMINAL_SEARCH_DECORATIONS,
  TERMINAL_THEME
} from '../../src/renderer/src/components/terminal-appearance'

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

test('每个字体预设都显式覆盖中文字形，并以 monospace 兜底', () => {
  for (const stack of Object.values(TERMINAL_FONT_STACKS)) {
    assert.match(stack, /Microsoft YaHei UI|Noto Sans SC/)
    assert.ok(stack.endsWith('monospace'))
  }
  assert.equal(resolveTerminalFontFamily('default'), TERMINAL_FONT_FAMILY)
  assert.equal(resolveTerminalFontFamily('cascadia'), TERMINAL_FONT_STACKS.cascadia)
  assert.equal(resolveTerminalFontFamily('consolas'), TERMINAL_FONT_STACKS.consolas)
})

test('未知字体预设回落到默认字体栈', () => {
  assert.equal(
    resolveTerminalFontFamily('unknown' as unknown as keyof typeof TERMINAL_FONT_STACKS),
    TERMINAL_FONT_FAMILY
  )
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

test('默认前景/背景达到 AAA，brightBlack 达到 AA', () => {
  assert.ok(contrastRatio(TERMINAL_THEME.foreground, TERMINAL_THEME.background) >= 7)
  assert.ok(contrastRatio(TERMINAL_THEME.brightBlack, TERMINAL_THEME.background) >= 4.5)
})

test('最小对比度默认值落在 xterm 合法区间且不低于 AA', () => {
  assert.ok(TERMINAL_MIN_CONTRAST_DEFAULT >= 4.5)
  assert.ok(TERMINAL_MIN_CONTRAST_DEFAULT <= TERMINAL_MIN_CONTRAST_MAX)
})

test('搜索高亮是合法色值，当前匹配与普通匹配可区分', () => {
  for (const value of Object.values(TERMINAL_SEARCH_DECORATIONS)) {
    assert.match(value, /^#[0-9a-f]{6}$/)
  }
  assert.notEqual(TERMINAL_SEARCH_DECORATIONS.activeMatchBackground, TERMINAL_SEARCH_DECORATIONS.matchBackground)
  assert.ok(
    relativeLuminance(TERMINAL_SEARCH_DECORATIONS.activeMatchBackground) >
      relativeLuminance(TERMINAL_SEARCH_DECORATIONS.matchBackground)
  )
})

test('一步缩放：放大缩小各一档，边界处不再变化', () => {
  assert.equal(stepTerminalFontSize(14, 1), 15)
  assert.equal(stepTerminalFontSize(14, -1), 13)
  assert.equal(stepTerminalFontSize(TERMINAL_FONT_SIZE_MAX, 1), TERMINAL_FONT_SIZE_MAX)
  assert.equal(stepTerminalFontSize(TERMINAL_FONT_SIZE_MIN, -1), TERMINAL_FONT_SIZE_MIN)
})
