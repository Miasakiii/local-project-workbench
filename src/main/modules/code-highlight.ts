/**
 * 轻量语法高亮（设计稿 4.2：代码支持语法高亮与行号）。
 *
 * 为什么自行实现而不引入高亮库：
 * 1. 输出必须是**已转义**的 HTML，与 Markdown 预览共用同一套「不产生可执行内容」
 *    的约束；自建扫描器可以让「输出只有 span 与已转义文本」成为可断言的性质。
 * 2. 依赖越少，分发体积与供应链面越小（见 M0-7 体积实测）。
 *
 * 覆盖范围：行注释、块注释、字符串、数字、语言关键字。这不是完整词法分析，
 * 但对阅读代码足够，且不会因误判而产生安全问题（最坏情况是着色不准）。
 *
 * 性能保护：超过 `MAX_HIGHLIGHT_BYTES` 的内容不做高亮，仅按行转义输出。
 */

export const MAX_HIGHLIGHT_BYTES = 200 * 1024

interface LanguageSpec {
  /** 行注释前缀 */
  lineComments: string[]
  /** 块注释起止 */
  blockComment: [string, string] | null
  /** 字符串定界符 */
  quotes: string[]
  keywords: string[]
}

const COMMON = ['if', 'else', 'for', 'while', 'return', 'break', 'continue', 'true', 'false', 'null', 'undefined']

