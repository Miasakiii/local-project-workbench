import { lookup as dnsLookupNative } from 'node:dns/promises'
import type { RemoteAssetResult } from '@shared/types'

/**
 * 网络图片读取（设计稿 4.3）。
 *
 * README 里的远程图片**不由渲染进程直连**：渲染进程只能提交「项目 ID + 地址」，
 * 由本模块换取 data URL。理由有三条，缺一即不成立：
 * 1. CSP 为 `img-src 'self' data:`，远程地址在渲染层根本加载不了；放宽 CSP 会同时
 *    放开所有远程内容的加载面，因此改为「输出 data URL」而非「放开协议」。
 * 2. 授权判定必须留在主进程。地址来自不可信文档，若由渲染层自行取舍，
 *    「默认不加载」就退化成一句界面文案。
 * 3. 只有主进程能在拿到响应后复核类型与体积，再决定是否交给界面。
 *
 * 本模块不导入 Electron，网络能力经 `deps.fetchImpl` 注入，可在纯 Node 下断言。
 */

/** 远程图片字节上限。小于项目内图片阈值：远程内容不受本项目管辖，放宽只会放大风险面 */
export const REMOTE_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024
/** 单次请求超时（含响应体读取） */
export const REMOTE_IMAGE_TIMEOUT_MS = 8000

/** 只接受栅格图片。SVG 可携带主动内容，与项目内预览的排除口径一致（设计稿 4.2）。 */
const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
  'image/vnd.microsoft.icon',
  'image/x-icon'
])

/** data URL 里使用的规范 MIME；`image/jpg` 不是注册类型，统一回 `image/jpeg` */
const DATA_URL_MIME: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'image/bmp': 'image/bmp',
  'image/avif': 'image/avif',
  'image/vnd.microsoft.icon': 'image/x-icon',
  'image/x-icon': 'image/x-icon'
}

export interface RemoteImageRequest {
  /** 待加载地址。由净化层标记、渲染层回传，仍按不可信输入处理 */
  url: string
  /** 该项目的授权结论；由主进程从登记记录读出，不接受渲染进程声明 */
  allowNetworkImages: boolean
  /** 授权后仍生效的域名白名单；空表示不额外限制域名 */
  allowedImageHosts?: string[]
}

export interface RemoteImageDeps {
  /** 注入网络能力，使协议、域名、类型、体积与超时判定可在纯 Node 断言 */
  fetchImpl?: typeof fetch
  /** 注入域名解析；生产用 node:dns，验证脚本注入以模拟各类解析结果 */
  dnsLookup?: (host: string) => Promise<string[]>
  /** 覆盖超时（毫秒），仅验证脚本使用；生产走 `REMOTE_IMAGE_TIMEOUT_MS` */
  timeoutMs?: number
}

const base = (url: string): RemoteAssetResult => ({
  status: 'unreachable',
  url,
  mime: null,
  dataUrl: null,
  bytes: 0,
  message: null
})

function hostOf(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // 用户名/密码形式的 URL 一律拒绝：它既能伪装主机，也常被用来绕过主机白名单
    if (parsed.username.length > 0 || parsed.password.length > 0) return null
    // 去掉 IPv6 方括号与 FQDN 结尾的点——尾点会让 `host.internal.` 绕过后缀判定
    return parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
  } catch {
    return null
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/**
 * 是否指向本机或私网。
 *
 * README 里的图片地址是不可信输入，放任它回环请求会把「阅读文档」变成一次内网探测
 * （`127.0.0.1` 上的服务、`169.254.169.254` 的实例元数据）。这里只拦**字面量**形式；
 * 域名的解析结果由 `classifyResolvedHost` 在连接前复核一层（见 R10）。
 */
function isPrivateHost(host: string): boolean {
  if (host.length === 0) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('fc') || host.startsWith('fd')) return true
  if (host.startsWith('fe80')) return true

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map((part) => Number(part))
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
    const [a, b] = parts
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true
    return false
  }

  // 其余 IPv6 私有形态已按前缀处理；含冒号却识别不了的一律按不可信对待
  return isIpLiteral(host)
}

/** 生产域名解析器：解析为全部 A/AAAA 地址。验证脚本经 `deps.dnsLookup` 注入替代。 */
const defaultDnsLookup: NonNullable<RemoteImageDeps['dnsLookup']> = async (host: string): Promise<string[]> => {
  const records = await dnsLookupNative(host, { all: true })
  return records.map((record) => record.address)
}

/**
 * 域名连接前再解析一次，挡住「公网域名经 DNS 解析到内网」（R10 最常见形态）。
 *
 * 只解析域名：IP 字面量的私网判定已由 `isPrivateHost` 完成，无需也不应再解析。
 * 任一解析结果落在本机/内网即拒绝；解析失败按不可达处理并说明原因——此时真正抓取
 * 也会失败，因此不给含糊的「加载失败」。
 *
 * 残余风险如实保留：解析与建立连接之间域名可能被换成内网 IP（DNS 重新绑定竞态），
 * 要闭合它需在拿到 IP 后固定用该 IP 建连，超出本页职责，记为 R10，不假装已防住。
 */
async function classifyResolvedHost(
  host: string,
  resolveIps: NonNullable<RemoteImageDeps['dnsLookup']>
): Promise<
  { status: 'ok' } | { status: 'forbidden-host'; message: string } | { status: 'unreachable'; message: string }
> {
  if (isIpLiteral(host)) return { status: 'ok' }

  let resolved: string[]
  try {
    resolved = await resolveIps(host)
  } catch (error) {
    return {
      status: 'unreachable',
      message: `无法解析域名 ${host}：${error instanceof Error ? error.message : String(error)}`
    }
  }

  for (const ip of resolved) {
    if (isPrivateHost(ip)) {
      return { status: 'forbidden-host', message: `该地址的域名 ${host} 解析到本机或内网（${ip}），不加载。` }
    }
  }
  return { status: 'ok' }
}

