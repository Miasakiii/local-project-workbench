import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitSnapshot } from '@shared/types'
import { failedSnapshot, parsePorcelainV2 } from './git-parse'

const execFileAsync = promisify(execFile)

/** 查询超时。超时必须可区分于「无变更」（设计稿 5.3） */
const GIT_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

interface GitRunResult {
  ok: boolean
  stdout: Buffer
  error: string | null
}

function describeError(cause: unknown): string {
  if (cause && typeof cause === 'object') {
    const err = cause as {
      code?: string | number
      killed?: boolean
      stderr?: Buffer | string
      message?: string
    }
    if (err.killed) return 'Git 查询超时'
    if (err.code === 'ENOENT') return '未找到 Git 程序'
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8')
    const firstLine = stderr?.split('\n').find((line) => line.trim().length > 0)
    if (firstLine) return firstLine.trim()
    if (err.message) return err.message
  }
  return 'Git 查询失败'
}

/**
 * 以参数数组调用 Git，禁止拼接用户路径为 Shell 命令（设计稿 8.1）。
 * --no-optional-locks 减少可选索引写锁冲突，不为提速修改仓库配置（设计稿 5.3）。
 */
async function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'buffer',
      windowsHide: true
    })
    return { ok: true, stdout: stdout as unknown as Buffer, error: null }
  } catch (cause) {
    return { ok: false, stdout: Buffer.alloc(0), error: describeError(cause) }
  }
}

/**
 * 探测目录是否为 Git 仓库。
 * C08：这是可选的探测属性，不作为登记前置条件；
 * 「Git 不可用」（返回 null）与「不是仓库」（返回 false）须分别表述（设计稿 3.1）。
 */
export async function detectRepository(cwd: string): Promise<boolean | null> {
  const result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!result.ok) {
    return result.error === '未找到 Git 程序' ? null : false
  }
  return result.stdout.toString('utf8').trim() === 'true'
}

/** 只读查询分支与状态 */
export async function queryGitStatus(
  projectId: string,
  cwd: string,
  sequence: number
): Promise<GitSnapshot> {
  const result = await runGit(cwd, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all',
    '-z'
  ])

  if (!result.ok) {
    return failedSnapshot(projectId, sequence, result.error ?? 'Git 查询失败')
  }

  const { branch, entries } = parsePorcelainV2(result.stdout)
  return {
    projectId,
    sequence,
    branch,
    entries,
    updatedAt: new Date().toISOString(),
    stale: false,
    error: null
  }
}
