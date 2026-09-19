import type { BlockedNotice, MarkdownDocument } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MarkdownPreviewProps {
  projectId: string
  document: MarkdownDocument
  /** 点击项目内链接时在应用内跳转（不发起页面导航） */
  onNavigateProjectPath: (relativePath: string) => void
}

/** 构造一个不执行任何内容的占位节点，用于替换无法加载的图片。 */
function createPlaceholder(label: string, detail: string): HTMLElement {
  const wrapper = document.createElement('span')
  wrapper.className = 'md-image-placeholder'
  const title = document.createElement('strong')
  title.textContent = label
  const note = document.createElement('span')
  note.textContent = detail
  wrapper.append(title, note)
  return wrapper
}

/**
 * Markdown 预览（设计稿 4.3，M1-5）。
 *
 * 安全约定：
 * - `html` 已由主进程净化并自审；本组件不再做任何字符串拼接。
 * - 图片不通过 URL 加载：按 `data-asset` 经主进程换取 data URL 后再赋给 `src`。
 * - 外链不带 `href`，点击后交给系统浏览器；项目内链接在应用内跳转。
 * - 禁止脚本：本组件从不执行文档中的任何内容。
 */
export function MarkdownPreview({
  projectId,
  document,
  onNavigateProjectPath
}: MarkdownPreviewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [noticesOpen, setNoticesOpen] = useState(false)
  const [assetErrors, setAssetErrors] = useState<string[]>([])

  const blockedGroups = useMemo(() => {
    const groups = new Map<BlockedNotice['reason'], number>()
    for (const notice of document.blocked) {
      groups.set(notice.reason, (groups.get(notice.reason) ?? 0) + 1)
    }
    return [...groups.entries()]
  }, [document.blocked])

  // biome-ignore lint/correctness/useExhaustiveDependencies: document 是刻意的触发依赖——效果体只操作 DOM ref，但必须在新的净化结果注入后重新加载资源
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let cancelled = false
    const failures: string[] = []

    const loadAsset = (image: HTMLImageElement): void => {
      const relativePath = image.getAttribute('data-asset')
      if (relativePath === null) return
      void window.workbench.file
        .readAsset({ projectId, relativePath })
        .then((result) => {
          if (cancelled || !image.isConnected) return
          if (result.status === 'ok' && result.dataUrl !== null) {
            image.src = result.dataUrl
            image.classList.add('md-image')
            return
          }
          failures.push(`${relativePath}：${result.message ?? '无法加载'}`)
          image.replaceWith(createPlaceholder(relativePath, result.message ?? '无法加载该图片'))
          setAssetErrors([...failures])
        })
        .catch((error: unknown) => {
          if (cancelled || !image.isConnected) return
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${relativePath}：${message}`)
          image.replaceWith(createPlaceholder(relativePath, message))
          setAssetErrors([...failures])
        })
    }

    for (const image of Array.from(host.querySelectorAll<HTMLImageElement>('img[data-asset]'))) {
      loadAsset(image)
    }

    // 已获项目授权的外部图片：本版策略默认关闭，出现时给出说明而不是静默空白
    for (const image of Array.from(host.querySelectorAll<HTMLImageElement>('img[data-remote]'))) {
      const url = image.getAttribute('data-remote') ?? ''
      image.replaceWith(createPlaceholder(url, '网络图片默认不加载，可在项目设置中允许。'))
    }

    return () => {
      cancelled = true
    }
  }, [projectId, document])

  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target === null) return

    const external = target.closest('[data-external-url]')
    if (external !== null) {
      event.preventDefault()
      const url = external.getAttribute('data-external-url') ?? ''
      void window.workbench.system.openExternal({ url })
      return
    }

    const projectLink = target.closest('[data-project-path]')
    if (projectLink !== null) {
      event.preventDefault()
      onNavigateProjectPath(projectLink.getAttribute('data-project-path') ?? '')
    }
  }

  const allNotices: BlockedNotice[] = document.blocked

  return (
    <div className="markdown-preview">
      {document.truncated ? (
        <p className="inline-warning">文件超过 5 MB，仅显示前 5 MB 内容。完整内容请用外部程序打开。</p>
      ) : null}

      {document.violations.length > 0 ? (
        <p className="inline-error">渲染自审发现问题，已拒绝采用该输出：{document.violations.join('；')}</p>
      ) : null}

      {assetErrors.length > 0 ? <p className="inline-warning">部分图片未能加载：{assetErrors.join('；')}</p> : null}

      {allNotices.length > 0 ? (
        <div className="blocked-panel">
          <button type="button" className="blocked-toggle" onClick={() => setNoticesOpen((value) => !value)}>
            {noticesOpen ? '收起' : '查看'}被阻止的内容（{allNotices.length} 项：
            {blockedGroups.map(([reason, count]) => `${reasonLabel(reason)} ${count}`).join('，')}）
          </button>
          {noticesOpen ? (
            <ul className="blocked-list">
              {allNotices.map((notice, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同一原因可对应多条说明且文案可重复，索引参与复合键是唯一可靠选择
                <li key={`${notice.reason}-${index}`}>
                  <span className={`chip chip-${notice.reason}`}>{reasonLabel(notice.reason)}</span>
                  <span>{notice.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: 本容器是链接委托宿主，真正的可交互元素是其内部的 <a>（由净化层产出） */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 容器不承载交互语义，键盘操作由内部 <a> 承担 */}
      <div
        className="markdown-body"
        ref={hostRef}
        onClick={handleClick}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容由主进程净化层产出并自审（markdown-sanitize），净化层永不写出 src/href 原始值
        dangerouslySetInnerHTML={{ __html: document.html }}
      />
    </div>
  )
}

function reasonLabel(reason: BlockedNotice['reason']): string {
  switch (reason) {
    case 'unsafe-protocol':
      return '不安全协议'
    case 'remote-resource':
      return '网络资源'
    case 'outside-project':
      return '项目外路径'
    case 'invalid-path':
      return '路径不合法'
    case 'oversized':
      return '超过阈值'
    case 'unsupported-format':
      return '格式不支持'
    case 'raw-html':
      return '主动内容'
    case 'unreadable':
      return '无法读取'
  }
}
