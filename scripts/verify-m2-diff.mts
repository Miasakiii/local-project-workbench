/**
 * M2 验证（一）：只读差异解析与查询。
 *
 * 覆盖：
 *   1. 统一差异解析（多 hunk、省略行数的标题、二进制、新增/删除/重命名、无换行结尾）
 *   2. 未跟踪文件的「无基线」合成差异
 *   3. 真实仓库：未暂存／已暂存／未跟踪／删除／二进制／无 HEAD
 *   4. 只读性：查询前后工作区与索引状态不变
 *   5. 失败与「无差异」可区分
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-m2-diff.mts
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileDiff, MAX_DIFF_LINES } from '../src/main/modules/diff-service.ts'
import { parseUnifiedDiff, synthesizeAddedDiff } from '../src/main/modules/git-diff-parse.ts'

const keepFixture = process.argv.includes('--keep')
const root = join(tmpdir(), 'workbench-m2-diff')
const repo = join(root, 'repo')
const noHeadRepo = join(root, 'no-head-repo')

const CHECKS: Array<{ name: string; pass: boolean; detail: string }> = []
function check(name: string, pass: boolean, detail: string): void {
  CHECKS.push({ name, pass, detail })
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function statusOf(cwd: string): string {
  return git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
}

function buildFixtures(): void {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  mkdirSync(noHeadRepo, { recursive: true })

  git(repo, ['init', '--quiet'])
  git(repo, ['config', 'user.email', 'verify@example.com'])
  git(repo, ['config', 'user.name', 'verify'])
  git(repo, ['config', 'core.autocrlf', 'false'])

  writeFileSync(join(repo, '普通 文件.txt'), ['第一行', '第二行', '第三行', '第四行', '第五行', ''].join('\n'), 'utf8')
  writeFileSync(join(repo, 'to-delete.txt'), 'will be deleted\n', 'utf8')
  writeFileSync(join(repo, 'binary.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]))
  writeFileSync(join(repo, 'old-name.txt'), 'renamed content\n', 'utf8')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', '初始提交'])

  // 未暂存：修改中间两行
  writeFileSync(
    join(repo, '普通 文件.txt'),
    ['第一行', '第二行已改', '第三行', '新增行', '第四行', '第五行', ''].join('\n'),
    'utf8'
  )
  // 已暂存：另建文件并暂存
  writeFileSync(join(repo, 'staged.txt'), '暂存内容\n', 'utf8')
  git(repo, ['add', 'staged.txt'])
  // 未跟踪
  writeFileSync(join(repo, 'untracked.txt'), ['a', 'b', 'c', ''].join('\n'), 'utf8')
  // 删除
  rmSync(join(repo, 'to-delete.txt'))
  // 二进制修改
  writeFileSync(join(repo, 'binary.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]))
  // 重命名
  git(repo, ['mv', 'old-name.txt', 'new-name.txt'])
  // 超大未跟踪文件
  const huge = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, index) => `line ${index}`).join('\n')
  writeFileSync(join(repo, 'huge.txt'), `${huge}\n`, 'utf8')

  git(noHeadRepo, ['init', '--quiet'])
  git(noHeadRepo, ['config', 'user.email', 'verify@example.com'])
  git(noHeadRepo, ['config', 'user.name', 'verify'])
  writeFileSync(join(noHeadRepo, 'first.txt'), 'first content\n', 'utf8')
  git(noHeadRepo, ['add', 'first.txt'])
}

/* ---------- 一、解析层 ---------- */

