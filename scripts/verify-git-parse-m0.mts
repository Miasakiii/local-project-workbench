/**
 * M0-6 技术验证（一）：porcelain v2 + NUL 解析。
 *
 * 覆盖：中文名、含空格路径、四分组、同一文件双重状态、重命名原路径。
 *
 * 用法：node --experimental-strip-types scripts/verify-git-parse-m0.mts
 */

import { countByGroup, countUniqueFiles, parsePorcelainV2 } from '../src/main/modules/git-parse.ts'

const records = [
  '# branch.oid abc123def456',
  '# branch.head main',
  '1 .M N... 100644 100644 100644 aaa bbb 普通 文件.txt',
  '1 M. N... 100644 100644 100644 aaa bbb 已暂存.txt',
  '1 MM N... 100644 100644 100644 aaa bbb 双重状态.txt',
  '? 未跟踪 文件.md',
  '2 R. N... 100644 100644 100644 aaa bbb R100 新名字.txt',
  '旧名字.txt',
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc 冲突.txt',
  ''
]

const { branch, entries } = parsePorcelainV2(Buffer.from(records.join('\0'), 'utf8'))
const find = (path: string, group: string): boolean =>
  entries.some((entry) => entry.relativePath === path && entry.group === group)

const checks: Array<[string, boolean, string]> = [
  ['分支名解析', branch === 'main', `branch=${String(branch)}`],
  ['含空格的中文路径', find('普通 文件.txt', 'unstaged'), '普通 文件.txt → unstaged'],
  ['已暂存分组', find('已暂存.txt', 'staged'), '已暂存.txt → staged'],
  [
    '同一文件双重状态',
    find('双重状态.txt', 'staged') && find('双重状态.txt', 'unstaged'),
    'staged 与 unstaged 各一条'
  ],
  ['未跟踪分组', find('未跟踪 文件.md', 'untracked'), '未跟踪 文件.md → untracked'],
  ['冲突分组', find('冲突.txt', 'conflicted'), '冲突.txt → conflicted'],
  [
    '重命名保留原路径',
    entries.find((e) => e.relativePath === '新名字.txt')?.originalPath === '旧名字.txt',
    `originalPath=${entries.find((e) => e.relativePath === '新名字.txt')?.originalPath ?? '未取到'}`
  ]
]

const counts = countByGroup(entries)
checks.push([
  '分组统计',
  counts.staged === 3 && counts.unstaged === 2 && counts.untracked === 1 && counts.conflicted === 1,
  `staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked} conflicted=${counts.conflicted}`
])
checks.push(['去重文件数', countUniqueFiles(entries) === 6, `unique=${countUniqueFiles(entries)}`])

console.log('=== M0-6 验证（一）：porcelain v2 解析 ===\n')
let allPass = true
for (const [name, pass, detail] of checks) {
  console.log(`${pass ? '[通过]' : '[失败]'} ${name} — ${detail}`)
  if (!pass) allPass = false
}
console.log(allPass ? '\n结论：解析全部通过' : '\n结论：存在失败项')
process.exit(allPass ? 0 : 1)
