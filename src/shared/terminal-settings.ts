/**
 * 终端偏好：主进程持久化与渲染层共享的同一份契约。
 *
 * 字段全部是「可被设置页表达、可被主进程校验」的枚举或数值区间。渲染层传来的
 * 只是候选值，`sanitizeTerminalPreferences` 是唯一的归一化入口：非法、越界、
 * 类型不符一律回落到默认值，损坏的 settings.json 不会让终端不可用。
 */

export const TERMINAL_SHELL_CHOICES = ['pwsh', 'powershell', 'cmd'] as const
export type TerminalShellChoice = (typeof TERMINAL_SHELL_CHOICES)[number]

const TERMINAL_FONT_CHOICES = ['default', 'cascadia', 'consolas'] as const
export type TerminalFontChoice = (typeof TERMINAL_FONT_CHOICES)[number]

const TERMINAL_CURSOR_STYLES = ['bar', 'block', 'underline'] as const
type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number]

const TERMINAL_LINK_BEHAVIORS = ['ask', 'always', 'off'] as const
type TerminalLinkBehavior = (typeof TERMINAL_LINK_BEHAVIORS)[number]

const TERMINAL_DIRECTORY_MODES = ['root', 'current'] as const
export type TerminalDirectoryMode = (typeof TERMINAL_DIRECTORY_MODES)[number]

export const TERMINAL_FONT_SIZE_DEFAULT = 14
export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 24

export const TERMINAL_LINE_HEIGHT_DEFAULT = 1.4
const TERMINAL_LINE_HEIGHT_MIN = 1
const TERMINAL_LINE_HEIGHT_MAX = 2

export const TERMINAL_LETTER_SPACING_DEFAULT = 0.2
const TERMINAL_LETTER_SPACING_MIN = 0
const TERMINAL_LETTER_SPACING_MAX = 2

/** WCAG AAA（7:1）。低于它的前景色由 xterm 自动提亮。 */
export const TERMINAL_MIN_CONTRAST_DEFAULT = 7
const TERMINAL_MIN_CONTRAST_MIN = 1
export const TERMINAL_MIN_CONTRAST_MAX = 21

export const TERMINAL_SCROLLBACK_DEFAULT = 10000
export const TERMINAL_SCROLLBACK_MIN = 1000
const TERMINAL_SCROLLBACK_MAX = 100000

export interface TerminalPreferences {
  /** '' = 按本机自动探测；否则是 `TERMINAL_SHELL_CHOICES` 之一 */
  defaultShell: string
  /** 新建标签从项目根还是当前文件所在目录启动 */
  startupDirectory: TerminalDirectoryMode
  fontFamily: TerminalFontChoice
  fontSize: number
  lineHeight: number
  letterSpacing: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  minContrastRatio: number
  scrollback: number
  copyOnSelect: boolean
  linkOpenBehavior: TerminalLinkBehavior
}

export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  defaultShell: '',
  startupDirectory: 'root',
  fontFamily: 'default',
  fontSize: TERMINAL_FONT_SIZE_DEFAULT,
  lineHeight: TERMINAL_LINE_HEIGHT_DEFAULT,
  letterSpacing: TERMINAL_LETTER_SPACING_DEFAULT,
  cursorStyle: 'bar',
  cursorBlink: true,
  minContrastRatio: TERMINAL_MIN_CONTRAST_DEFAULT,
  scrollback: TERMINAL_SCROLLBACK_DEFAULT,
  copyOnSelect: false,
  linkOpenBehavior: 'ask'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function pickChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value) ? (value as T) : fallback
}

function pickShell(value: unknown): string {
  return typeof value === 'string' && (TERMINAL_SHELL_CHOICES as readonly string[]).includes(value) ? value : ''
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clampNumber(value: unknown, min: number, max: number, fallback: number, decimals = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  return Math.min(max, Math.max(min, rounded))
}

/**
 * 归一化整份终端偏好。
 *
 * 逐字段独立回退：某个字段损坏只影响它自己，不会把其它合法偏好一起重置。
 */
export function sanitizeTerminalPreferences(raw: unknown): TerminalPreferences {
  const value = isRecord(raw) ? raw : {}
  return {
    defaultShell: pickShell(value['defaultShell']),
    startupDirectory: pickChoice(value['startupDirectory'], TERMINAL_DIRECTORY_MODES, 'root'),
    fontFamily: pickChoice(value['fontFamily'], TERMINAL_FONT_CHOICES, 'default'),
    fontSize: clampNumber(
      value['fontSize'],
      TERMINAL_FONT_SIZE_MIN,
      TERMINAL_FONT_SIZE_MAX,
      TERMINAL_FONT_SIZE_DEFAULT
    ),
    lineHeight: clampNumber(
      value['lineHeight'],
      TERMINAL_LINE_HEIGHT_MIN,
      TERMINAL_LINE_HEIGHT_MAX,
      TERMINAL_LINE_HEIGHT_DEFAULT,
      2
    ),
    letterSpacing: clampNumber(
      value['letterSpacing'],
      TERMINAL_LETTER_SPACING_MIN,
      TERMINAL_LETTER_SPACING_MAX,
      TERMINAL_LETTER_SPACING_DEFAULT,
      2
    ),
    cursorStyle: pickChoice(value['cursorStyle'], TERMINAL_CURSOR_STYLES, 'bar'),
    cursorBlink: pickBoolean(value['cursorBlink'], true),
    minContrastRatio: clampNumber(
      value['minContrastRatio'],
      TERMINAL_MIN_CONTRAST_MIN,
      TERMINAL_MIN_CONTRAST_MAX,
      TERMINAL_MIN_CONTRAST_DEFAULT,
      2
    ),
    scrollback: clampNumber(
      value['scrollback'],
      TERMINAL_SCROLLBACK_MIN,
      TERMINAL_SCROLLBACK_MAX,
      TERMINAL_SCROLLBACK_DEFAULT
    ),
    copyOnSelect: pickBoolean(value['copyOnSelect'], false),
    linkOpenBehavior: pickChoice(value['linkOpenBehavior'], TERMINAL_LINK_BEHAVIORS, 'ask')
  }
}

/** 局部更新：未给出的字段保持当前值，给出的字段逐项校验。 */
export function mergeTerminalPreferences(current: TerminalPreferences, patch: unknown): TerminalPreferences {
  if (!isRecord(patch)) return { ...current }
  return sanitizeTerminalPreferences({ ...current, ...patch })
}
