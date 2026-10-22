/**
 * M3 文件操作验证：新建、复制/剪切粘贴、删除入口与批量失败报告。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-m3-file-ops.mts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrashFn } from '../src/main/modules/file-access.ts'
import { createEntry, deleteEntries, renameEntry, transferEntries } from '../src/main/modules/file-access.ts'
import { captureFileIdentity, fileIdentityUnchanged } from '../src/main/modules/write-guard.ts'
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

/**
 * A3：守卫开销实测 —— R9 残余窗口的定级依据。
 *
 * 测量的是「身份快照采集 + 执行前复核」的单次成本。注意它**不是**残余窗口的
 * 宽度：「执行前复核结束 → 系统调用」之间的残余段只剩微秒级且无法从外部分解，
 * 这里只报告可测量的守卫段成本，残余段在结论里如实登记为不可分解。
 */
function measureGuardOverhead(): { samples: number; medianUs: number; p95Us: number; maxUs: number } {
  const probe = join(tmpdir(), 'workbench-guard-overhead-probe')
  try {
    writeFileSync(probe, 'probe')
    const samples: number[] = []
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now()
      const snapshot = captureFileIdentity(probe)
      fileIdentityUnchanged(snapshot, probe)
      samples.push((performance.now() - started) * 1000)
    }
    const sorted = [...samples].sort((a, b) => a - b)
    return {
      samples: sorted.length,
      medianUs: sorted[Math.floor(sorted.length / 2)] as number,
      p95Us: sorted[Math.floor(sorted.length * 0.95)] as number,
      maxUs: sorted[sorted.length - 1] as number
    }
  } finally {
    rmSync(probe, { force: true })
  }
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

  /* ---------- 9. 受保护项的归一化写法（`.git` 绕过回归） ---------- */
  {
    resetFixture()
    // `target/../.git` 的原始输入首段是 target，只有折叠 `..` 之后才暴露为 `.git`。
    // 守卫必须在归一化后再查一次受保护项，否则「.git 元数据不提供写操作」失效。
    const escapes = ['target/../.git', 'target/../.git/config', 'folder/../.git', 'target\\..\\.git']

    const trashed: string[] = []
    const deletion = await deleteEntries({
      projectRoot: projectDir,
      relativePaths: escapes,
      trusted: true,
      trash: async (absolutePath) => {
        trashed.push(absolutePath)
        await workingTrash(absolutePath)
      }
    })
    check(
      '经 .. 归一化到 .git 的删除一律未执行',
      deletion.skipped === escapes.length && deletion.ok === 0 && deletion.failed === 0,
      detail(deletion)
    )
    check(
      '经 .. 归一化到 .git 逐项报为 protected-entry',
      deletion.items.every((item) => item.reason === 'protected-entry'),
      deletion.items.map((item) => `${item.relativePath}:${String(item.reason)}`).join(', ')
    )
    check('归一化写法未触达回收站', trashed.length === 0, trashed.join(', ') || '未调用回收站')
    check('.git 元数据在归一化删除后仍完整', existsSync(join(projectDir, '.git', 'config')), '.git/config 仍在')

    const copied = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['target/../.git'],
      targetDirectory: 'target',
      mode: 'copy',
      trusted: true
    })
    check(
      '经 .. 归一化到 .git 拒绝复制',
      copied.items[0]?.status === 'skipped' && copied.items[0]?.reason === 'protected-entry',
      detail(copied)
    )
    check('复制未产生 .git 副本', !existsSync(join(targetDir, '.git')), 'target/.git 不存在')

    const moved = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['folder/../.git'],
      targetDirectory: 'target',
      mode: 'move',
      trusted: true
    })
    check(
      '经 .. 归一化到 .git 拒绝剪切粘贴',
      moved.items[0]?.status === 'skipped' && moved.items[0]?.reason === 'protected-entry',
      detail(moved)
    )
    check('剪切未移走 .git', existsSync(join(projectDir, '.git', 'config')), '.git/config 仍在')

    const created = createEntry({
      projectRoot: projectDir,
      parentRelativePath: 'target/../.git',
      name: 'hook.sh',
      kind: 'file',
      trusted: true
    })
    check('经 .. 归一化到 .git 拒绝新建', created.aborted && created.abortReason === 'protected-entry', detail(created))
    check('未在 .git 内落盘', !existsSync(join(projectDir, '.git', 'hook.sh')), '.git/hook.sh 不存在')

    // 反向对照：合法路径不得被误伤——`target/..` 归一化为项目根，仍应可作为粘贴目标
    const viaRoot = transferEntries({
      projectRoot: projectDir,
      relativePaths: ['folder/nested.txt'],
      targetDirectory: 'target/..',
      mode: 'copy',
      trusted: true
    })
    check('归一化到项目根的合法粘贴不受影响', viaRoot.ok === 1 && viaRoot.failed === 0, detail(viaRoot))
    check('合法粘贴落到项目根', existsSync(join(projectDir, 'nested.txt')), 'nested.txt 已复制到项目根')
  }

  /* ---------- 10. 执行前竞态注入：身份快照（A1／R9 收窄） ---------- */
  {
    resetFixture()
    const raceOutsideDir = join(fixtureRoot, 'race-outside')
    mkdirSync(raceOutsideDir, { recursive: true })

    // 场景 1：重命名前源文件被「同名异文件」替换。realpath 等价复核对这种替换是
    // 盲区（路径解析结果不变），物理身份（dev+ino）必须看得出来；旧防线会把
    // 替换后的文件静默移走。
    {
      const result = renameEntry({
        projectRoot: projectDir,
        relativePath: 'alpha.txt',
        newName: 'alpha-swapped.txt',
        trusted: true,
        beforeExecute: () => {
          rmSync(join(projectDir, 'alpha.txt'), { force: true })
          writeFileSync(join(projectDir, 'alpha.txt'), 'attacker replacement')
        }
      })
      check(
        '竞态替换源文件后拒绝重命名',
        result.status === 'failed' && result.reason === 'path-changed',
        `status=${result.status} reason=${String(result.reason)} target=${String(result.targetRelativePath)}`
      )
      check(
        '替换未被 rename 波及',
        existsSync(join(projectDir, 'alpha.txt')) && !existsSync(join(projectDir, 'alpha-swapped.txt')),
        'alpha.txt 未被动过，未产生 alpha-swapped.txt'
      )

      // 场景 2：剪切前目标位置被抢先创建。renameSync 在 Windows 上静默覆盖已存在
      // 目标，仅靠 existsSync 预检挡不住「检查后、执行前」的抢占。
      const moved = transferEntries({
        projectRoot: projectDir,
        relativePaths: ['move-me.txt'],
        targetDirectory: 'target',
        mode: 'move',
        trusted: true,
        beforeExecute: () => {
          writeFileSync(join(targetDir, 'move-me.txt'), 'preempted by someone')
        }
      })
      check(
        '竞态抢占目标后拒绝移动',
        moved.items[0]?.status === 'failed' && moved.items[0]?.reason === 'path-changed',
        detail(moved)
      )
      check(
        '被抢占的既有目标未被覆盖',
        readFileSync(join(targetDir, 'move-me.txt'), 'utf8') === 'preempted by someone',
        '目标内容保持原样'
      )
      check('抢占场景下源项保留', existsSync(join(projectDir, 'move-me.txt')), 'move-me.txt 未被动过')
    }

    // 场景 3：新建前父目录被换成指向项目外的目录联接——不得把文件写出去。
    {
      const created = createEntry({
        projectRoot: projectDir,
        parentRelativePath: 'target',
        name: 'after-swap.txt',
        kind: 'file',
        trusted: true,
        beforeExecute: () => {
          rmSync(join(projectDir, 'target'), { recursive: true, force: true })
          symlinkSync(raceOutsideDir, join(projectDir, 'target'), 'junction')
        }
      })
      check(
        '竞态替换父目录后拒绝新建',
        created.items[0]?.status === 'failed' && created.items[0]?.reason === 'path-changed',
        detail(created)
      )
      check('新建未落到替换后的项目外目录', !existsSync(join(raceOutsideDir, 'after-swap.txt')), '项目外目录无新文件')
      // 恢复 fixture 供后续场景
      rmSync(join(projectDir, 'target'), { recursive: true, force: true })
      mkdirSync(targetDir, { recursive: true })
    }

    // 场景 4：删除前目标被「同名异文件」替换——不能把替换后的文件送进回收站。
    {
      const deleted = await deleteEntries({
        projectRoot: projectDir,
        relativePaths: ['beta.txt'],
        trusted: true,
        trash: workingTrash,
        beforeExecute: () => {
          rmSync(join(projectDir, 'beta.txt'), { force: true })
          writeFileSync(join(projectDir, 'beta.txt'), 'attacker file')
        }
      })
      check(
        '竞态替换删除目标后拒绝删除',
        deleted.items[0]?.status === 'failed' && deleted.items[0]?.reason === 'path-changed',
        detail(deleted)
      )
      check('替换后的文件未被误删', existsSync(join(projectDir, 'beta.txt')), 'beta.txt 仍在')
    }

    // 场景 5：复制前源项被替换——拒绝并保留现场。
    {
      const copied = transferEntries({
        projectRoot: projectDir,
        relativePaths: ['folder/nested.txt'],
        targetDirectory: 'target',
        mode: 'copy',
        trusted: true,
        beforeExecute: () => {
          rmSync(join(projectDir, 'folder', 'nested.txt'), { force: true })
          writeFileSync(join(projectDir, 'folder', 'nested.txt'), 'swapped nested')
        }
      })
      check(
        '竞态替换复制源后拒绝复制',
        copied.items[0]?.status === 'failed' && copied.items[0]?.reason === 'path-changed',
        detail(copied)
      )
      check(
        '复制未产生目标且源保留',
        !existsSync(join(targetDir, 'nested.txt')) && existsSync(join(projectDir, 'folder', 'nested.txt')),
        '目标未出现，源仍在'
      )
    }

    // 场景 6：无竞态时正常流程不得被误伤（回归）。
    {
      const renamed = renameEntry({
        projectRoot: projectDir,
        relativePath: 'beta.txt',
        newName: 'beta-ok.txt',
        trusted: true
      })
      check('无竞态时正常重命名', renamed.status === 'ok', renamed.message)

      const copied = transferEntries({
        projectRoot: projectDir,
        relativePaths: ['alpha.txt'],
        targetDirectory: 'target',
        mode: 'copy',
        trusted: true
      })
      check('无竞态时正常复制', copied.ok === 1 && copied.failed === 0, detail(copied))

      const removed = await deleteEntries({
        projectRoot: projectDir,
        relativePaths: ['busy.txt'],
        trusted: true,
        trash: workingTrash
      })
      check('无竞态时正常删除', removed.ok === 1 && removed.failed === 0, detail(removed))
    }

    // 场景 7：注入 5ms 宽窗口——竞态拒绝与窗口宽度无关。识别逻辑是「快照 + 执行前
    // 复核」而非「比速度」：窗口内的替换发生在复核之前就一律拒绝，发生在复核与
    // 系统调用之间才可能漏检（该残余段只剩微秒级，无法从外部分解，如实登记）。
    {
      const sleepSync = (ms: number): void => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
      }
      const renamed = renameEntry({
        projectRoot: projectDir,
        relativePath: 'beta-ok.txt',
        newName: 'beta-wide.txt',
        trusted: true,
        beforeExecute: () => {
          sleepSync(5)
          rmSync(join(projectDir, 'beta-ok.txt'), { force: true })
          writeFileSync(join(projectDir, 'beta-ok.txt'), 'wide window swap')
        }
      })
      check(
        '5ms 宽窗口内替换源文件后仍拒绝重命名',
        renamed.status === 'failed' && renamed.reason === 'path-changed',
        `status=${renamed.status} reason=${String(renamed.reason)}`
      )

      const deleted = await deleteEntries({
        projectRoot: projectDir,
        relativePaths: ['alpha.txt'],
        trusted: true,
        trash: workingTrash,
        beforeExecute: () => {
          sleepSync(5)
          rmSync(join(projectDir, 'alpha.txt'), { force: true })
          writeFileSync(join(projectDir, 'alpha.txt'), 'wide window swap')
        }
      })
      check(
        '5ms 宽窗口内替换删除目标后仍拒绝删除',
        deleted.items[0]?.status === 'failed' && deleted.items[0]?.reason === 'path-changed',
        detail(deleted)
      )
    }
  }

  /* ---------- A3：守卫开销实测（R9 残余窗口定级依据） ---------- */
  const guardOverhead = measureGuardOverhead()

  console.log('=== M3 文件操作验证：新建、复制/剪切粘贴、删除与批量报告 ===')
  console.log(`样例目录：${fixtureRoot}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}`)
  console.log(
    `守卫开销（A3）：${guardOverhead.samples} 次取样，中位 ${guardOverhead.medianUs.toFixed(1)} µs／` +
      `p95 ${guardOverhead.p95Us.toFixed(1)} µs／最大 ${guardOverhead.maxUs.toFixed(1)} µs` +
      '（复核结束到系统调用之间的微秒级残余段无法从外部分解，已如实登记）\n'
  )

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