const LANGUAGES: Record<string, LanguageSpec> = {
  typescript: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    keywords: [
      ...COMMON,
      'const',
      'let',
      'var',
      'function',
      'class',
      'interface',
      'type',
      'enum',
      'import',
      'export',
      'from',
      'as',
      'new',
      'this',
      'extends',
      'implements',
      'public',
      'private',
      'protected',
      'readonly',
      'static',
      'async',
      'await',
      'try',
      'catch',
      'finally',
      'throw',
      'typeof',
      'instanceof',
      'in',
      'of',
      'void',
      'never',
      'unknown',
      'any',
      'string',
      'number',
      'boolean'
    ]
  },
  javascript: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    keywords: [
      ...COMMON,
      'const',
      'let',
      'var',
      'function',
      'class',
      'import',
      'export',
      'from',
      'new',
      'this',
      'async',
      'await',
      'try',
      'catch',
      'finally',
      'throw',
      'typeof',
      'instanceof',
      'in',
      'of',
      'void'
    ]
  },
  python: {
    lineComments: ['#'],
    blockComment: null,
    quotes: ['"', "'"],
    keywords: [
      ...COMMON,
      'def',
      'class',
      'import',
      'from',
      'as',
      'with',
      'try',
      'except',
      'finally',
      'raise',
      'lambda',
      'yield',
      'global',
      'nonlocal',
      'pass',
      'assert',
      'del',
      'elif',
      'and',
      'or',
      'not',
      'is',
      'None',
      'True',
      'False',
      'self'
    ]
  },
  shell: {
    lineComments: ['#'],
    blockComment: null,
    quotes: ['"', "'"],
    keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'export', 'local', 'echo', 'exit', 'set']
  },
  powershell: {
    lineComments: ['#'],
    blockComment: ['<#', '#>'],
    quotes: ['"', "'"],
    keywords: ['param', 'function', 'if', 'else', 'elseif', 'foreach', 'while', 'return', 'try', 'catch', 'finally', 'throw', 'begin', 'process', 'end']
  },
  rust: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"'],
    keywords: [
      ...COMMON,
      'fn',
      'let',
      'mut',
      'struct',
      'enum',
      'impl',
      'trait',
      'pub',
      'use',
      'mod',
      'match',
      'where',
      'self',
      'Self',
      'crate',
      'async',
      'await',
      'move',
      'dyn',
      'ref'
    ]
  },
  go: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', '`'],
    keywords: [
      ...COMMON,
      'func',
      'package',
      'import',
      'type',
      'struct',
      'interface',
      'map',
      'chan',
      'go',
      'defer',
      'select',
      'range',
      'var',
      'const',
      'nil'
    ]
  },
  java: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    keywords: [
      ...COMMON,
      'public',
      'private',
      'protected',
      'class',
      'interface',
      'extends',
      'implements',
      'package',
      'import',
      'new',
      'static',
      'final',
      'void',
      'int',
      'long',
      'double',
      'float',
      'boolean',
      'char',
      'String',
      'this',
      'super',
      'try',
      'catch',
      'finally',
      'throw',
      'throws'
    ]
  },
  c: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    keywords: [
      ...COMMON,
      'int',
      'char',
      'float',
      'double',
      'void',
      'struct',
      'union',
      'enum',
      'typedef',
      'static',
      'const',
      'extern',
      'sizeof',
      'unsigned',
      'signed',
      'long',
      'short',
      'switch',
      'case',
      'default',
      'goto',
      '#include',
      '#define'
    ]
  },
  csharp: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    keywords: [
      ...COMMON,
      'public',
      'private',
      'protected',
      'internal',
      'class',
      'interface',
      'struct',
      'namespace',
      'using',
      'new',
      'static',
      'readonly',
      'void',
      'int',
      'string',
      'bool',
      'var',
      'this',
      'base',
      'try',
      'catch',
      'finally',
      'throw',
      'async',
      'await'
    ]
  },
  json: {
    lineComments: [],
    blockComment: null,
    quotes: ['"'],
    keywords: ['true', 'false', 'null']
  },
  yaml: {
    lineComments: ['#'],
    blockComment: null,
    quotes: ['"', "'"],
    keywords: ['true', 'false', 'null', 'yes', 'no']
  },
  toml: {
    lineComments: ['#'],
    blockComment: null,
    quotes: ['"', "'"],
    keywords: ['true', 'false']
  },
  ini: {
    lineComments: [';', '#'],
    blockComment: null,
    quotes: ['"', "'"],
    keywords: []
  },
  sql: {
    lineComments: ['--'],
    blockComment: ['/*', '*/'],
    quotes: ["'"],
    keywords: [
      'select',
      'from',
      'where',
      'insert',
      'into',
      'values',
      'update',
      'set',
      'delete',
      'create',
      'table',
      'index',
      'view',
      'join',
      'left',
      'right',
      'inner',
      'outer',
      'on',
      'group',
      'by',
      'order',
      'having',
      'limit',
      'offset',
      'as',
      'and',
      'or',
      'not',
      'null',
      'primary',
      'key',
      'foreign',
      'references'
    ]
  },
  css: {
    lineComments: [],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    keywords: []
  },
  html: {
    lineComments: [],
    blockComment: ['<!--', '-->'],
    quotes: ['"', "'"],
    keywords: []
  },
  markup: {
    lineComments: [],
    blockComment: ['<!--', '-->'],
    quotes: ['"', "'"],
    keywords: []
  }
}

/** 文件扩展名 → 语言标识 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  hpp: 'c',
  cs: 'csharp',
  json: 'json',
  jsonc: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'ini',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  xml: 'markup',
  vue: 'html',
  svelte: 'html'
}

/** 语言标识 → 展示名 */
const LANGUAGE_LABEL: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  shell: 'Shell',
  powershell: 'PowerShell',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  c: 'C/C++',
  csharp: 'C#',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  ini: '配置',
  sql: 'SQL',
  css: 'CSS',
  html: 'HTML',
  markup: 'XML'
}

export function languageForExtension(extension: string): string | null {
  const key = extension.replace(/^\./, '').toLowerCase()
  return EXTENSION_LANGUAGE[key] ?? null
}

export function languageLabel(language: string): string {
  return LANGUAGE_LABEL[language] ?? language
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface Token {
  text: string
  className: string | null
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char)
}

function tokenize(source: string, spec: LanguageSpec): Token[] {
  const tokens: Token[] = []
  const keywordSet = new Set(spec.keywords)
  let plain = ''
  let index = 0

  const flushPlain = (): void => {
    if (plain.length > 0) {
      tokens.push({ text: plain, className: null })
      plain = ''
    }
  }

  while (index < source.length) {
    const rest = source.slice(index)

    // 块注释
    if (spec.blockComment !== null && rest.startsWith(spec.blockComment[0])) {
      const end = source.indexOf(spec.blockComment[1], index + spec.blockComment[0].length)
      const stop = end === -1 ? source.length : end + spec.blockComment[1].length
      flushPlain()
      tokens.push({ text: source.slice(index, stop), className: 'tok-comment' })
      index = stop
      continue
    }

    // 行注释
    const lineComment = spec.lineComments.find((prefix) => rest.startsWith(prefix))
    if (lineComment !== undefined) {
      const end = source.indexOf('\n', index)
      const stop = end === -1 ? source.length : end
      flushPlain()
      tokens.push({ text: source.slice(index, stop), className: 'tok-comment' })
      index = stop
      continue
    }

    // 字符串
    const quote = spec.quotes.find((candidate) => rest.startsWith(candidate))
    if (quote !== undefined) {
      let cursor = index + quote.length
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source.startsWith(quote, cursor)) {
          cursor += quote.length
          break
        }
        cursor += 1
      }
      flushPlain()
      tokens.push({ text: source.slice(index, Math.min(cursor, source.length)), className: 'tok-string' })
      index = Math.min(cursor, source.length)
      continue
    }

    const char = source[index] as string

    // 数字
    if (/[0-9]/.test(char) && !isIdentifierPart(source[index - 1] ?? '')) {
      let cursor = index
      while (cursor < source.length && /[0-9a-fA-FxXoObB._eE+-]/.test(source[cursor] as string)) {
        // 避免把 `1-2` 之类的表达式整体吃掉
        const previous = source[cursor - 1] as string
        if ((source[cursor] === '-' || source[cursor] === '+') && !/[eE]/.test(previous)) break
        cursor += 1
      }
      flushPlain()
      tokens.push({ text: source.slice(index, cursor), className: 'tok-number' })
      index = cursor
      continue
    }

    // 标识符与关键字
    if (isIdentifierStart(char)) {
      let cursor = index
      while (cursor < source.length && isIdentifierPart(source[cursor] as string)) cursor += 1
      const word = source.slice(index, cursor)
      if (keywordSet.has(word)) {
        flushPlain()
        tokens.push({ text: word, className: 'tok-keyword' })
      } else {
        plain += word
      }
      index = cursor
      continue
    }

    plain += char
    index += 1
  }

  flushPlain()
  return tokens
}

export interface HighlightResult {
  /** 已转义的 HTML，只包含 span 与文本 */
  html: string
  /** 行数 */
  lineCount: number
  /** 是否因超出上限而未高亮 */
  plain: boolean
}

/**
 * 生成带行号的代码 HTML。
 * 每一行输出为 `<span class="code-line" data-line="n">…</span>`，
 * 内容已转义，不含任何属性注入点。
 */
export function highlightCode(source: string, language: string | null): HighlightResult {
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const lineCount = lines.length

  if (language === null || normalized.length > MAX_HIGHLIGHT_BYTES) {
    return {
      html: lines
        .map((line, index) => `<span class="code-line" data-line="${index + 1}">${escapeHtml(line)}</span>`)
        .join('\n'),
      lineCount,
      plain: true
    }
  }

  const spec = LANGUAGES[language] ?? null
  if (spec === null) {
    return {
      html: lines
        .map((line, index) => `<span class="code-line" data-line="${index + 1}">${escapeHtml(line)}</span>`)
        .join('\n'),
      lineCount,
      plain: true
    }
  }

  // 逐行高亮：块注释跨行的情形按行内独立处理，避免为着色引入全局状态机
  const html = lines
    .map((line, index) => {
      const tokens = tokenize(line, spec)
      const body = tokens
        .map((token) => (token.className === null ? escapeHtml(token.text) : `<span class="${token.className}">${escapeHtml(token.text)}</span>`))
        .join('')
      return `<span class="code-line" data-line="${index + 1}">${body}</span>`
    })
    .join('\n')

  return { html, lineCount, plain: false }
}
