/**
 * 退出协调 —— 退出前处理活动终端会话（设计稿 6.1）。
 *
 * 目标只有一个：**不静默中断用户正在运行的命令**。为此需要在退出前询问，
 * 而「询问」会把一次同步的退出流程拆成两段，于是必须同时守住三条边界，
 * 否则会出现「关不掉」或「静默中断」：
 *
 * 1. **没有界面可问时不阻塞退出。** 窗口已销毁（系统注销、渲染进程崩溃）时
 *    直接清理并放行，不能因为发不出询问就让应用永远关不掉。
 * 2. **同一时刻只发一次询问。** `before-quit` 与窗口 `close` 都会走到这里，
 *    重复触发不能叠加多个询问框。
 * 3. **取消不产生副作用。** 用户取消后应用继续运行，会话与视图都不受影响。
 *
 * 外部能力全部通过 `QuitCoordinatorDeps` 注入，因此本模块不导入 Electron，
 * 可在纯 Node 下验证。
 */

export interface QuitCoordinatorDeps {
  /** 当前活动的终端会话数量 */
  activeSessionCount(): number
  /** 是否还有可用于询问的界面 */
  canPrompt(): boolean
  /** 向界面发出询问 */
  prompt(sessionCount: number): void
  /** 清理进程级服务（会话、监听等）；必须可重复调用 */
  disposeServices(): void
  /** 真正退出应用 */
  quit(): void
}

export class QuitCoordinator {
  private isConfirmed = false
  private isPending = false

  constructor(private readonly deps: QuitCoordinatorDeps) {}

  /** 用户是否已确认退出；确认后不再询问 */
  get confirmed(): boolean {
    return this.isConfirmed
  }

  /** 是否正在等待界面回应 */
  get pending(): boolean {
    return this.isPending
  }

  /**
   * 请求退出。返回 true 表示**已阻止**本次退出（等待用户确认）。
   *
   * 调用点：`app.on('before-quit')` 与窗口 `close`。两处共用同一状态，
   * 因此不会出现「先关窗口再退出」时连问两次的情况。
   */
  requestQuit(): boolean {
    if (this.isConfirmed) return false
    if (this.deps.activeSessionCount() === 0) return false
    if (this.isPending) return true
    if (!this.deps.canPrompt()) return false

    this.isPending = true
    this.deps.prompt(this.deps.activeSessionCount())
    return true
  }

  /** 界面回应：true 结束会话并退出，false 取消本次退出。 */
  resolve(confirmed: boolean): void {
    this.isPending = false
    if (!confirmed) return

    this.isConfirmed = true
    this.deps.disposeServices()
    this.deps.quit()
  }

  /**
   * 询问发出后界面消失（渲染进程崩溃）：视为无法确认，直接结束，
   * 避免应用卡在「既关不掉也无法操作」的状态。
   */
  abandonPrompt(): void {
    if (!this.isPending) return
    this.isPending = false
    this.isConfirmed = true
    this.deps.disposeServices()
    this.deps.quit()
  }

  /** 退出流程最终放行前的清理；可重复调用。 */
  finalize(): void {
    this.deps.disposeServices()
  }
}

export function createQuitCoordinator(deps: QuitCoordinatorDeps): QuitCoordinator {
  return new QuitCoordinator(deps)
}
