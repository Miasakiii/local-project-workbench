#!/usr/bin/env node
/**
 * 文件体积守卫 —— 单文件行数上限检查。
 *
 * 背景：本项目曾出现 1,300+ 行的组件与 1,000+ 行的主进程模块，回归风险随文件
 * 规模单调上升。2026-09 的重构把两个超大文件按关注点拆开后，用本脚本防止
 * 「大文件」复发：超过上限即失败，确需超限的在文件首行写
 * `// size-guard-allow: <理由>` 豁免（理由必填，供 code review）。
 *
 * 只扫描 `src/**`（应用源码）；`scripts/` 是验证与度量脚本，按用途自然增长，
 * 不受此约束。接入 `verify:all`（lint 之后），也可单独运行。
 *
 * 用法：node scripts/check-file-size.mjs [--limit <行数>]
 */

const { readdirSync, readFileSync } = require('node:fs')
const { join, relative } = require('node:path')

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')
const DEFAULT_LIMIT = 800

/** 豁免标记：首行注释，理由必填 */
const ALLOW_MARKER = /^\s*\/\/\s*size-guard-allow:\s*(\S.*)$/

function parseArgs(argv) {
  const index = argv.indexOf('--limit')
  if (index === -1) return DEFAULT_LIMIT
  const raw = argv[index + 1]
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`无效的 --limit 值：${raw}`)
    process.exit(2)
  }
  return value
}

function walk(dir, output) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, output)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) output.push(full)
  }
  return output
}

function countLines(text) {
  const lines = text.split('\n')
  // 末尾换行不计为空行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

function main() {
  const limit = parseArgs(process.argv.slice(2))
  const files = walk(SRC, []).sort()

  const violations = []
  const exempted = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const lines = countLines(text)
    if (lines <= limit) continue
    const firstLine = text.split('\n')[0] ?? ''
    const marked = ALLOW_MARKER.exec(firstLine)
    if (marked !== null) {
      exempted.push({ file, lines, reason: marked[1] })
      continue
    }
    violations.push({ file, lines })
  }

  for (const item of exempted) {
    console.log(`[豁免] ${relative(ROOT, item.file)}（${item.lines} 行）— ${item.reason}`)
  }
  for (const item of violations) {
    console.log(`[超限] ${relative(ROOT, item.file)}：${item.lines} 行 > ${limit} 行`)
  }

  const largest = files
    .map((file) => ({ file, lines: countLines(readFileSync(file, 'utf8')) }))
    .sort((left, right) => right.lines - left.lines)
    .slice(0, 3)
  console.log(`\n扫描 ${files.length} 个源文件，上限 ${limit} 行；最大的三个：`)
  for (const item of largest) {
    console.log(`  ${String(item.lines).padStart(5)} 行  ${relative(ROOT, item.file)}`)
  }

  if (violations.length > 0) {
    console.log(
      `\n失败：${violations.length} 个文件超过 ${limit} 行。请按关注点拆分，或在首行加 ` +
        '`// size-guard-allow: <理由>` 豁免（理由会进入 code review）。'
    )
    process.exit(1)
  }
  console.log(`\n通过：无文件超过 ${limit} 行${exempted.length > 0 ? `（${exempted.length} 个已豁免）` : ''}。`)
}

main()
