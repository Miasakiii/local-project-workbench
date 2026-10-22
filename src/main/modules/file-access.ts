/**
 * 文件访问模块 —— 写操作的统一入口（barrel）。
 *
 * 三条不可协商的规则（贯穿四个写入口）：
 * 1. **删除一律进系统回收站。** 回收站不可用时**停止并说明**，绝不降级为永久删除
 *    （风险 R6）。
 * 2. **逐项报告。** 批量操作按项记录成功、失败与未执行，不给出统一成功提示。
 * 3. **源文件优先。** 任何失败都保留源文件，不请求管理员权限，不做无法真正完成的
 *    撤销承诺。
 *
 * **所有会改动磁盘的路径都只经 `write-guard.ts` 的 `resolveForWrite()` 取得绝对
 * 路径**——这是 README 安全边界中「写目标只有一个出口」的落地处。
 *
 * 模块拆分（重构，行为不变；公开导出面经本 barrel 再导出保持不变）：
 * - `write-guard.ts`      「相对路径 → 可写真实路径」的判定顺序（四步守卫 + 执行后复核
 *                         + A1 身份快照采集与比较）；
 * - `file-op-errors.ts`   errno 与回收站失败的「原因 + 文案」翻译；
 * - `entry-name.ts`       新建与重命名的单段名称校验；
 * - `file-op-common.ts`   四个入口共用的类型、常量与结果拼装；
 * - `delete-entries.ts`   删除入口与回收站可用性探测；
 * - `create-entry.ts`     新建入口；
 * - `transfer-entries.ts` 复制／剪切入口；
 * - `rename-entry.ts`     重命名入口。
 *
 * `classifyError` / `discriminateTrashFailure` 早期从本模块导出，验证脚本与调用方
 * 一直从这里导入；继续经 barrel 再导出，导入方零改动。
 */

export type { CreateEntryRequest } from './create-entry'
export { createEntry } from './create-entry'
export type { DeleteEntriesRequest, TrashProbeResult } from './delete-entries'
export { deleteEntries, probeTrashAvailability } from './delete-entries'
export type { BeforeExecuteHook, TrashFn } from './file-op-common'
export { MAX_BATCH_ITEMS } from './file-op-common'
export type { TrashFailureDecision } from './file-op-errors'
export { classifyError, discriminateTrashFailure } from './file-op-errors'
export type { RenameEntryRequest } from './rename-entry'
export { renameEntry } from './rename-entry'
export type { TransferEntriesRequest } from './transfer-entries'
export { transferEntries } from './transfer-entries'
