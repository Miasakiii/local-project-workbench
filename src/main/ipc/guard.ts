import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'

/** 通道处理器签名：与 `ipcMain.handle` 一致，首个参数为调用事件。 */
export type Handler<Args extends unknown[], Result> = (event: IpcMainInvokeEvent, ...args: Args) => Result

export type HandleFn = <Args extends unknown[], Result>(channel: string, handler: Handler<Args, Result>) => void

export interface TrustOptions {
  /** 是否处于开发模式 */
  isDev: boolean
  /** 开发服务器地址；打包后为 undefined */
  rendererDevUrl: string | undefined
}

/**
 * 只接受来自应用自身页面的调用。
 * 开发服务器地址与打包后的 file:// 页面之外的来源一律拒绝。
 */
export function isTrustedSender(event: IpcMainInvokeEvent, options: TrustOptions): boolean {
  const url = event.sender.getURL()
  if (options.isDev && options.rendererDevUrl !== undefined && url.startsWith(options.rendererDevUrl)) return true
  return url.startsWith('file://')
}

/**
 * 生成带来源校验的通道注册函数。
 * 所有 IPC 通道都必须经它注册，避免出现绕过来源校验的裸 `ipcMain.handle`。
 */
export function createHandle(options: TrustOptions): HandleFn {
  return function handle<Args extends unknown[], Result>(channel: string, handler: Handler<Args, Result>): void {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event, options)) {
        throw new Error(`拒绝来自非应用页面的调用：${channel}`)
      }
      return handler(event, ...(args as Args))
    })
  }
}
