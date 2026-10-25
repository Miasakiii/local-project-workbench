/**
 * 终端外观基线（可读性）。
 *
 * 这些值集中在一处，是因为它们直接决定「终端里的字看不看得清」，而此前的问题恰恰
 * 出在其中三项上（2026-10 终端可读性优化）：
 *
 * 1. **中文字形**：`Consolas`／`Cascadia Mono` 都没有中文字形。只写西文等宽字体时，
 *    中文会一路回退到系统默认等宽（Windows 上是宋体）——小字号下笔画细而发虚，
 *    与等宽的西文混排时基线也不齐。因此回退链里必须显式点名中文字体。
 * 2. **对比度**：`minimumContrastRatio` 让 xterm 自动把前景色提亮到至少满足该对比度
 *    （WCAG 门槛：4.5 为 AA、7 为 AAA）。Claude Code 这类 CLI 大量用 256 色灰阶
 *    （如 240）或真彩色灰表示「次要文本」，在本项目的深色背景上实测低至约 1.5:1，
 *    这是此前可读性差的**最大单一来源**；纯靠挑主题色无法覆盖 CLI 自己输出的颜色。
 * 3. **字号与行距**：13px／1.25 行高在中文密排下过挤，默认提到 14px／1.4；
 *    同时允许 Ctrl+滚轮临时缩放（见 `TerminalView`），偏好写本地存储后跨会话保留。
 *
 * 主题里的 16 色刻意比 xterm 默认更亮：Claude Code 的 `dim` 文本常用 brightBlack，
 * 默认值在深色背景上同样偏暗。
 */

/** 西文等宽在前、中文与符号回退在后；中文字体缺失时会一路回退到宋体，小字发虚。 */
export const TERMINAL_FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", "Segoe UI Symbol", "Noto Sans SC", monospace'

export const TERMINAL_FONT_SIZE_DEFAULT = 14
export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 24

/** 行距：中文密排时 1.25 明显拥挤，1.4 兼顾密度与呼吸感。 */
export const TERMINAL_LINE_HEIGHT = 1.4
/** 字间距：西文等宽字体在深色背景下略微拉开更易扫读，0.2px 不影响列宽测量。 */
export const TERMINAL_LETTER_SPACING = 0.2
/** WCAG AAA（7:1）。低于它的前景色由 xterm 自动提亮，高于它的颜色保持原样。 */
export const TERMINAL_MIN_CONTRAST_RATIO = 7
/** 滚动回看行数；主进程不保留输出，这份缓冲是唯一的回滚来源。 */
export const TERMINAL_SCROLLBACK = 10000

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

/** 字号偏好的本地存储键；同一窗口内各标签共享。 */
export const TERMINAL_FONT_SIZE_STORAGE_KEY = 'workbench.terminal.fontSize'
/** 字号变化广播事件：Ctrl+滚轮缩放后，同窗口其它已挂载的终端一并对齐。 */
export const TERMINAL_FONT_SIZE_EVENT = 'workbench:terminal-font-size'

/** 只依赖 `getItem`／`setItem`，便于在无 DOM 的单元测试里注入假存储。 */
export interface FontSizeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 归一化字号：非数值（含 NaN／Infinity／字符串）回落到默认值，数值四舍五入后夹在
 * 区间内。存储里的值可能被手改或来自旧版本，一律当作不可信输入。
 */
export function clampTerminalFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TERMINAL_FONT_SIZE_DEFAULT
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)))
}

/** 读取字号偏好；存储不可用或内容非法时回落到默认值，绝不因读存储失败而中断终端。 */
export function readTerminalFontSize(storage: FontSizeStorage | null): number {
  if (storage === null) return TERMINAL_FONT_SIZE_DEFAULT
  try {
    const raw = storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY)
    if (raw === null || raw === '') return TERMINAL_FONT_SIZE_DEFAULT
    return clampTerminalFontSize(Number(raw))
  } catch {
    return TERMINAL_FONT_SIZE_DEFAULT
  }
}

/** 写入字号偏好；存储不可用（如配额已满）时静默忽略，本次缩放仍然生效。 */
export function writeTerminalFontSize(storage: FontSizeStorage | null, size: number): number {
  const next = clampTerminalFontSize(size)
  if (storage === null) return next
  try {
    storage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(next))
  } catch {
    // 忽略：偏好持久化失败不影响当次使用
  }
  return next
}

/** 按一步缩放：`direction` 为 1 放大、-1 缩小，结果已夹在区间内。 */
export function stepTerminalFontSize(current: number, direction: 1 | -1): number {
  return clampTerminalFontSize(clampTerminalFontSize(current) + direction)
}
