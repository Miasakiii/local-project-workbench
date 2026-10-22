import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { IndexHtmlTransformContext, Plugin } from 'vite'

/**
 * 按环境拆分 CSP。
 *
 * 开发态需要 `ws:/wss:`（Vite HMR 的 WebSocket 连接）；生产态不需要，
 * 且保留它会放宽渲染层的网络连接面。生产态同时收紧 `style-src`：
 * 移除 `'unsafe-inline'`，只允许同源样式表——React 的 CSSOM 内联样式
 * （`element.style.x = y`）不受影响，但 `<style>` 标签注入会被阻止。
 */
function cspByEnvironment(): Plugin {
  return {
    name: 'csp-by-environment',
    transformIndexHtml: {
      order: 'pre',
      handler(html: string, ctx: IndexHtmlTransformContext): string {
        // 开发服务器存在时为开发态：保留 ws:/wss: 供 HMR。
        // 构建期 Vite 传的是 undefined（不是 null），必须按 undefined 判定，
        // 否则生产构建永远不会走到下面的收紧分支。
        if (ctx.server !== undefined) return html
        // 生产构建：移除 ws:/wss: 与 style-src 的 'unsafe-inline'
        return html
          .replace(/connect-src 'self' ws: wss:/g, "connect-src 'self'")
          .replace(/style-src 'self' 'unsafe-inline'/g, "style-src 'self'")
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), cspByEnvironment()]
  }
})
