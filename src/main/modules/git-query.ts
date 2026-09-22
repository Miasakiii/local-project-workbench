import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { FileDiff, GitSnapshot } from '@shared/types'
import { parseUnifiedDiff } from './git-diff-parse'
import { failedSnapshot, parsePorcelainV2 } from './git-parse'

const execFileAsync = promisify(execFile)

/** 查询超时。超时必须可区分于「无变更」（设计稿 5.3） */
const GIT_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
/** 差异输出上限：超过即按失败处理并明确告知，而不是给出不完整内容 */
const MAX_DIFF_BYTES = 8 * 1024 * 1024

/**
 * 中和可能执行外部程序的 Git 配置（设计稿 5.3：未信任仓库的读取须限制可执行的
 * 扩展、外部差异程序及类似回调）。这些参数只影响本次调用，不修改仓库配置。
 */
const SAFE_CONFIG = [
  '-c',
  'core.pager=cat',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'core.quotePath=false'
]

/** 同时通过环境变量关闭外部差异程序与交互式提示。 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_EXTERNAL_DIFF: '',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0'
}

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
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Git 输出超过上限，已中止'
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
async function runGit(cwd: string, args: string[], maxBuffer = MAX_OUTPUT_BYTES): Promise<GitRunResult> {
  // 工作目录不存在时 execFile 同样报 ENOENT，会被误判为「未找到 Git 程序」。
  // 先自行检查，把「目录不可用」与「Git 不可用」区分开。
  if (!existsSync(cwd)) {
    return { ok: false, stdout: Buffer.alloc(0), error: '工作目录不存在或不可访问' }
  }

  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...SAFE_CONFIG, ...args], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      encoding: 'buffer',
      windowsHide: true,
      env: GIT_ENV
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

/**
 * 取目录所在 Git 仓库的工作区根（`rev-parse --show-toplevel`）。
 * 非仓库或查询失败返回 null。仅用于「登记子目录时提示可改用仓库根」（G4），不影响登记本身。
 */
export async function detectRepositoryRoot(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return null
  const top = result.stdout.toString('utf8').trim()
  return top.length > 0 ? top : null
}

/** 只读查询分支与状态 */
export async function queryGitStatus(projectId: string, cwd: string, sequence: number): Promise<GitSnapshot> {
  const result = await runGit(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'])

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

/**
 * 查询单个文件相对于索引或 HEAD 的差异。
 *
 * 只读：仅使用 `diff` 子命令，不触碰工作区与索引。
 * 路径置于 `--` 之后以参数数组传入，既不会被当作选项解析，也不经过 Shell。
 */
export async function queryFileDiff(
  projectId: string,
  cwd: string,
  relativePath: string,
  scope: 'unstaged' | 'staged',
  /** 重命名时的原路径。必须一并传入，否则限定路径后 Git 无法配对两侧，
   *  会把重命名报告成「新增」，与状态列表的结论矛盾。 */
  originalPath: string | null = null
): Promise<FileDiff> {
  const args = [
    'diff',
    ...(scope === 'staged' ? ['--cached'] : []),
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '--unified=3',
    '--',
    relativePath,
    ...(originalPath !== null ? [originalPath] : [])
  ]

  const result = await runGit(cwd, args, MAX_DIFF_BYTES)
  if (!result.ok) {
    return {
      projectId,
      relativePath,
      scope,
      status: 'unchanged',
      binary: false,
      originalPath: null,
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      truncated: false,
      noBaseline: false,
      updatedAt: new Date().toISOString(),
      stale: true,
      error: result.error ?? 'Git 差异查询失败'
    }
  }

  const parsed = parseUnifiedDiff(result.stdout.toString('utf8'))

  // 合并冲突使用三路差异格式，本版不逐行展示：明确报错，而不是当作「无差异」
  if (parsed.combined) {
    return {
      projectId,
      relativePath,
      scope,
      status: 'unchanged',
      binary: false,
      originalPath: null,
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      truncated: false,
      noBaseline: false,
      updatedAt: new Date().toISOString(),
      stale: true,
      error: '该文件处于合并冲突状态，Git 使用三路差异格式，本版不逐行展示。请在文件中查看冲突标记。'
    }
  }

  return {
    projectId,
    relativePath,
    scope,
    status: parsed.status,
    binary: parsed.binary,
    originalPath: parsed.originalPath,
    hunks: parsed.hunks,
    addedLines: parsed.addedLines,
    removedLines: parsed.removedLines,
    truncated: false,
    noBaseline: false,
    updatedAt: new Date().toISOString(),
    stale: false,
    error: null
  }
}

export { MAX_DIFF_BYTES }
