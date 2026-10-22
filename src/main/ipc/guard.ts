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
 *
 * 判定分两层，缺一不可：
 * 1. **来源 origin 精确匹配**。开发态只接受开发服务器 origin，生产态只接受
 *    `file://` 页面。用 `URL` 解析后比较 origin 而非字符串前缀：`startsWith` 会被
 *    `http://localhost:5173@evil.com` 这类 userinfo 写法绕过——字符串以
 *    `http://localhost:5173` 开头，但真实 origin 是 `http://evil.com`。
 *    `file://` 的 origin 是 opaque（`'null'`），因此按协议判断。
 * 2. **senderFrame 非空**。`event.senderFrame` 为 null 说明调用不来自页面框架
 *    （如已卸载的 frame 或非 frame 上下文），一律拒绝。
 */
export function isTrustedSender(event: IpcMainInvokeEvent, options: TrustOptions): boolean {
  // 调用必须来自一个真实页面框架；frame 为 null 时拒绝（纵深防御）
  if (event.senderFrame === null || event.senderFrame === undefined) return false

  let parsed: URL
  try {
    parsed = new URL(event.sender.getURL())
  } catch {
    // URL 无法解析：不是合法页面地址，拒绝
    return false
  }

  if (options.isDev && options.rendererDevUrl !== undefined) {
    let devParsed: URL
    try {
      devParsed = new URL(options.rendererDevUrl)
    } catch {
      return false
    }
    if (parsed.origin === devParsed.origin) return true
  }

  // 生产态：只接受 file:// 页面。file:// 的 origin 是 opaque（'null'），按协议判断
  return parsed.protocol === 'file:'
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