function verifyParser(): void {
  const basic = parseUnifiedDiff(
    [
      'diff --git a/x.txt b/x.txt',
      'index 111..222 100644',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,4 +1,5 @@ 说明文字',
      ' 第一行',
      '-第二行',
      '+第二行已改',
      ' 第三行',
      '+新增行',
      ' 第四行',
      ''
    ].join('\n')
  )

  check('解析出单个 hunk', basic.hunks.length === 1, `hunks=${basic.hunks.length}`)
  check(
    'hunk 起止行号解析正确',
    basic.hunks[0]?.oldStart === 1 &&
      basic.hunks[0]?.oldCount === 4 &&
      basic.hunks[0]?.newStart === 1 &&
      basic.hunks[0]?.newCount === 5,
    `old=${String(basic.hunks[0]?.oldStart)},${String(basic.hunks[0]?.oldCount)} new=${String(basic.hunks[0]?.newStart)},${String(basic.hunks[0]?.newCount)}`
  )
  check(
    '增删行统计正确',
    basic.addedLines === 2 && basic.removedLines === 1,
    `+${basic.addedLines} -${basic.removedLines}`
  )

  const lines = basic.hunks[0]?.lines ?? []
  check(
    '上下文行同时具有新旧行号',
    lines[0]?.kind === 'context' && lines[0]?.oldLine === 1 && lines[0]?.newLine === 1,
    `kind=${String(lines[0]?.kind)} old=${String(lines[0]?.oldLine)} new=${String(lines[0]?.newLine)}`
  )
  const removed = lines.find((line) => line.kind === 'remove')
  check(
    '删除行只有旧行号',
    removed?.oldLine === 2 && removed?.newLine === null,
    `old=${String(removed?.oldLine)} new=${String(removed?.newLine)}`
  )
  const added = lines.find((line) => line.kind === 'add')
  check(
    '新增行只有新行号',
    added?.oldLine === null && added?.newLine === 2,
    `old=${String(added?.oldLine)} new=${String(added?.newLine)}`
  )
  check(
    '上下文行新行号按增删正确位移',
    lines
      .filter((line) => line.kind === 'context')
      .map((line) => line.newLine)
      .join(',') === '1,3,5',
    lines
      .filter((line) => line.kind === 'context')
      .map((line) => line.newLine)
      .join(',')
  )
  check('尾随空行不产生多余行', lines.length === 6, `行数=${lines.length}（3 上下文 + 1 删除 + 2 新增）`)

  const multi = parseUnifiedDiff(
    ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -10,2 +10,3 @@', ' j', '+k', ' l', ''].join('\n')
  )
  check('解析多个 hunk', multi.hunks.length === 2, `hunks=${multi.hunks.length}`)
  check(
    '第二个 hunk 行号独立',
    multi.hunks[1]?.oldStart === 10 && multi.hunks[1]?.newStart === 10,
    `old=${String(multi.hunks[1]?.oldStart)} new=${String(multi.hunks[1]?.newStart)}`
  )

  const shortHeader = parseUnifiedDiff(['@@ -1 +1 @@', '-x', '+y', ''].join('\n'))
  check(
    '省略行数的 hunk 标题按 1 行处理',
    shortHeader.hunks[0]?.oldCount === 1 && shortHeader.hunks[0]?.newCount === 1,
    `oldCount=${String(shortHeader.hunks[0]?.oldCount)} newCount=${String(shortHeader.hunks[0]?.newCount)}`
  )

  const newFile = parseUnifiedDiff(['new file mode 100644', '@@ -0,0 +1,2 @@', '+a', '+b', ''].join('\n'))
  check('识别新增文件', newFile.status === 'added', `status=${newFile.status}`)

  const deleted = parseUnifiedDiff(['deleted file mode 100644', '@@ -1,2 +0,0 @@', '-a', '-b', ''].join('\n'))
  check('识别删除文件', deleted.status === 'deleted', `status=${deleted.status}`)

  const renamed = parseUnifiedDiff(['rename from 旧名字.txt', 'rename to 新名字.txt', ''].join('\n'))
  check(
    '识别重命名并保留原路径',
    renamed.status === 'renamed' && renamed.originalPath === '旧名字.txt',
    `status=${renamed.status} original=${String(renamed.originalPath)}`
  )

  const binary = parseUnifiedDiff(['Binary files a/x.png and b/x.png differ', ''].join('\n'))
  check('识别二进制差异', binary.binary === true, `binary=${String(binary.binary)}`)

  const gitBinary = parseUnifiedDiff(['GIT binary patch', 'literal 12', ''].join('\n'))
  check('识别 GIT binary patch', gitBinary.binary === true, `binary=${String(gitBinary.binary)}`)

  const noNewline = parseUnifiedDiff(['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', ''].join('\n'))
  const metaLine = noNewline.hunks[0]?.lines.find((line) => line.kind === 'meta')
  check(
    '无换行结尾标记归为元信息',
    metaLine !== undefined && metaLine.oldLine === null && metaLine.newLine === null,
    `meta=${String(metaLine?.text)}`
  )

  const empty = parseUnifiedDiff('')
  check('空输入表示无差异', empty.status === 'unchanged' && empty.hunks.length === 0, `status=${empty.status}`)

  const onlyHeader = parseUnifiedDiff(['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', ''].join('\n'))
  check('只有文件头表示无差异', onlyHeader.status === 'unchanged', `status=${onlyHeader.status}`)

  /* ---------- 合成未跟踪差异 ---------- */

  const synthesized = synthesizeAddedDiff('a\nb\nc\n')
  check(
    '合成未跟踪差异为全新增',
    synthesized.status === 'added' &&
      synthesized.addedLines === 3 &&
      synthesized.hunks[0]?.lines.every((line) => line.kind === 'add'),
    `+${synthesized.addedLines} hunks=${synthesized.hunks.length}`
  )
  check(
    '合成差异不因结尾换行多出一行',
    synthesized.hunks[0]?.lines.length === 3 && synthesized.hunks[0]?.lines[2]?.newLine === 3,
    `行数=${String(synthesized.hunks[0]?.lines.length)}`
  )
  const emptyContent = synthesizeAddedDiff('')
  check('空文件不产生 hunk', emptyContent.hunks.length === 0, `hunks=${emptyContent.hunks.length}`)
}

/* ---------- 二、真实仓库 ---------- */

