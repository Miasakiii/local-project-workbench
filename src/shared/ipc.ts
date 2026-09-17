import type { AppInfo } from './types'

/**
 * IPC 通道名与契约。
 *
 * 安全约定（设计稿 8.1 / 8.2.3）：
 * - 渲染进程不得直接接触 ipcRenderer，只能调用预加载层暴露的白名单方法。
 * - 主进程须校验调用来源，不信任渲染进程传入的任意绝对路径。
 * - 终端输入是独立特权通道，不得开放给文档预览。
 */
export const IpcChannel = {
  appGetInfo: 'app:get-info',
  dialogSelectDirectory: 'dialog:select-directory',

  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalDispose: 'terminal:dispose',

  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface TerminalCreateRequest {
  /** 启动目录。主进程须校验其存在且为目录，不直接信任传入值。 */
  cwd: string
  cols: number
  rows: number
}

export interface TerminalCreateResult {
  sessionId: string
  shell: string
  cwd: string
}

export interface TerminalWriteRequest {
  sessionId: string
  data: string
}

export interface TerminalResizeRequest {
  sessionId: string
  cols: number
  rows: number
}

/** 主进程 → 渲染进程：终端输出 */
export interface TerminalDataEvent {
  sessionId: string
  data: string
}

/** 主进程 → 渲染进程：会话结束 */
export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  signal: number | null
}

export type AppInfoResult = AppInfo
