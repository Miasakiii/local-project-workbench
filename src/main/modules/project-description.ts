import { detectReadme, extractSummary } from './markdown-preview'

/**
 * 项目简介解析（设计稿 4.1 / 项目库卡片）。
 *
 * 抽自主进程入口 `index.ts` 的动机：完成度审查（G2）发现 `verify-m1.mts` 此前只能在
 * 脚本内复制一份 resolver，导致生产的简介三级优先逻辑从未被任何断言覆盖。本模块不导入
 * Electron，可在纯 Node 下加载，从而让登记侧断言直接打到生产实现。
 *
 * 三级优先（与设计稿一致）：
 *   1. 用户填写的简介（`descriptionOverride`，非空才生效）
 *   2. README 首段（经 `extractSummary`）
 *   3. 回退到规范化身份（真实路径）
 *
 * 本函数**无状态**：缓存与失效属于应用态，由主进程（`index.ts`）在调用外侧持有。
 */

export type DescriptionSource = 'user' | 'readme' | 'path'

export interface DescriptionResult {
  text: string | null
  source: DescriptionSource
}

/** 供简介解析使用的最小字段集；完整 `Project` 可安全传入（结构化子集）。 */
export interface DescriptionInput {
  normalizedIdentity: string
  descriptionOverride: string | null
  readmePath: string | null
}

export function resolveDescription(project: DescriptionInput): DescriptionResult {
  const override = project.descriptionOverride
  if (override !== null && override.trim().length > 0) {
    return { text: override.trim(), source: 'user' }
  }

  const detection = detectReadme(project.normalizedIdentity, project.readmePath)
  let text: string | null = null
  if (detection.selected !== null) {
    text = extractSummary(project.normalizedIdentity, detection.selected)
  }
  if (text === null) {
    return { text: project.normalizedIdentity, source: 'path' }
  }
  return { text, source: 'readme' }
}
