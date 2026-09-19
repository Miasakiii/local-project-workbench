import { useCallback, useRef } from 'react'

interface ResizeHandleProps {
  /**
   * 拖拽轴。
   * - `y`：横向条，上下拖动（面板上边缘）
   * - `x`：纵向条，左右拖动（分栏分隔线）
   */
  axis: 'x' | 'y'
  /** 拖拽开始：调用方在此记录起始尺寸 */
  onDragStart: () => void
  /** 拖拽中：参数为相对起点的位移（右／下为正） */
  onDrag: (delta: number) => void
  onDragEnd: () => void
  ariaLabel: string
  className?: string
}

const KEYBOARD_STEP = 16

/**
 * 尺寸拖拽手柄。
 *
 * 为什么用指针事件而不是鼠标事件：`setPointerCapture` 让指针移出手柄后仍能继续接收
 * 事件，快速拖拽或拖到窗口外都不会中断，也不需要往 document 上挂全局监听。
 *
 * 键盘可操作性：聚焦后方向键按 16px 步进调整，避免只能靠鼠标。
 */
export function ResizeHandle({
  axis,
  onDragStart,
  onDrag,
  onDragEnd,
  ariaLabel,
  className
}: ResizeHandleProps): React.JSX.Element {
  const originRef = useRef<number | null>(null)

  const stopDragging = useCallback(
    (element: HTMLElement, pointerId: number) => {
      originRef.current = null
      document.body.classList.remove('is-resizing-x', 'is-resizing-y')
      // 合成事件下没有真实指针，捕获会抛错，因此需要容错
      try {
        if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
      } catch {
        // 忽略：合成事件或指针已释放
      }
      onDragEnd()
    },
    [onDragEnd]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      originRef.current = axis === 'x' ? event.clientX : event.clientY
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // 忽略：合成事件下无有效指针
      }
      document.body.classList.add(axis === 'x' ? 'is-resizing-x' : 'is-resizing-y')
      onDragStart()
    },
    [axis, onDragStart]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const origin = originRef.current
      if (origin === null) return
      const current = axis === 'x' ? event.clientX : event.clientY
      onDrag(current - origin)
    },
    [axis, onDrag]
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (originRef.current === null) return
      stopDragging(event.currentTarget, event.pointerId)
    },
    [stopDragging]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const decreaseKey = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
      const increaseKey = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
      if (event.key !== decreaseKey && event.key !== increaseKey) return
      event.preventDefault()
      onDragStart()
      onDrag(event.key === decreaseKey ? -KEYBOARD_STEP : KEYBOARD_STEP)
      onDragEnd()
    },
    [axis, onDrag, onDragEnd, onDragStart]
  )

  return (
    <div
      className={className === undefined ? 'resize-handle' : `resize-handle ${className}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={ariaLabel}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    />
  )
}
