import type { WorkbenchApi } from './index'

declare global {
  interface Window {
    /** 由预加载层注入；渲染进程只能通过此对象访问主进程能力 */
    workbench: WorkbenchApi
  }
}