async function verifyRepository(): Promise<void> {
  const before = statusOf(repo)

  const unstaged = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: '普通 文件.txt',
    scope: 'unstaged'
  })
  check(
    '未暂存差异可读取（含空格与中文路径）',
    unstaged.error === null && unstaged.stale === false && unstaged.addedLines === 2 && unstaged.removedLines === 1,
    `+${unstaged.addedLines} -${unstaged.removedLines} error=${String(unstaged.error)}`
  )
  check(
    '未暂存差异的 scope 正确',
    unstaged.scope === 'unstaged' && unstaged.noBaseline === false,
    `scope=${unstaged.scope}`
  )

  const staged = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'staged.txt',
    scope: 'staged'
  })
  check(
    '已暂存差异可读取',
    staged.error === null && staged.addedLines === 1 && staged.status === 'added',
    `+${staged.addedLines} status=${staged.status}`
  )

  const untracked = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'untracked.txt',
    scope: 'untracked'
  })
  check(
    '未跟踪文件标注无历史基线',
    untracked.noBaseline === true && untracked.status === 'added' && untracked.addedLines === 3,
    `noBaseline=${String(untracked.noBaseline)} +${untracked.addedLines}`
  )

  const deleted = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'to-delete.txt',
    scope: 'unstaged'
  })
  check(
    '删除文件的差异可读取',
    deleted.error === null && deleted.status === 'deleted' && deleted.removedLines === 1,
    `status=${deleted.status} -${deleted.removedLines}`
  )

  const renamed = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'new-name.txt',
    scope: 'staged',
    originalPath: 'old-name.txt'
  })
  check(
    '重命名按 Git 检测结果显示',
    renamed.status === 'renamed' && renamed.originalPath === 'old-name.txt',
    `status=${renamed.status} original=${String(renamed.originalPath)}`
  )

  const binary = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'binary.png',
    scope: 'unstaged'
  })
  check(
    '二进制文件不提供逐行差异',
    binary.error === null && binary.binary === true && binary.hunks.length === 0,
    `binary=${String(binary.binary)} hunks=${binary.hunks.length}`
  )

  const huge = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: 'huge.txt',
    scope: 'untracked'
  })
  check(
    '超大差异被截断并告知',
    huge.truncated === true && huge.hunks[0] !== undefined && huge.hunks[0].lines.length <= MAX_DIFF_LINES,
    `truncated=${String(huge.truncated)} 行数=${String(huge.hunks[0]?.lines.length)}`
  )

  const outside = await fileDiff({
    projectId: 'p',
    projectRoot: repo,
    relativePath: '../outside.txt',
    scope: 'unstaged'
  })
  check(
    '项目外路径被拒绝且区分于「无差异」',
    outside.stale === true && outside.error !== null && outside.hunks.length === 0,
    `stale=${String(outside.stale)} error=${String(outside.error)}`
  )

  const after = statusOf(repo)
  check('差异查询不修改工作区与索引', before === after, before === after ? '状态未变' : '状态发生变化')

  /* ---------- 无 HEAD 仓库 ---------- */

  const noHeadStaged = await fileDiff({
    projectId: 'p',
    projectRoot: noHeadRepo,
    relativePath: 'first.txt',
    scope: 'staged'
  })
  check(
    '无首次提交时已暂存差异仍可读取',
    noHeadStaged.error === null && noHeadStaged.stale === false && noHeadStaged.addedLines === 1,
    `error=${String(noHeadStaged.error)} +${noHeadStaged.addedLines}`
  )

  /* ---------- 非仓库目录 ---------- */

  const notRepo = join(root, 'not-a-repo')
  mkdirSync(notRepo, { recursive: true })
  writeFileSync(join(notRepo, 'a.txt'), 'a\n', 'utf8')
  const notRepoDiff = await fileDiff({
    projectId: 'p',
    projectRoot: notRepo,
    relativePath: 'a.txt',
    scope: 'untracked'
  })
  check(
    '非仓库目录的未跟踪文件仍可合成差异',
    notRepoDiff.error === null && notRepoDiff.noBaseline === true && notRepoDiff.addedLines === 1,
    `error=${String(notRepoDiff.error)} +${notRepoDiff.addedLines}`
  )
}

async function main(): Promise<void> {
  buildFixtures()
  verifyParser()
  await verifyRepository()

  console.log('=== M2 验证（一）：只读差异解析与查询 ===')
  console.log(`样例仓库：${repo}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}`)
  console.log(`Git：${git(repo, ['--version']).trim()}\n`)

  let passed = 0
  for (const item of CHECKS) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${CHECKS.length} 项通过`)

  if (keepFixture) console.log(`\n样例仓库已保留：${root}`)
  else rmSync(root, { recursive: true, force: true })

  process.exit(passed === CHECKS.length ? 0 : 1)
}

main().catch((error) => {
  console.error('验证异常：', error)
  process.exit(1)
})
