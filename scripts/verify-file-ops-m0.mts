/**
 * M0-5 技术验证（一）：删除语义与失败处理（纯 Node，注入回收站能力）。
 *
 * 验证目标（推进计划 M0-5 退出条件 + 设计稿第 7 章）：
 *   1. 删除一律走回收站
 *   2. 回收站不可用时停止并说明，**不降级为永久删除**（源文件必须仍在）
 *   3. 项级失败（无权限、被占用）逐项报告且不中断后续项
 *   4. 项目根与 .git 元数据不提供删除
 *   5. 路径穿越与经目录联接指向项目外的目标被拒绝
 *   6. 不可信项目默认只读，写操作整体拒绝
 *
 * 真实 `shell.trashItem` 的行为由 verify-trash-real-m0.cjs 在 Electron 下验证。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-loader/register.mjs scripts/verify-file-ops-m0.mts
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyError,
  deleteEntries,
  discriminateTrashFailure,
  probeTrashAvailability,
  type TrashFn
} from '../src/main/modules/file-access.ts'
import type { DeleteEntriesResult } from '../src/shared/types.ts'

const keepFixture = process.argv.includes('--keep')
const fixtureRoot = join(tmpdir(), 'workbench-m0-5-fixture')
const projectDir = join(fixtureRoot, 'project')
const outsideDir = join(fixtureRoot, 'outside')

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

/** 真实删除的替身：直接移除目标，使「磁盘确认」环节可以通过。 */
const workingTrash: TrashFn = async (absolutePath) => {
  rmSync(absolutePath, { recursive: true, force: true })
}

