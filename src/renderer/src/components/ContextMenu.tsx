import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 右键上下文菜单（渲染层自绘，非 Electron 原生 Menu）。
 *
 * 为什么自绘：设计稿 4.2／6.1 要求右键提供针对条目的操作（打开、定位、复制路径、
 * 在此目录新建终端……）。早先为避开原生 `Menu` 的跨进程复杂度，这些动作被做成工具栏按钮；
 * 自绘菜单把复杂度收回到渲染层，形态上回到右键本意，且不触碰主进程。
 *
 * 无障碍与交互约定（与既有 a11y 改造保持同一口径）：
 * - `role="menu"`／项 `role="menuitem"`，↑↓ 在可用项间移动，Home／End 跳首尾；
 * - Enter／Space 由按钮原生触发，不另做键盘分支；
 * - Esc 关闭并把焦点还给触发行（`returnFocusTo`）；选择一项后同样还焦点；
 * - Tab 关闭菜单（不把焦点留在已消失的浮层上）；
 * - 点击或右键菜单外部即关闭；右键落在可再次打开菜单的目标上时，由调用方换成新菜单。
 *
 * 定位：先按光标位置渲染并实测尺寸，越界时翻转，保证不超出视口。
 */

export interface ContextMenuItem {
  /** 同一菜单内唯一的稳定标识 */
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  /** 危险动作（删除）：红色文字，但仍可聚焦与触发，判定逻辑不变 */
  danger?: boolean
  /** 悬浮说明；不足以表达的差异写在这里，不靠 tooltip 传递关键信息 */
  title?: string
  /** 在该项之前画一条分隔线 */
  separatorBefore?: boolean
}

export interface ContextMenuState {
  /** 光标在视口中的位置 */
  x: number
  y: number
  items: ContextMenuItem[]
  /** 关闭后焦点归还的元素（通常是右键的那一行） */
  returnFocusTo: HTMLElement | null
}

export interface ContextMenuProps {
  state: ContextMenuState
  /** 关闭菜单；不负责还原焦点（还焦点由本组件在 Esc／选择时做） */
  onClose: () => void
}

/** 视口边缘留出的最小间隙，避免菜单贴边或被裁切 */
const VIEWPORT_MARGIN = 8

export function ContextMenu({ state, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  /** 实测后的位置；首帧为 null，此时菜单不可见，避免出现「先错位再跳位」 */
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const firstEnabled = useMemo(() => state.items.findIndex((item) => item.disabled !== true), [state.items])
  const [focusedIndex, setFocusedIndex] = useState(firstEnabled)

  const closeAndRestoreFocus = useCallback(() => {
    state.returnFocusTo?.focus()
    onClose()
  }, [onClose, state.returnFocusTo])

  // 外部交互只关闭菜单，不抢焦点——焦点归属由用户的下一次点击自然决定
  useEffect(() => {
    const isOutside = (event: MouseEvent): boolean => {
      const menu = menuRef.current
      if (menu === null) return true
      const target = event.target
      return !(target instanceof Node) || !menu.contains(target)
    }
    const onPointerDown = (event: MouseEvent): void => {
      if (isOutside(event)) onClose()
    }
    // 右键外部：先关当前菜单；若落点本身能再开菜单，调用方会在同一事件里换成新菜单。
    // 右键落在**本菜单内**时阻止默认行为——否则 Chromium 的原生菜单会盖在自绘菜单之上。
    const onContextMenu = (event: MouseEvent): void => {
      if (isOutside(event)) {
        onClose()
        return
      }
      event.preventDefault()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [onClose])

  // 实测尺寸后定位：右／下越界则翻转，两侧都放不下时贴边（留出 VIEWPORT_MARGIN）
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.items 是刻意的触发依赖——菜单尺寸随项数变化，同一光标位置换一套菜单也要重新实测与翻转
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const rect = menu.getBoundingClientRect()
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    setPosition({
      left: Math.min(Math.max(state.x, VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(state.y, VIEWPORT_MARGIN), maxTop)
    })
  }, [state.x, state.y, state.items])

  // 打开即把焦点移入菜单：键盘用户按右键等价键后不需再按 Tab
  useEffect(() => {
    if (focusedIndex < 0) return
    itemRefs.current[focusedIndex]?.focus()
  }, [focusedIndex])

  /**
   * 换了另一套菜单项时把焦点光标重新落到首个可用项。
   *
   * 调用方可能在**不卸载本组件**的情况下替换 `state.items`（同一光标位置右键另一行）。
   * 此时原先聚焦的按钮可能已不在新菜单里，焦点会掉到 body，之后 Esc 与 ↑↓ 全部失效；
   * `focusedIndex` 也可能越界。这里按新菜单重建焦点。
   */
  useLayoutEffect(() => {
    const first = state.items.findIndex((item) => item.disabled !== true)
    setFocusedIndex(first)
  }, [state.items])

  const enabledIndexes = useMemo(
    () => state.items.map((item, index) => (item.disabled === true ? -1 : index)).filter((index) => index >= 0),
    [state.items]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation() // 不让树形控件的方向键导航同时响应
        closeAndRestoreFocus()
        return
      }
      if (event.key === 'Tab') {
        // 浮层即将消失，不把焦点留在其中；把焦点交回触发行由用户继续 Tab
        event.preventDefault()
        closeAndRestoreFocus()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (enabledIndexes.length === 0) return

      const current = enabledIndexes.indexOf(focusedIndex)
      if (event.key === 'Home') {
        setFocusedIndex(enabledIndexes[0] ?? -1)
        return
      }
      if (event.key === 'End') {
        setFocusedIndex(enabledIndexes[enabledIndexes.length - 1] ?? -1)
        return
      }
      // current === -1（焦点不在任何可用项上）时，↓ 取首个、↑ 取末个
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = current === -1 ? (step === 1 ? 0 : enabledIndexes.length - 1) : current + step
      const wrapped = (next + enabledIndexes.length) % enabledIndexes.length
      setFocusedIndex(enabledIndexes[wrapped] ?? -1)
    },
    [closeAndRestoreFocus, enabledIndexes, focusedIndex]
  )

  const select = useCallback(
    (item: ContextMenuItem) => {
      if (item.disabled === true) return
      state.returnFocusTo?.focus()
      onClose()
      item.onSelect()
    },
    [onClose, state.returnFocusTo]
  )

  return createPortal(
    <div
      className={position === null ? 'context-menu placing' : 'context-menu'}
      style={position === null ? undefined : { left: position.left, top: position.top }}
      role="menu"
      ref={menuRef}
      onKeyDown={handleKeyDown}
      // 打开瞬间不要被误判为「点击外部」：pointerdown 监听加在 document 捕获段，
      // 而这一次 pointerdown 的目标是菜单内部的项，故天然不会命中关闭分支。
    >
      {state.items.map((item, index) => (
        <Fragment key={item.id}>
          {item.separatorBefore === true ? <hr className="menu-sep" /> : null}
          <button
            type="button"
            className={item.danger === true ? 'menu-item danger' : 'menu-item'}
            role="menuitem"
            disabled={item.disabled === true}
            aria-disabled={item.disabled === true ? true : undefined}
            title={item.title}
            ref={(element) => {
              itemRefs.current[index] = element
            }}
            tabIndex={-1}
            onClick={() => select(item)}
            onMouseEnter={() => {
              if (item.disabled !== true) setFocusedIndex(index)
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body
  )
}
