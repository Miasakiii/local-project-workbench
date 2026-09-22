import type { BlockedNotice, MarkdownDocument } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MarkdownPreviewProps {
  projectId: string
  document: MarkdownDocument
  /** 点击项目内链接时在应用内跳转（不发起页面导航） */
  onNavigateProjectPath: (relativePath: string) => void
  /** 本项目是否已允许加载网络图片；用于渲染开关的初始状态 */
  allowNetworkImages?: boolean
  /** 提供时才渲染「加载网络图片」开关；缺席的场合（如文件页预览）只跟随已有授权 */
  onAllowNetworkImagesChange?: (next: boolean) => void
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

/** 占位标签只用主机名：完整 URL 往往很长，会把界面撑开成噪声。 */
function hostLabel(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Markdown 预览（设计稿 4.3，M1-5）。
 *
 * 安全约定：
 * - `html` 已由主进程净化并自审；本组件不再做任何字符串拼接。
 * - 图片不通过 URL 加载：项目内按 `data-asset`、远程按 `data-remote` 经主进程换取
 *   data URL 后再赋给 `src`。**本组件从不向远程地址直接发起请求。**
 * - 外链不带 `href`，点击后交给系统浏览器；项目内链接在应用内跳转。
 * - 禁止脚本：本组件从不执行文档中的任何内容。
 */
export function MarkdownPreview({
  projectId,
  document: markdown,
  onNavigateProjectPath,
  allowNetworkImages = false,
  onAllowNetworkImagesChange
}: MarkdownPreviewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [noticesOpen, setNoticesOpen] = useState(false)
  const [assetErrors, setAssetErrors] = useState<string[]>([])
  /** 远程图片的失败说明；与项目内资源的失败分开列，原因不同（策略 vs 读取） */
  const [remoteNotices, setRemoteNotices] = useState<{ host: string; message: string }[]>([])

  const blockedGroups = useMemo(() => {
    const groups = new Map<BlockedNotice['reason'], number>()
    for (const notice of markdown.blocked) {
      groups.set(notice.reason, (groups.get(notice.reason) ?? 0) + 1)
    }
    return [...groups.entries()]
  }, [markdown.blocked])

  /** 本文档是否涉及网络图片：被阻止的远程资源，或已授权但尚未加载的地址。 */
  const remoteImageCount = useMemo(() => {
    const blocked = markdown.blocked.filter((notice) => notice.reason === 'remote-resource' && notice.kind === 'image')
    return blocked.length + markdown.remoteAssets.length
  }, [markdown])

  // biome-ignore lint/correctness/useExhaustiveDependencies: document 是刻意的触发依赖——效果体只操作 DOM ref，但必须在新的净化结果注入后重新加载资源
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let cancelled = false
    const failures: string[] = []
    const remoteFailures: { host: string; message: string }[] = []

    const replaceImage = (image: HTMLImageElement, label: string, detail: string): void => {
      image.replaceWith(createPlaceholder(label, detail))
    }

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
          replaceImage(image, relativePath, result.message ?? '无法加载该图片')
          setAssetErrors([...failures])
        })
        .catch((error: unknown) => {
          if (cancelled || !image.isConnected) return
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${relativePath}：${message}`)
          replaceImage(image, relativePath, message)
          setAssetErrors([...failures])
        })
    }

    for (const image of Array.from(host.querySelectorAll<HTMLImageElement>('img[data-asset]'))) {
      loadAsset(image)
    }

    // 已获项目授权的外部图片：由主进程代取并转成 data URL；未授权时不会走到这里
    for (const image of Array.from(host.querySelectorAll<HTMLImageElement>('img[data-remote]'))) {
      const url = image.getAttribute('data-remote')
      if (url === null) continue
      void window.workbench.file
        .readRemoteAsset({ projectId, url })
        .then((result) => {
          if (cancelled || !image.isConnected) return
          if (result.status === 'ok' && result.dataUrl !== null) {
            image.src = result.dataUrl
            image.classList.add('md-image')
            return
          }
          const message = result.message ?? '未能加载该网络图片'
          remoteFailures.push({ host: hostLabel(url), message })
          replaceImage(image, hostLabel(url), message)
          setRemoteNotices([...remoteFailures])
        })
        .catch((error: unknown) => {
          if (cancelled || !image.isConnected) return
          const message = error instanceof Error ? error.message : String(error)
          remoteFailures.push({ host: hostLabel(url), message })
          replaceImage(image, hostLabel(url), message)
          setRemoteNotices([...remoteFailures])
        })
    }

    return () => {
      cancelled = true
    }
  }, [projectId, markdown])

  /** 由事件目标向上找可激活链接；命中即执行并返回 true（外链交系统浏览器，项目内链接应用内跳转）。 */
  const activateLink = (target: HTMLElement): boolean => {
    const external = target.closest('[data-external-url]')
    if (external !== null) {
      void window.workbench.system.openExternal({ url: external.getAttribute('data-external-url') ?? '' })
      return true
    }
    const projectLink = target.closest('[data-project-path]')
    if (projectLink !== null) {
      onNavigateProjectPath(projectLink.getAttribute('data-project-path') ?? '')
      return true
    }
    return false
  }

  const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (target !== null && activateLink(target)) event.preventDefault()
  }

  // 净化层把外链/项目内链接输出为 <a role="link" tabindex="0">（无 href，浏览器不会为其合成 click）；
  // 键盘 Enter/Space 在此委托处理，走与点击完全相同的激活路径。
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
    const target = event.target as HTMLElement | null
    if (target === null || target.closest('[data-external-url], [data-project-path]') === null) return
    event.preventDefault()
    activateLink(target)
  }

  const allNotices: BlockedNotice[] = markdown.blocked

  return (
    <div className="markdown-preview">
      {markdown.truncated ? (
        <p className="inline-warning">文件超过 5 MB，仅显示前 5 MB 内容。完整内容请用外部程序打开。</p>
      ) : null}

      {markdown.violations.length > 0 ? (
        <p className="inline-error">渲染自审发现问题，已拒绝采用该输出：{markdown.violations.join('；')}</p>
      ) : null}

      {assetErrors.length > 0 ? <p className="inline-warning">部分图片未能加载：{assetErrors.join('；')}</p> : null}

      {remoteNotices.length > 0 ? (
        <p className="inline-warning">
          部分网络图片未加载：
          {remoteNotices.map((notice) => `${notice.host}：${notice.message}`).join('；')}
        </p>
      ) : null}

      {remoteImageCount > 0 && onAllowNetworkImagesChange !== undefined ? (
        <label className="remote-image-policy">
          <input
            type="checkbox"
            checked={allowNetworkImages}
            onChange={(event) => onAllowNetworkImagesChange(event.target.checked)}
          />
          <span>允许本项目加载网络图片</span>
          <span className="hint">
            默认不加载。开启后由应用代为抓取，只接受 http/https 的栅格图片，单张不超过 5 MB，
            指向本机或内网的地址一律拒绝。
          </span>
        </label>
      ) : null}

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

      <div
        className="markdown-body"
        ref={hostRef}
        role="document"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容由主进程净化层产出并自审（markdown-sanitize），净化层永不写出 src/href 原始值
        dangerouslySetInnerHTML={{ __html: markdown.html }}
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
