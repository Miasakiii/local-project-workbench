/**
 * 终端视觉常量（可读性基线）。
 *
 * 1. **中文字形**：`Consolas`／`Cascadia Mono` 都没有中文字形。只写西文等宽字体时，
 *    中文会一路回退到系统默认等宽（Windows 上是宋体），小字号下笔画细而发虚。
 *    字体预设的每一条回退链都显式点名中文字体。
 * 2. **对比度**：`minimumContrastRatio` 让 xterm 自动把前景色提亮到至少满足该对比度。
 *    CLI 大量用 256 色灰阶表示次要文本，纯靠挑主题色覆盖不到。
 * 3. **滚动回看**：主进程不保留输出，xterm 缓冲是唯一的回滚来源。
 *
 * 偏好数值本身由 `@shared/terminal-settings` 统一校验与持久化，这里只负责渲染映射。
 */

import {
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  type TerminalFontChoice
} from '@shared/terminal-settings'

/** 默认字体栈：西文等宽在前、中文与符号回退在后。 */
export const TERMINAL_FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", "Segoe UI Symbol", "Noto Sans SC", monospace'

export const TERMINAL_FONT_STACKS: Record<TerminalFontChoice, string> = {
  default: TERMINAL_FONT_FAMILY,
  cascadia: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", "Segoe UI Symbol", monospace',
  consolas: 'Consolas, "Microsoft YaHei UI", "Segoe UI Symbol", monospace'
}

export function resolveTerminalFontFamily(choice: TerminalFontChoice): string {
  return TERMINAL_FONT_STACKS[choice] ?? TERMINAL_FONT_FAMILY
}

/** 比 xterm 默认更亮的 16 色：CLI 的 dim 文本常用 brightBlack。 */
export const TERMINAL_THEME = {
  background: '#181a1d',
  foreground: '#e7e9ec',
  cursor: '#e7e9ec',
  cursorAccent: '#181a1d',
  selectionBackground: 'rgba(120, 170, 255, 0.30)',
  black: '#3f4347',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#e3b341',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#d6d9dd',
  brightBlack: '#9aa0a6',
  brightRed: '#ffa198',
  brightGreen: '#a7f3a0',
  brightYellow: '#f2cc60',
  brightBlue: '#a5d6ff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#8ee9ef',
  brightWhite: '#f5f7fa'
} as const

/** 搜索高亮：与终端深色主题同一冷色系，当前匹配明显高于其余匹配。 */
export const TERMINAL_SEARCH_DECORATIONS = {
  matchBackground: '#3a4c63',
  matchBorder: '#4d6b8f',
  matchOverviewRuler: '#4d6b8f',
  activeMatchBackground: '#2e5f8f',
  activeMatchBorder: '#9cc7ef',
  activeMatchColorOverviewRuler: '#9cc7ef'
} as const

/** 按一步缩放：结果夹在合法区间内。入参应为已校验的整数。 */
export function stepTerminalFontSize(current: number, direction: 1 | -1): number {
  const base = Number.isFinite(current) ? Math.round(current) : TERMINAL_FONT_SIZE_DEFAULT
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, base + direction))
}
