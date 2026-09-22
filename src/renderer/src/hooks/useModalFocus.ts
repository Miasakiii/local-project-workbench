import type { RefObject } from 'react'
import { useEffect, useRef } from 'react'

/**
 * 可聚焦项选择器：对话框内应进入 Tab 循环的控件。
 * [tabindex="-1"] 排除在外——它们只用于程序化聚焦，不参与用户 Tab 顺序。
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 模态焦点管理（设计稿 2.3 的无障碍约定）。
 *
 * - 打开时把焦点移入框内：优先 `initial`（如编辑框），否则框内首个可聚焦项；
 * - Tab / Shift+Tab 在框内循环，不逃逸到背景内容；
 * - Esc 触发 `onClose`；
 * - 关闭时把焦点还原到打开前的触发元素。
 *
 * `onClose` 走 ref 读取，调用方无需 `useCallback` 包裹；`initial` 为 ref，稳定不变。
 * 用法：在组件顶层调用，把返回的 `dialogRef` 挂到 `role="dialog"` 的内容容器上。
 */
export function useModalFocus(
  open: boolean,
  onClose: () => void,
  initial?: { current: HTMLElement | null }
): { dialogRef: RefObject<HTMLDivElement | null> } {
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // 等这一帧的内容提交后再聚焦，避免与挂载时序竞争
    const raf = requestAnimationFrame(() => {
      const target = initial?.current ?? dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? dialog ?? null
      target?.focus()
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || dialog === null) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => element.offsetParent !== null
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        event.preventDefault()
        first?.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      returnFocusRef.current?.focus()
    }
  }, [open, initial])

  return { dialogRef }
}