function resetFixture(): void {
  rmSync(fixtureRoot, { recursive: true, force: true })
  mkdirSync(join(projectDir, 'dir'), { recursive: true })
  mkdirSync(join(projectDir, '.git'), { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  writeFileSync(join(projectDir, 'a.txt'), 'a')
  writeFileSync(join(projectDir, 'b.txt'), 'b')
  writeFileSync(join(projectDir, 'dir', 'c.txt'), 'c')
  writeFileSync(join(projectDir, 'dir', 'd.txt'), 'd')
  writeFileSync(join(projectDir, '.git', 'config'), '[core]')
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')

  symlinkSync(outsideDir, join(projectDir, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
}

function itemOf(result: DeleteEntriesResult, relativePath: string): DeleteEntriesResult['items'][number] | undefined {
  return result.items.find((item) => item.relativePath === relativePath)
}

async function main(): Promise<void> {
  resetFixture()

  /* ---------- 1. 正常批量删除 ---------- */
  {
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['a.txt', 'dir/c.txt'],
      trusted: true,
      trash: workingTrash
    })
    check(
      '批量删除逐项成功',
      result.ok === 2 && result.failed === 0 && !result.aborted,
      `ok=${result.ok} failed=${result.failed} skipped=${result.skipped}`
    )
    check(
      '删除后目标确实不存在',
      !existsSync(join(projectDir, 'a.txt')) && !existsSync(join(projectDir, 'dir', 'c.txt')),
      '磁盘确认通过'
    )
  }

  /* ---------- 2. 回收站不可用：停止且不永久删除 ---------- */
  {
    resetFixture()
    const unavailableTrash: TrashFn = async () => {
      throw new Error('Failed to move item to trash')
    }
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['a.txt', 'b.txt', 'dir/d.txt'],
      trusted: true,
      trash: unavailableTrash
    })
    check(
      '回收站不可用时整批中止',
      result.aborted === true && result.abortReason === 'trash-unavailable',
      `aborted=${String(result.aborted)} reason=${String(result.abortReason)}`
    )
    check('中止时给出说明', (result.abortMessage ?? '').includes('回收站'), String(result.abortMessage))
    check(
      '未执行的项标记为 skipped',
      result.items.filter((item) => item.status === 'skipped').length === 2,
      `skipped=${result.skipped}`
    )
    check(
      '不降级为永久删除（源文件全部保留）',
      existsSync(join(projectDir, 'a.txt')) &&
        existsSync(join(projectDir, 'b.txt')) &&
        existsSync(join(projectDir, 'dir', 'd.txt')),
      '三个源文件均仍在'
    )
  }

  /* ---------- 3. 项级失败不中断后续项 ---------- */
  {
    resetFixture()
    const selectiveTrash: TrashFn = async (absolutePath) => {
      if (absolutePath.endsWith('b.txt')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      rmSync(absolutePath, { recursive: true, force: true })
    }
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['a.txt', 'b.txt', 'dir/c.txt'],
      trusted: true,
      trash: selectiveTrash
    })
    check(
      '无权限项按项失败且其余继续',
      result.ok === 2 && result.failed === 1 && !result.aborted,
      `ok=${result.ok} failed=${result.failed}`
    )
    check(
      '无权限项归类为 permission-denied',
      itemOf(result, 'b.txt')?.reason === 'permission-denied',
      `reason=${String(itemOf(result, 'b.txt')?.reason)}`
    )
    check('失败项保留源文件', existsSync(join(projectDir, 'b.txt')), 'b.txt 仍在')
    check(
      '失败说明保留源文件语义',
      (itemOf(result, 'b.txt')?.message ?? '').includes('源文件已保留'),
      String(itemOf(result, 'b.txt')?.message)
    )
  }

  /* ---------- 4. 被占用 ---------- */
  {
    resetFixture()
    const busyTrash: TrashFn = async () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['a.txt'],
      trusted: true,
      trash: busyTrash
    })
    check(
      '被占用归类为 in-use',
      itemOf(result, 'a.txt')?.reason === 'in-use',
      `reason=${String(itemOf(result, 'a.txt')?.reason)}`
    )
  }

  /* ---------- 5. 受保护项与非法路径 ---------- */
  {
    resetFixture()
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['', '.git', '.git/config', '../outside/secret.txt', 'junction/secret.txt', 'missing.txt'],
      trusted: true,
      trash: workingTrash
    })
    check(
      '项目根不提供删除',
      itemOf(result, '')?.status === 'skipped' && itemOf(result, '')?.reason === 'protected-entry',
      `status=${String(itemOf(result, '')?.status)}`
    )
    check(
      '.git 元数据不提供删除',
      itemOf(result, '.git')?.reason === 'protected-entry' &&
        itemOf(result, '.git/config')?.reason === 'protected-entry',
      '两项均 skipped'
    )
    check(
      '路径穿越被拒绝',
      itemOf(result, '../outside/secret.txt')?.reason === 'outside-project',
      `reason=${String(itemOf(result, '../outside/secret.txt')?.reason)}`
    )
    check(
      '经目录联接指向项目外被拒绝',
      itemOf(result, 'junction/secret.txt')?.reason === 'outside-project',
      `reason=${String(itemOf(result, 'junction/secret.txt')?.reason)}`
    )
    check('不存在的目标归类为 not-found', itemOf(result, 'missing.txt')?.reason === 'not-found', 'reason=not-found')
    check(
      '项目外文件未被删除',
      existsSync(join(outsideDir, 'secret.txt')) && existsSync(join(projectDir, '.git', 'config')),
      '项目外与元数据均保留'
    )
  }

  /* ---------- 6. 不可信项目默认只读 ---------- */
  {
    resetFixture()
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['a.txt'],
      trusted: false,
      trash: workingTrash
    })
    check(
      '不可信项目整体拒绝写操作',
      result.aborted === true && result.abortReason === 'untrusted-project' && result.items.length === 0,
      `aborted=${String(result.aborted)} reason=${String(result.abortReason)}`
    )
    check('不可信项目未执行任何删除', existsSync(join(projectDir, 'a.txt')), 'a.txt 仍在')
  }

  /* ---------- 7. 边界输入 ---------- */
  {
    const empty = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: [],
      trusted: true,
      trash: workingTrash
    })
    check('空列表明确拒绝', empty.aborted === true, `abortReason=${String(empty.abortReason)}`)

    const oversized = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: Array.from({ length: 501 }, (_, index) => `f${index}.txt`),
      trusted: true,
      trash: workingTrash
    })
    check(
      '超出批量上限时拒绝执行',
      oversized.aborted === true && (oversized.abortMessage ?? '').includes('分批'),
      String(oversized.abortMessage)
    )
  }

  /* ---------- 8. 去重 ---------- */
  {
    resetFixture()
    let calls = 0
    const countingTrash: TrashFn = async (absolutePath) => {
      calls += 1
      rmSync(absolutePath, { recursive: true, force: true })
    }
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['a.txt', 'a.txt', 'a.txt'],
      trusted: true,
      trash: countingTrash
    })
    check(
      '重复路径只处理一次',
      calls === 1 && result.items.length === 1,
      `trash 调用=${calls} 项数=${result.items.length}`
    )
  }

  /* ---------- 9. 磁盘确认 ---------- */
  {
    resetFixture()
    const lyingTrash: TrashFn = async () => {
      // 假装成功，但目标仍然存在
    }
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['a.txt'],
      trusted: true,
      trash: lyingTrash
    })
    check(
      '回收站返回但目标仍在时判为失败',
      itemOf(result, 'a.txt')?.status === 'failed' && itemOf(result, 'a.txt')?.reason === 'io-error',
      `status=${String(itemOf(result, 'a.txt')?.status)}`
    )
  }

  /* ---------- 10. 错误分类与可用性判定 ---------- */
  {
    const cases: Array<[unknown, string]> = [
      [Object.assign(new Error('x'), { code: 'ENOENT' }), 'not-found'],
      [Object.assign(new Error('x'), { code: 'EACCES' }), 'permission-denied'],
      [Object.assign(new Error('x'), { code: 'EPERM' }), 'permission-denied'],
      [Object.assign(new Error('x'), { code: 'EBUSY' }), 'in-use'],
      [Object.assign(new Error('x'), { code: 'ENOTEMPTY' }), 'in-use'],
      [Object.assign(new Error('x'), { code: 'EROFS' }), 'read-only'],
      [new Error('unknown'), 'io-error']
    ]
    for (const [error, expected] of cases) {
      check(
        `错误分类 ${String((error as { code?: string }).code ?? '无码')}`,
        classifyError(error).reason === expected,
        `→ ${classifyError(error).reason}`
      )
    }

    check(
      '不支持提示判为不可用',
      discriminateTrashFailure(join(projectDir, 'a.txt'), new Error('not supported')).abort === true,
      '→ abort'
    )
    check(
      'EPERM 判为项级问题',
      discriminateTrashFailure(join(projectDir, 'a.txt'), Object.assign(new Error('x'), { code: 'EPERM' })).abort ===
        false,
      '→ 不中止'
    )
    check(
      '目标可访问却无法送入回收站 → 判为回收站不可用',
      (() => {
        const decision = discriminateTrashFailure(join(projectDir, 'a.txt'), new Error('Operation was aborted'))
        return decision.abort === true && decision.reason === 'trash-unavailable'
      })(),
      '→ abort'
    )
    check(
      '目标不存在 → 判为项级问题',
      (() => {
        const decision = discriminateTrashFailure(join(projectDir, 'gone.txt'), new Error('Operation was aborted'))
        return decision.abort === false && decision.reason === 'not-found'
      })(),
      '→ 不中止'
    )
  }

  /* ---------- 11. 回收站可用性探测 ---------- */
  {
    const ok = await probeTrashAvailability(workingTrash)
    check('探测：可用时返回可用', ok.available === true, ok.message)

    const bad = await probeTrashAvailability(async () => {
      throw new Error('Failed to move item to trash')
    })
    check('探测：不可用时返回不可用', bad.available === false, bad.message)
  }

  /* ---------- 12. 文件被占用（真实 OS 级锁在 Electron 下验证） ---------- */
  {
    // Node 的删除调用默认共享删除权限，无法在本环境构造真实占用，
    // 因此该项仅验证「不把失败误报为成功」的判定逻辑，真实占用由
    // verify-trash-real-m0.cjs 用独占句柄验证。
    resetFixture()
    const lockedTrash: TrashFn = async () => {
      throw Object.assign(new Error('EBUSY: the process cannot access the file'), { code: 'EBUSY' })
    }
    const result = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: ['b.txt'],
      trusted: true,
      trash: lockedTrash
    })
    const item = itemOf(result, 'b.txt')
    check(
      '占用类失败不误报为成功',
      item?.status === 'failed' && item?.reason === 'in-use' && existsSync(join(projectDir, 'b.txt')),
      `status=${String(item?.status)} reason=${String(item?.reason)}`
    )
  }

  /* ---------- 输出 ---------- */
  console.log('=== M0-5 技术验证（一）：删除语义与失败处理 ===')
  console.log(`样例目录：${fixtureRoot}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${checks.length} 项通过`)

  if (!keepFixture) rmSync(fixtureRoot, { recursive: true, force: true })
  else console.log(`\n样例目录已保留：${fixtureRoot}`)

  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((error) => {
  console.error('验证异常：', error)
  process.exit(1)
})
