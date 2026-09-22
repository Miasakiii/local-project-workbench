/**
 * M0-6 技术验证（二）：真实仓库集成。
 *
 * 在临时仓库中制造各类变更，验证 porcelain v2 解析在实际 Git 输出上正确。
 *
 * 用法：node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-git-repo-m0.mts
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countByGroup, parsePorcelainV2 } from '../src/main/modules/git-parse.ts'
import { detectRepositoryRoot } from '../src/main/modules/git-query.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
}

function statusOf(cwd: string) {
  const output = execFileSync(
    'git',
    ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'],
    { cwd, windowsHide: true }
  )
  return parsePorcelainV2(output)
}

const checks: Array<[string, boolean, string]> = []
const root = mkdtempSync(join(tmpdir(), 'lpw-git-'))

try {
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'M0 Verify'])
  git(root, ['config', 'user.email', 'm0@example.com'])

  writeFileSync(join(root, '已修改.txt'), 'v1\n')
  writeFileSync(join(root, '已暂存.txt'), 'v1\n')
  writeFileSync(join(root, '原名 文件.txt'), 'v1\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-q', '-m', '初始提交'])

  writeFileSync(join(root, '已修改.txt'), 'v2\n')
  writeFileSync(join(root, '已暂存.txt'), 'v2\n')
  git(root, ['add', '已暂存.txt'])
  writeFileSync(join(root, '未跟踪.md'), '# 未跟踪\n')
  git(root, ['mv', '原名 文件.txt', '改名 文件.txt'])

  const { branch, entries } = statusOf(root)
  const find = (path: string, group: string) =>
    entries.some((entry) => entry.relativePath === path && entry.group === group)

  checks.push(['分支名', branch === 'main', `branch=${String(branch)}`])
  checks.push(['未暂存修改', find('已修改.txt', 'unstaged'), '已修改.txt → unstaged'])
  checks.push(['已暂存修改', find('已暂存.txt', 'staged'), '已暂存.txt → staged'])
  checks.push(['未跟踪文件', find('未跟踪.md', 'untracked'), '未跟踪.md → untracked'])

  const renamed = entries.find((entry) => entry.relativePath === '改名 文件.txt')
  checks.push([
    '重命名（含空格中文名）',
    renamed?.group === 'staged' && renamed.originalPath === '原名 文件.txt',
    `group=${renamed?.group ?? '未取到'} originalPath=${renamed?.originalPath ?? '未取到'}`
  ])

  const counts = countByGroup(entries)
  checks.push([
    '分组统计',
    counts.unstaged === 1 && counts.staged === 2 && counts.untracked === 1,
    `unstaged=${counts.unstaged} staged=${counts.staged} untracked=${counts.untracked}`
  ])
} finally {
  rmSync(root, { recursive: true, force: true })
}

// 无 HEAD 场景：仅 init、无任何提交
const empty = mkdtempSync(join(tmpdir(), 'lpw-git-empty-'))
try {
  git(empty, ['init', '-q', '-b', 'main'])
  writeFileSync(join(empty, '待提交.txt'), 'x\n')
  const { branch, entries } = statusOf(empty)
  checks.push([
    '无 HEAD 时不报错',
    entries.length === 1 && entries[0]?.group === 'untracked',
    `branch=${String(branch)} 未跟踪数=${entries.length}`
  ])
} finally {
  rmSync(empty, { recursive: true, force: true })
}

// G4：仓库根解析（登记子目录时提示可改用仓库根）
{
  const repoRoot = mkdtempSync(join(tmpdir(), 'lpw-git-root-'))
  const nonRepo = mkdtempSync(join(tmpdir(), 'lpw-git-nonrepo-'))
  try {
    git(repoRoot, ['init', '-q', '-b', 'main'])
    const subdir = join(repoRoot, 'sub', 'deep')
    mkdirSync(subdir, { recursive: true })
    const norm = (value: string): string => realpathSync(value).replace(/\\/g, '/').toLowerCase()
    const fromSub = await detectRepositoryRoot(subdir)
    checks.push([
      '仓库根解析（子目录→仓库根）',
      fromSub !== null && norm(fromSub) === norm(repoRoot),
      `root=${String(fromSub)} expect=${repoRoot}`
    ])
    checks.push(['非仓库目录→null', (await detectRepositoryRoot(nonRepo)) === null, `nonRepo=${nonRepo}`])
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(nonRepo, { recursive: true, force: true })
  }
}

console.log('=== M0-6 验证（二）：真实仓库集成 ===\n')
let allPass = true
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '[通过]' : '[失败]'} ${name} — ${detail}`)
  if (!pass) allPass = false
}
console.log(allPass ? '\n结论：真实仓库解析全部通过' : '\n结论：存在失败项')
process.exit(allPass ? 0 : 1)