/** 从 Content-Type 取出 MIME 主体（忽略 `; charset=` 等参数）。 */
function primaryMime(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.split(';')[0]?.trim().toLowerCase()
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed
}

async function readBodyCapped(response: Response, limit: number): Promise<{ bytes: Uint8Array | null; size: number }> {
  if (typeof response.body !== 'object' || response.body === null) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    return buffer.byteLength > limit
      ? { bytes: null, size: buffer.byteLength }
      : { bytes: buffer, size: buffer.byteLength }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      size += value.byteLength
      // 超限即停：不继续把整张图读进内存
      if (size > limit) {
        await reader.cancel()
        return { bytes: null, size }
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged, size }
}

/**
 * 换取一张已授权的网络图片。
 *
 * 判定顺序固定，任一步不过即返回明确状态，不降级为「加载失败」这类含糊说法：
 * 授权 → 地址形态 → 主机是否私网 → 域名白名单 → 响应状态 → 重定向后的最终地址
 * → 响应类型 → 体积 → 编码。
 */
export async function readRemoteImage(
  request: RemoteImageRequest,
  deps: RemoteImageDeps = {}
): Promise<RemoteAssetResult> {
  const target = request.url.trim()
  const result = base(target)

  if (!request.allowNetworkImages) {
    return { ...result, status: 'not-authorized', message: '本项目未允许加载网络图片。' }
  }

  const host = hostOf(target)
  if (host === null) {
    return {
      ...result,
      status: 'unsupported-protocol',
      message: '只接受 http/https 地址，且不接受带用户名密码的写法。'
    }
  }

  if (isPrivateHost(host)) {
    return {
      ...result,
      status: 'forbidden-host',
      message: `该地址指向本机或内网（${host}），不加载。`
    }
  }

  const hosts = request.allowedImageHosts ?? []
  if (hosts.length > 0 && !hosts.includes(host)) {
    return { ...result, status: 'not-authorized', message: `域名 ${host} 不在授权列表内。` }
  }

  const resolveIps = deps.dnsLookup ?? defaultDnsLookup
  const fetchImpl = deps.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs = deps.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS
  // 计时器刻意不 unref：它必须能把一次卡住的请求叫醒并结束，而不是随事件循环空转被丢弃
  const timer = setTimeout(() => controller.abort(new Error(`请求超过 ${timeoutMs} ms`)), timeoutMs)

  try {
    // 域名在连接前先解析一次：解析到本机/内网的公网域名一律拦下。这挡的是「公网域名常驻
    // 解析到内网」这一最常见形态；解析与建连之间的重新绑定竞态仍列为 R10 残余风险。
    const resolvedHost = await classifyResolvedHost(host, resolveIps)
    if (resolvedHost.status !== 'ok') {
      return { ...result, status: resolvedHost.status, message: resolvedHost.message }
    }

    const response = await fetchImpl(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,image/x-icon,*/*;q=0.5' }
    })

    if (!response.ok) {
      return {
        ...result,
        status: 'unreachable',
        message: `远端返回 ${response.status}，未加载。`
      }
    }

    // 重定向后的最终地址同样要复核：否则「公网地址 302 到 127.0.0.1」可绕过上面的私网判定
    const finalUrl = response.url
    if (typeof finalUrl === 'string' && finalUrl.length > 0) {
      const finalHost = hostOf(finalUrl)
      if (finalHost === null) {
        return { ...result, status: 'unsupported-protocol', message: '重定向到了不受支持的协议。' }
      }
      if (isPrivateHost(finalHost)) {
        return {
          ...result,
          status: 'forbidden-host',
          message: `该地址重定向后指向本机或内网（${finalHost}），已停止加载。`
        }
      }
      if (hosts.length > 0 && !hosts.includes(finalHost)) {
        return { ...result, status: 'not-authorized', message: `重定向后的域名 ${finalHost} 未获授权。` }
      }
    }

    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > REMOTE_IMAGE_LIMIT_BYTES) {
      return {
        ...result,
        status: 'too-large',
        bytes: Number(declared),
        message: `图片超过 ${Math.round(REMOTE_IMAGE_LIMIT_BYTES / 1024 / 1024)} MB，未加载。`
      }
    }

    const mime = primaryMime(response.headers.get('content-type'))
    if (mime === null || !ALLOWED_IMAGE_MIME.has(mime)) {
      return {
        ...result,
        status: 'unsupported-format',
        message: `远端返回的不是受支持的栅格图片${mime === null ? '' : `（${mime}）`}${mime === 'image/svg+xml' ? '，SVG 可携带主动内容' : ''}，未加载。`
      }
    }

    const { bytes, size } = await readBodyCapped(response, REMOTE_IMAGE_LIMIT_BYTES)
    if (bytes === null) {
      return {
        ...result,
        status: 'too-large',
        bytes: size,
        message: `图片超过 ${Math.round(REMOTE_IMAGE_LIMIT_BYTES / 1024 / 1024)} MB，未加载。`
      }
    }
    if (size === 0) {
      return { ...result, status: 'unreachable', message: '远端返回空内容。' }
    }

    return {
      status: 'ok',
      url: target,
      mime: DATA_URL_MIME[mime] ?? mime,
      dataUrl: `data:${DATA_URL_MIME[mime] ?? mime};base64,${Buffer.from(bytes).toString('base64')}`,
      bytes: size,
      message: null
    }
  } catch (error) {
    return {
      ...result,
      status: 'unreachable',
      message: `无法取得该图片：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    clearTimeout(timer)
  }
}
