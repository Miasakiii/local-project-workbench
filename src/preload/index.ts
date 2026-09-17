import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type {
  AppInfoResult,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalResizeRequest,
  TerminalWriteRequest
} from '@shared/ipc'

/**
 * 预加载层：只暴露白名单方法，不暴露原始 ipcRenderer。
 * 对应设计稿 8.2.3「特权通信」约束。
 *
 * 订阅类方法只向回调传递数据载荷，不传递 IpcRendererEvent，
 * 避免渲染进程通过 event.sender 接触主进程对象。
 */
const api = {
  app: {
    getInfo: (): Promise<AppInfoResult> => ipcRenderer.invoke(IpcChannel.appGetInfo),

    /** 打开目录选择器；取消时返回 null */
    selectDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannel.dialogSelectDirectory)
  },

  terminal: {
    create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(IpcChannel.terminalCreate, request),

    write: (request: TerminalWriteRequest): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.terminalWrite, request),

    resize: (request: TerminalResizeRequest): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.terminalResize, request),

    dispose: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.terminalDispose, sessionId),

    /** 订阅终端输出；返回取消订阅函数 */
    onData: (listener: (payload: TerminalDataEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: TerminalDataEvent): void => listener(payload)
      ipcRenderer.on(IpcChannel.terminalData, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.terminalData, handler)
      }
    },

    /** 订阅会话结束；返回取消订阅函数 */
    onExit: (listener: (payload: TerminalExitEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: TerminalExitEvent): void => listener(payload)
      ipcRenderer.on(IpcChannel.terminalExit, handler)
      return () => {
        ipcRenderer.removeListener(IpcChannel.terminalExit, handler)
      }
    }
  }
}

export type WorkbenchApi = typeof api

contextBridge.exposeInMainWorld('workbench', api)
