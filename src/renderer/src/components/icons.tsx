/**
 * 内联图标。
 *
 * 用 SVG 而非字体或 emoji：Apple 风格依赖精确的形状与配色，
 * 内联 SVG 可以控制填充色、圆角与描边粗细，且不引入图标字体依赖。
 * 所有图标都是纯装饰，语义由相邻文本或 aria-label 承担。
 */

interface IconProps {
  className?: string
}

/** 文件夹：Finder 风格的浅蓝双层结构 */
export function FolderIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d="M1.5 3.9c0-.6.5-1.1 1.1-1.1h3.1c.3 0 .6.1.8.4l.9 1.1h6c.6 0 1.1.5 1.1 1.1v6.7c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z"
        fill="#7fb0dc"
      />
      <path d="M1.5 6.2h13v5.9c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z" fill="#a8cfee" />
    </svg>
  )
}

/** 文件：带折角的文档 */
export function FileIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M3.6 1.9h5.1l3.7 3.7v8.5H3.6z" fill="#ffffff" stroke="#c7ccd4" strokeWidth="1" strokeLinejoin="round" />
      <path d="M8.7 1.9l3.7 3.7H8.7z" fill="#e4e7eb" stroke="#c7ccd4" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

/** 展开箭头：展开时由 CSS 旋转 90°，避免切换两种字形 */
export function ChevronIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false">
      <path
        d="M4.4 2.6L7.8 6l-3.4 3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 侧边栏开关：左侧一块填充矩形表示边栏区域 */
export function SidebarIcon({ className }: IconProps): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.2 3.2v9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2.4 3.4h3.6v9.2H2.4z" fill="currentColor" opacity="0.85" />
    </svg>
  )
}
