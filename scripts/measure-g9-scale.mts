/**
 * G9 实测：按设计稿 9.1 的量级造数，测量三口径并对目标对比。
 *
 *   ① 100 登记项目：冷启动到「项目库可交互」的数据成本   目标 < 3s
 *   ② 1,000 项目录：文件页首屏列举                       目标 < 1s
 *   ③ 保存后刷新：登记数据持久化写 + 重新读入             目标 ~2s
 *
 * 口径说明：headless 下测的是**主进程数据成本**（登记、列表、简介解析、目录列举、
 * 登记数据重新读入），不含窗口创建与渲染管线；真实桌面交互时延另见 M3-5 验收手册。
 * 阈值为设计稿目标的参照，超目标仅作提示，不作为门禁。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/measure-g9-scale.mts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectory } from '../src/main/modules/file-browser.ts'
import { resolveDescription } from '../src/main/modules/project-description.ts'
import { createRegistry, createRegistryStore, toSummary } from '../src/main/modules/project-registry.ts'

const TARGETS = { coldToLibraryMs: 3000, directoryMs: 1000, reloadMs: 2000 }

function verdict(ms: number, cap: number): string {
  const mark = ms <= cap ? '达标' : '超目标'
  return `${ms.toFixed(0)} ms / 目标 ≤ ${cap} ms —— ${mark}（headless 参照）`
}

function main(): void {
  const work = mkdtempSync(join(tmpdir(), 'lpw-g9-'))
  try {
    // 造 100 个真实项目目录（各含 README，走通简介提取）
    const dirs: string[] = []
    for (let index = 0; index < 100; index += 1) {
      const dir = join(work, `proj-${index}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'README.md'), `# Project ${index}\n\n这是第 ${index} 个项目的简介首段。\n`)
      dirs.push(dir)
    }

    // 造 1,000 项目录
    const big = join(work, 'big')
    mkdirSync(big, { recursive: true })
    for (let index = 0; index < 1000; index += 1) {
      writeFileSync(join(big, `文件${String(index).padStart(4, '0')}.txt`), 'x')
    }

    const storePath = join(work, 'projects.json')
    const registry = createRegistry(createRegistryStore(storePath))

    console.log('=== G9 实测：设计稿 9.1 量级（headless 主进程口径）===\n')

    // ① 100 登记 + 项目库数据（list + 简介解析）
    let start = Date.now()
    for (const dir of dirs) registry.register(dir)
    const registerMs = Date.now() - start

    start = Date.now()
    const summaries = registry.list().map((project) => toSummary(project, resolveDescription))
    const listMs = Date.now() - start
    const coldToLibraryMs = registerMs + listMs
    console.log(`① 100 项目·冷启动到项目库可用：登记 ${registerMs}ms + 列表/简介 ${listMs}ms = ${coldToLibraryMs}ms`)
    console.log(`   ${verdict(coldToLibraryMs, TARGETS.coldToLibraryMs)}（${summaries.length} 个项目摘要）`)

    // ② 1,000 项目录首屏列举
    start = Date.now()
    const listing = listDirectory({ projectRoot: big, relativePath: '' })
    const directoryMs = Date.now() - start
    const suffix = `${listing.truncated ? '，已截断' : ''}${listing.error !== null ? `，错误：${listing.error}` : ''}`
    console.log(`\n② 1,000 项目录首屏列举：${directoryMs}ms`)
    console.log(`   ${verdict(directoryMs, TARGETS.directoryMs)}（列出 ${listing.entries.length} 项${suffix}）`)

    // ③ 保存后刷新：重新读入登记数据（外部变更后重新解析的成本）
    start = Date.now()
    const reloaded = createRegistry(createRegistryStore(storePath))
    const reloadedCount = reloaded.list().length
    const reloadMs = Date.now() - start
    console.log(`\n③ 保存后刷新（重新读入登记数据）：${reloadMs}ms`)
    console.log(`   ${verdict(reloadMs, TARGETS.reloadMs)}（读入 ${reloadedCount} 条登记）`)

    console.log('\n=== 机器可读汇总 ===')
    console.log(
      JSON.stringify({
        registerMs,
        listMs,
        coldToLibraryMs,
        directoryMs,
        directoryEntries: listing.entries.length,
        truncated: listing.truncated,
        reloadMs,
        reloadedCount,
        targets: TARGETS
      })
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main()
