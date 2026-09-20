/**
 * M3 文件操作验证：新建、复制/剪切粘贴、删除入口与批量失败报告。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-m3-file-ops.mts
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrashFn } from '../src/main/modules/file-access.ts'
import { createEntry, deleteEntries, transferEntries } from '../src/main/modules/file-access.ts'
import type { FileOperationBatchResult } from '../src/shared/types.ts'

const fixtureRoot = join(tmpdir(), 'workbench-m3-file-ops-fixture')
const projectDir = join(fixtureRoot, 'project')
const outsideDir = join(fixtureRoot, 'outside')
const targetDir = join(projectDir, 'target')
const linkPath = join(projectDir, 'outside-link')

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
  mkdirSync(join(projectDir, 'parent2'), { recursive: true })
  mkdirSync(join(projectDir, 'target2'), { recursive: true })
  mkdirSync(targetDir, { recursive: true })
  mkdirSync(join(projectDir, '.git'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(projectDir, 'alpha.txt'), 'alpha')
  writeFileSync(join(projectDir, 'beta.txt'), 'beta')
  writeFileSync(join(projectDir, 'move-me.txt'), 'move')
  writeFileSync(join(projectDir, 'remove-me.txt'), 'remove')
  writeFileSync(join(projectDir, 'busy.txt'), 'busy')
  writeFileSync(join(projectDir, 'folder', 'nested.txt'), 'nested')
  writeFileSync(join(projectDir, 'parent2', 'nested.txt'), 'nested')
  writeFileSync(join(projectDir, '.git', 'config'), '[core]')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
}

function detail(result: FileOperationBatchResult): string {
  return `ok=${result.ok} failed=${result.failed} skipped=${result.skipped} aborted=${String(result.aborted)} reason=${String(result.abortReason)}`
}

const workingTrash: TrashFn = async (absolutePath) => {
  rmSync(absolutePath, { recursive: true, force: true })
}

async function main(): Promise<void> {
  resetFixture()

  /* ---------- 1. 新建空文件与文件夹 ---------- */
  {
    const file = createEntry({
      projectRoot: projectDir,
      parentRelativePath: 'target',
      name: 'created.txt',
      kind: 'file',
      trusted: true
    })
    const folder = createEntry({
      projectRoot: projectDir,
      parentRelativePath: 'target',
      name: 'created-folder',
      kind: 'directory',
      trusted: true
    })
    check('新建空文件成功', file.ok === 1 && file.failed === 0, detail(file))
    check('新建空文件落盘', existsSync(join(targetDir, 'created.txt')), 'created.txt 存在')
    check('新建空文件夹成功', folder.ok === 1 && folder.failed === 0, detail(folder))
    check('新建空文件夹落盘', existsSync(join(targetDir, 'created-folder')), 'created-folder 存在')

    const conflict = createEntry({
      projectRoot: projectDir,
      parentRelativePath: 'target',
      name: 'created.txt',
      kind: 'file',
      trusted: true
    })
    check(
      '新建不覆盖同名目标',
      conflict.failed === 1 && conflict.items[0]?.reason === 'name-conflict',
      detail(conflict)
    )
  }

  /* ---------- 2. 复制文件与文件夹 ---------- */
  {
    const file = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['alpha.txt'],
      targetDirectory: 'target',
      mode: 'copy',
      trusted: true
    })
    check('复制文件成功', file.ok === 1 && file.failed === 0, detail(file))
    check(
      '复制文件保留源项',
      existsSync(join(projectDir, 'alpha.txt')) && existsSync(join(targetDir, 'alpha.txt')),
      '源与目标均存在'
    )

    const folder = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['folder'],
      targetDirectory: 'target',
      mode: 'copy',
      trusted: true
    })
    check('复制文件夹成功', folder.ok === 1 && folder.failed === 0, detail(folder))
    check('复制文件夹保留内容', existsSync(join(targetDir, 'folder', 'nested.txt')), 'nested.txt 存在')

    const conflict = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['alpha.txt'],
      targetDirectory: 'target',
      mode: 'copy',
      trusted: true
    })
    check('复制冲突不覆盖', conflict.failed === 1 && conflict.items[0]?.reason === 'name-conflict', detail(conflict))
    check('复制冲突保留目标内容', existsSync(join(targetDir, 'alpha.txt')), '目标文件仍在')
  }

  /* ---------- 3. 剪切粘贴 ---------- */
  {
    const moved = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['move-me.txt'],
      targetDirectory: 'target',
      mode: 'move',
      trusted: true
    })
    check('剪切粘贴成功', moved.ok === 1 && moved.failed === 0, detail(moved))
    check(
      '剪切粘贴移动源项',
      !existsSync(join(projectDir, 'move-me.txt')) && existsSync(join(targetDir, 'move-me.txt')),
      '源消失，目标存在'
    )
  }

  /* ---------- 4. 批量逐项失败报告 ---------- */
  {
    const partial = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['missing.txt', 'beta.txt', 'missing.txt'],
      targetDirectory: 'target',
      mode: 'copy',
      trusted: true
    })
    check('批量复制逐项报告失败', partial.failed === 1 && partial.ok === 1, detail(partial))
    check('批量复制去重并保留顺序', partial.items.length === 2, `项数=${partial.items.length}`)
    check(
      '批量复制同时保留成功与失败项',
      partial.items.some((item) => item.status === 'failed' && item.reason === 'not-found') &&
        partial.items.some((item) => item.status === 'ok'),
      partial.items.map((item) => `${item.relativePath}:${item.status}`).join(', ')
    )

    const nested = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['parent2/nested.txt', 'parent2'],
      targetDirectory: 'target2',
      mode: 'copy',
      trusted: true
    })
    check('重复选中父子项时跳过子项', nested.skipped === 1 && nested.ok === 1, detail(nested))
  }

  /* ---------- 5. 自身与重解析点保护 ---------- */
  {
    const self = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['folder'],
      targetDirectory: 'folder',
      mode: 'move',
      trusted: true
    })
    check('禁止移动文件夹到自身', self.failed === 1 && self.items[0]?.reason === 'invalid-path', detail(self))
    check('自移动未破坏源项', existsSync(join(projectDir, 'folder', 'nested.txt')), '源文件仍在')

    let linkCreated = true
    try {
      symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      linkCreated = false
    }
    if (linkCreated) {
      const linked = transferEntries({
        projectRoot: projectDir,
        relativePaths: ['outside-link'],
        targetDirectory: 'target',
        mode: 'copy',
        trusted: true
      })
      check(
        '拒绝经过目录联接复制',
        linked.failed === 1 &&
          (linked.items[0]?.reason === 'invalid-path' || linked.items[0]?.reason === 'outside-project'),
        detail(linked)
      )
      check('项目外源未被读取或复制', existsSync(join(outsideDir, 'secret.txt')), 'secret.txt 仍在外部目录')
    } else {
      check('目录联接复制保护用例', true, '当前环境无法创建测试目录联接，已跳过')
    }
  }

  /* ---------- 6. 删除与回收站批量失败 ---------- */
  {
    const selectiveTrash: TrashFn = async (absolutePath) => {
      if (absolutePath.endsWith('busy.txt')) {
        throw Object.assign(new Error('EBUSY: locked'), { code: 'EBUSY' })
      }
      await workingTrash(absolutePath)
    }
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['remove-me.txt', 'busy.txt', 'missing.txt'],
      trusted: true,
      trash: selectiveTrash
    })
    check('删除批量逐项报告成功与失败', result.ok === 1 && result.failed === 2 && !result.aborted, detail(result))
    check('删除成功项进入回收站替身', !existsSync(join(projectDir, 'remove-me.txt')), 'remove-me.txt 已移除')
    check('删除失败项保留源文件', existsSync(join(projectDir, 'busy.txt')), 'busy.txt 仍在')
    check(
      '删除不存在项明确为 not-found',
      result.items.find((item) => item.relativePath === 'missing.txt')?.reason === 'not-found',
      'reason=not-found'
    )
  }

  /* ---------- 7. 回收站不可用整批中止 ---------- */
  {
    writeFileSync(join(projectDir, 'trash-a.txt'), 'a')
    writeFileSync(join(projectDir, 'trash-b.txt'), 'b')
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['trash-a.txt', 'trash-b.txt'],
      trusted: true,
      trash: async () => {
        throw new Error('Failed to move item to trash')
      }
    })
    check('回收站不可用时中止删除', result.aborted && result.abortReason === 'trash-unavailable', detail(result))
    check(
      '回收站不可用不永久删除',
      existsSync(join(projectDir, 'trash-a.txt')) && existsSync(join(projectDir, 'trash-b.txt')),
      '两个源文件均保留'
    )
  }

  /* ---------- 8. 信任与保护项 ---------- */
  {
    const create = createEntry({
      projectRoot: projectDir,
      parentRelativePath: '',
      name: 'untrusted.txt',
      kind: 'file',
      trusted: false
    })
    const transfer = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['alpha.txt'],
      targetDirectory: '',
      mode: 'copy',
      trusted: false
    })
    const deletion = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['alpha.txt'],
      trusted: false,
      trash: workingTrash
    })
    check('不可信项目拒绝新建', create.aborted && create.abortReason === 'untrusted-project', detail(create))
    check('不可信项目拒绝复制', transfer.aborted && transfer.abortReason === 'untrusted-project', detail(transfer))
    check('不可信项目拒绝删除', deletion.aborted && deletion.abortReason === 'untrusted-project', detail(deletion))
    check('保护项未被删除', existsSync(join(projectDir, '.git', 'config')), '.git/config 仍在')
  }

  console.log('=== M3 文件操作验证：新建、复制/剪切粘贴、删除与批量报告 ===')
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

main().catch((error) => {
  console.error('验证异常：', error)
  removeFixture()
  process.exit(1)
})
