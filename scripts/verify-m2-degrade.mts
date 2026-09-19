/**
 * M2 验证（二）：失败降级与监听过滤规则。
 *
 * 对应推进计划 M2-6 与设计稿 5.3：
 *   - Git 查询失败必须给出原因，**不得呈现为「无变更」**
 *   - 非仓库、无首次提交、项目外路径分别有明确结论
 *   - 监听忽略依赖与构建目录，只关注 Git 元数据文件
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-m2-degrade.mts
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectRepository, queryFileDiff, queryGitStatus } from '../src/main/modules/git-query.ts'
import { isWatchedPath } from '../src/main/modules/file-watcher.ts'
import { fileDiff } from '../src/main/modules/diff-service.ts'

const keepFixture = process.argv.includes('--keep')
const root = join(tmpdir(), 'workbench-m2-degrade')
const repo = join(root, 'repo')
const noHeadRepo = join(root, 'no-head')
const plainDir = join(root, 'plain')

const CHECKS: Array<{ name: string; pass: boolean; detail: string }> = []
function check(name: string, pass: boolean, detail: string): void {
  CHECKS.push({ name, pass, detail })
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function buildFixtures(): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  mkdirSync(noHeadRepo, { recursive: true })
  mkdirSync(plainDir, { recursive: true })

  git(repo, ['init', '--quiet'])
  git(repo, ['config', 'user.email', 'verify@example.com'])
  git(repo, ['config', 'user.name', 'verify'])
  git(repo, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'a\n', 'utf8')
  git(repo, ['add', 'a.txt'])
  git(repo, ['commit', '--quiet', '-m', '初始提交'])

  git(noHeadRepo, ['init', '--quiet'])
  git(noHeadRepo, ['config', 'user.email', 'verify@example.com'])
  git(noHeadRepo, ['config', 'user.name', 'verify'])
  writeFileSync(join(noHeadRepo, 'first.txt'), 'first\n', 'utf8')
  git(noHeadRepo, ['add', 'first.txt'])

  writeFileSync(join(plainDir, 'note.txt'), 'note\n', 'utf8')
}

/* ---------- 一、监听过滤规则 ---------- */

function verifyWatchRules(): void {
  const ignored: Array<[string, string]> = [
    ['node_modules/react/index.js', '依赖目录'],
    ['src/node_modules/x.js', '嵌套依赖目录'],
    ['dist/bundle.js', '构建产物'],
    ['.git/objects/ab/cdef', 'Git 对象库'],
    ['.git/logs/HEAD', 'Git 日志'],
    ['target/debug/app', 'Rust 构建目录'],
    ['__pycache__/mod.pyc', 'Python 缓存'],
    ['a/b/.cache/data', '缓存目录'],
    ['editor.swp', '编辑器临时文件'],
    ['file.tmp', '临时文件'],
    ['backup~', '编辑器备份'],
    ['.DS_Store', '系统文件']
  ]
  for (const [path, label] of ignored) {
    check(`忽略${label}`, isWatchedPath(path) === false, `${path} → ${String(isWatchedPath(path))}`)
  }

  const watched = ['.git/HEAD', '.git/index', '.git/refs/heads/main', 'src/index.ts', 'README.md', 'a/b/c.txt']
  for (const path of watched) {
    check(`监听 ${path}`, isWatchedPath(path) === true, `→ ${String(isWatchedPath(path))}`)
  }
}

/* ---------- 二、失败与「无变更」可区分 ---------- */

async function verifyDegradation(): Promise<void> {
  /* 非仓库目录：状态查询必须报错，而不是返回「干净」 */
  const plainStatus = await queryGitStatus('p', plainDir, 1)
  check(
    '非仓库目录的状态查询报错',
    plainStatus.stale === true && plainStatus.error !== null && plainStatus.entries.length === 0,
    `stale=${String(plainStatus.stale)} error=${String(plainStatus.error).slice(0, 40)}`
  )
  check(
    '失败快照保留查询序号',
    plainStatus.sequence === 1,
    `sequence=${plainStatus.sequence}`
  )

  const plainDiff = await queryFileDiff('p', plainDir, 'note.txt', 'unstaged')
  check(
    '非仓库目录的差异查询报错',
    plainDiff.stale === true && plainDiff.error !== null,
    `stale=${String(plainDiff.stale)} error=${String(plainDiff.error).slice(0, 40)}`
  )
  check(
    '失败差异不伪装成「无变化」',
    plainDiff.hunks.length === 0 && plainDiff.error !== null,
    '有 error 且无 hunks'
  )

  const detected = await detectRepository(plainDir)
  check('非仓库目录被判定为不是仓库', detected === false, `detectRepository=${String(detected)}`)

  const missingDir = join(root, 'does-not-exist')
  const missingDetected = await detectRepository(missingDir)
  check(
    '不存在的目录被判定为不是仓库',
    missingDetected === false,
    `detectRepository=${String(missingDetected)}`
  )

  /* 无首次提交的仓库：不得因无 HEAD 而判为损坏 */
  const noHeadStatus = await queryGitStatus('p', noHeadRepo, 2)
  check(
    '无首次提交时状态查询成功',
    noHeadStatus.stale === false && noHeadStatus.error === null,
    `stale=${String(noHeadStatus.stale)} error=${String(noHeadStatus.error)}`
  )
  check(
    '无首次提交时仍能报告分支',
    typeof noHeadStatus.branch === 'string' && noHeadStatus.branch.length > 0,
    `branch=${String(noHeadStatus.branch)}`
  )
  check(
    '无首次提交时列出未跟踪文件',
    noHeadStatus.entries.some((entry) => entry.relativePath === 'first.txt'),
    noHeadStatus.entries.map((entry) => entry.relativePath).join(', ')
  )

  /* 项目外路径：拒绝且区分于「无差异」 */
  const outside = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: '../../etc/passwd',
    scope: 'unstaged'
  })
  check(
    '项目外路径被拒绝并给出原因',
    outside.stale === true && outside.error !== null,
    String(outside.error)
  )

  /* 不存在的文件：读取阶段明确报错 */
  const missingFile = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'missing.txt',
    scope: 'untracked'
  })
  check(
    '不存在的文件给出明确错误',
    missingFile.error !== null && missingFile.stale === true,
    String(missingFile.error)
  )

  /* 干净仓库：确实「无差异」时不得报错 */
  const cleanDiff = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'a.txt',
    scope: 'unstaged'
  })
  check(
    '确实无差异时不报错',
    cleanDiff.error === null &&
      cleanDiff.stale === false &&
      cleanDiff.status === 'unchanged' &&
      cleanDiff.hunks.length === 0,
    `status=${cleanDiff.status} error=${String(cleanDiff.error)}`
  )
}

async function main(): Promise<void> {
  buildFixtures()
  verifyWatchRules()
  await verifyDegradation()

  console.log('=== M2 验证（二）：失败降级与监听过滤 ===')
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  let passed = 0
  for (const item of CHECKS) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${CHECKS.length} 项通过`)

  if (keepFixture) console.log(`\n样例目录已保留：${root}`)
  else rmSync(root, { recursive: true, force: true })

  process.exit(passed === CHECKS.length ? 0 : 1)
}

main().catch((error) => {
  console.error('验证异常：', error)
  process.exit(1)
})
