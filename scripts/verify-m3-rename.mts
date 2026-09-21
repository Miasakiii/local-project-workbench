/**
 * M3-1 验证：同一父目录内的单点重命名。
 *
 * 验证目标：
 *   1. 文件与文件夹均可在项目内安全重命名
 *   2. 不覆盖已有目标，冲突逐项报告
 *   3. 不可信项目、项目根与 .git 元数据保持只读
 *   4. 非法名称、路径穿越与经过重解析点的写操作被拒绝
 *   5. 源项不存在或磁盘状态变化时不误报成功
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-m3-rename.mts
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameEntry } from '../src/main/modules/file-access.ts'
import type { RenameEntryResult } from '../src/shared/types.ts'

const fixtureRoot = join(tmpdir(), 'workbench-m3-rename-fixture')
const projectDir = join(fixtureRoot, 'project')
const outsideDir = join(fixtureRoot, 'outside')
const linkPath = join(projectDir, 'link-dir')

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

function removeFixture(): void {
  try {
    rmSync(linkPath, { recursive: true, force: true })
  } catch {
    // 链接可能尚未创建
  }
  rmSync(fixtureRoot, { recursive: true, force: true })
}

function resetFixture(): void {
  removeFixture()
  mkdirSync(join(projectDir, 'folder'), { recursive: true })
  mkdirSync(join(projectDir, '.git'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(projectDir, 'source.txt'), 'source')
  writeFileSync(join(projectDir, 'same-name.txt'), 'same')
  writeFileSync(join(projectDir, 'folder', 'nested.txt'), 'nested')
  writeFileSync(join(projectDir, '.git', 'config'), '[core]')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
}

function resultDetail(result: RenameEntryResult): string {
  return `status=${result.status} reason=${String(result.reason)} source=${result.relativePath} target=${String(result.targetRelativePath)}`
}

function runRename(relativePath: string, newName: string, trusted = true): RenameEntryResult {
  return renameEntry({ projectRoot: projectDir, relativePath, newName, trusted })
}

function main(): void {
  resetFixture()

  /* ---------- 1. 文件正常重命名 ---------- */
  {
    const result = runRename('source.txt', 'renamed.txt')
    check('文件重命名成功', result.status === 'ok' && result.targetRelativePath === 'renamed.txt', resultDetail(result))
    check(
      '文件重命名后的磁盘状态正确',
      !existsSync(join(projectDir, 'source.txt')) && existsSync(join(projectDir, 'renamed.txt')),
      '源文件消失，目标文件存在'
    )
  }

  /* ---------- 2. 文件夹正常重命名 ---------- */
  {
    const result = runRename('folder', 'renamed-folder')
    check(
      '文件夹重命名成功',
      result.status === 'ok' && result.targetRelativePath === 'renamed-folder',
      resultDetail(result)
    )
    check(
      '文件夹内容保持不变',
      existsSync(join(projectDir, 'renamed-folder', 'nested.txt')) &&
        !existsSync(join(projectDir, 'folder', 'nested.txt')),
      '子文件随文件夹保留'
    )
  }

  /* ---------- 3. 同名冲突不覆盖 ---------- */
  {
    const result = runRename('same-name.txt', 'renamed.txt')
    check('目标冲突被拒绝', result.status === 'failed' && result.reason === 'name-conflict', resultDetail(result))
    check(
      '冲突时源与目标均保留',
      existsSync(join(projectDir, 'same-name.txt')) && existsSync(join(projectDir, 'renamed.txt')),
      '未发生静默覆盖'
    )
  }

  /* ---------- 4. 不可信项目保持只读 ---------- */
  {
    const result = runRename('same-name.txt', 'untrusted.txt', false)
    check(
      '不可信项目拒绝重命名',
      result.status === 'skipped' && result.reason === 'untrusted-project',
      resultDetail(result)
    )
    check('不可信项目源文件未改变', existsSync(join(projectDir, 'same-name.txt')), '源文件仍在')
  }

  /* ---------- 5. 受保护项 ---------- */
  {
    const root = runRename('', 'renamed-root')
    const git = runRename('.git/config', 'renamed-config')
    const toGit = runRename('same-name.txt', '.git')
    check('项目根不提供重命名', root.status === 'skipped' && root.reason === 'protected-entry', resultDetail(root))
    check('.git 元数据不提供重命名', git.status === 'skipped' && git.reason === 'protected-entry', resultDetail(git))
    check('不能重命名为 .git', toGit.status === 'skipped' && toGit.reason === 'protected-entry', resultDetail(toGit))
    // 归一化绕过回归：原始输入首段不是 .git，折叠 `..` 之后才是
    const escaped = runRename('folder/../.git/config', 'renamed-config')
    check(
      '经 .. 归一化到 .git 不提供重命名',
      escaped.status === 'skipped' && escaped.reason === 'protected-entry',
      resultDetail(escaped)
    )
    check('受保护项未被修改', existsSync(join(projectDir, '.git', 'config')), 'Git 配置仍在')
  }

  /* ---------- 6. 非法名称与路径穿越 ---------- */
  {
    const cases = [
      ['', '空名称'],
      ['../outside.txt', '路径穿越写法'],
      ['nested/name.txt', '跨目录写法'],
      ['nested\\name.txt', '反斜杠跨目录写法']
    ] as const
    for (const [name, label] of cases) {
      const result = runRename('same-name.txt', name)
      check(label, result.status === 'failed' && result.reason === 'invalid-path', resultDetail(result))
    }
    check('非法名称未产生新文件', !existsSync(join(projectDir, 'outside.txt')), '项目内未出现越界目标')
  }

  /* ---------- 7. 源项不存在 ---------- */
  {
    const result = runRename('missing.txt', 'new.txt')
    check('源项不存在时明确失败', result.status === 'failed' && result.reason === 'not-found', resultDetail(result))
  }

  /* ---------- 8. 经过项目内联接的写操作拒绝 ---------- */
  {
    let linkCreated = true
    try {
      symlinkSync(join(projectDir, 'renamed-folder'), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      linkCreated = false
      console.log(
        `跳过重解析点用例：当前环境无法创建目录联接（${error instanceof Error ? error.message : String(error)}）`
      )
    }

    if (linkCreated) {
      const result = runRename('link-dir', 'link-renamed')
      check(
        '经过目录联接的写操作被拒绝',
        result.status === 'failed' && result.reason === 'invalid-path',
        resultDetail(result)
      )
      check('目录联接目标未被误重命名', existsSync(join(projectDir, 'renamed-folder')), '真实目录仍在原处')
      check('目录联接入口未被重命名', existsSync(linkPath), '链接入口仍在原处')
    } else {
      check('重解析点写操作用例', true, '环境不支持创建测试目录联接，已跳过')
    }
  }

  /* ---------- 输出 ---------- */
  console.log('=== M3-1 验证：同一父目录内的单点重命名 ===')
  console.log(`样例目录：${fixtureRoot}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${checks.length} 项通过`)

  removeFixture()
  process.exit(passed === checks.length ? 0 : 1)
}

main()
