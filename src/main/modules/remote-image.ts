import { lookup as dnsLookupNative } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
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
 * **DNS 重新绑定（R10）已闭合**：连接前先解析域名并复核每个 IP；随后**固定用已校验的
 * 那个 IP 建立连接**（`node:http(s)` 的 `lookup` 选项），消除「校验用一次解析、连接又
 * 独立解析一次」的窗口。请求头 `Host` 与 TLS `servername` 仍用原域名，证书照常按名校验。
 * 重定向改为**手动逐跳**（`redirect:'follow'` 会让跳转目标先连后查）：每跳重新走
 * 「地址形态/白名单/私网 → 解析并固定 IP → 连接」并设上限。
 *
 * 固有残余（无法在本层消除，如实保留）：源站可在响应中返回任意内容（靠 MIME 白名单 +
 * 体积上限 + 魔数嗅探收窄）；请求本身会向服务端暴露用户公网 IP（靠默认关闭、按项目授权缓解）。
 *
 * 网络能力经 `deps.requestImpl` 注入，可在纯 Node 下断言。
 */

/** 远程图片字节上限。小于项目内图片阈值：远程内容不受本项目管辖，放宽只会放大风险面 */
export const REMOTE_IMAGE_LIMIT_BYTES = 5 * 1024 * 1024
/** 单次请求超时（含响应体读取） */
export const REMOTE_IMAGE_TIMEOUT_MS = 8000

/** 手动跟随重定向的上限；超过按不可达处理并说明 */
const MAX_REDIRECTS = 5

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

/**
 * 传输 seam：用**已固定**的 IP 发起一次请求，返回真实 `Response`（不跟随重定向——
 * 重定向由 `readRemoteImage` 逐跳处理）。生产为零依赖的 `node:http(s)` 实现。
 */
export type RemoteImageTransport = (url: string, options: { signal: AbortSignal; ip: string }) => Promise<Response>

export interface RemoteImageDeps {
  /** 注入传输；生产为 node:http(s) 固定 IP 实现，验证脚本注入以在纯 Node 断言 */
  requestImpl?: RemoteImageTransport
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
 * 是否指向本机或私网（字面量判定）。
 *
 * README 里的图片地址是不可信输入，放任它回环请求会把「阅读文档」变成一次内网探测
 * （`127.0.0.1` 上的服务、`169.254.169.254` 的实例元数据）。域名的解析结果由
 * `classifyResolvedHost` 在连接前复核，并由固定 IP 建连闭合重绑定。
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

type HostClassification =
  | { status: 'ok'; ips: string[] }
  | { status: 'forbidden-host'; message: string }
  | { status: 'unreachable'; message: string }

/**
 * 域名连接前先解析，任一结果落在本机/内网即拒绝；否则返回**全部公网 IP** 供固定连接使用。
 * 只解析域名：IP 字面量的私网判定已由 `isPrivateHost` 完成，直接以自身作为连接 IP。
 * 解析失败按不可达处理并说明原因——此时真正抓取也会失败，因此不给含糊的「加载失败」。
 */
async function classifyResolvedHost(
  host: string,
  resolveIps: NonNullable<RemoteImageDeps['dnsLookup']>
): Promise<HostClassification> {
  if (isIpLiteral(host)) return { status: 'ok', ips: [host] }

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

  const ips = resolved.filter((ip) => ip.length > 0)
  if (ips.length === 0) {
    return { status: 'unreachable', message: `无法解析域名 ${host}` }
  }
  return { status: 'ok', ips }
}

/** 从 Content-Type 取出 MIME 主体（忽略 `; charset=` 等参数）。 */
function primaryMime(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.split(';')[0]?.trim().toLowerCase()
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed
}

/**
 * 保守魔数嗅探：声明为二进制图片、响应体却以文本/脚本起始，判为类型不符。
 * 只在不含 NUL、且以 `<`/`{`/`(` 等文本标记开头时命中，避免误伤真实图片（PNG/JPEG/ICO 均含 NUL 或非文本首字节）。
 */
function bodyStartsAsTextOrScript(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 16)
  if (head.length === 0) return false
  for (const byte of head) {
    if (byte === 0) return false
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head).trimStart()
  return text.startsWith('<') || text.startsWith('{') || text.startsWith('(')
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
 * 零依赖的生产传输：用 `node:http(s)` 发起一次请求，**连接固定到 `ip`**（`lookup` 回填），
 * 从而不再发生第二次独立的域名解析（闭合 DNS 重绑定）。`Host` 与 TLS `servername` 仍取
 * 自 URL 的域名，证书按名校验不变。`accept-encoding: identity` 让服务端不回压缩，体积上限
 * 与字节一致。不跟随重定向——由调用方逐跳处理。
 */
const nodeRequest: RemoteImageTransport = (url, { signal, ip }) =>
  new Promise<Response>((resolve, reject) => {
    const parsed = new URL(url)
    const family = ip.includes(':') ? 6 : 4
    const options: import('node:http').RequestOptions = {
      method: 'GET',
      signal,
      lookup: (_hostname, _options, callback) => {
        callback(null, ip, family)
      },
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp,image/x-icon,*/*;q=0.5',
        'accept-encoding': 'identity'
      }
    }
    const onResponse = (res: import('node:http').IncomingMessage): void => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (typeof value === 'string') headers.set(name, value)
        else if (Array.isArray(value)) headers.set(name, value.join(', '))
      }
      resolve(
        new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, {
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers
        })
      )
    }
    const request =
      parsed.protocol === 'https:' ? httpsRequest(url, options, onResponse) : httpRequest(url, options, onResponse)
    request.on('error', reject)
  })

/**
 * 换取一张已授权的网络图片。
 *
 * 逐跳循环（含末跳）：地址形态 → 是否私网 → 域名白名单 → 解析并固定一个公网 IP → 连接 →
 * 若 3xx 且有 Location 则取绝对地址进下一跳（重走上面全部复核）；否则进入响应复核
 * （状态 → 类型 → 体积 → 魔数 → 编码）。任一步不过即返回明确状态，不降级为含糊的「加载失败」。
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

  if (hostOf(target) === null) {
    return {
      ...result,
      status: 'unsupported-protocol',
      message: '只接受 http/https 地址，且不接受带用户名密码的写法。'
    }
  }

  const hosts = request.allowedImageHosts ?? []
  const resolveIps = deps.dnsLookup ?? defaultDnsLookup
  const requestImpl = deps.requestImpl ?? nodeRequest
  const controller = new AbortController()
  const timeoutMs = deps.timeoutMs ?? REMOTE_IMAGE_TIMEOUT_MS
  // 计时器刻意不 unref：它必须能把一次卡住的请求叫醒并结束，而不是随事件循环空转被丢弃
  const timer = setTimeout(() => controller.abort(new Error(`请求超过 ${timeoutMs} ms`)), timeoutMs)

  try {
    let currentUrl = target
    let response: Response | null = null

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const currentHost = hostOf(currentUrl)
      if (currentHost === null) {
        return { ...result, status: 'unsupported-protocol', message: '只接受 http/https 地址（含重定向目标）。' }
      }
      if (isPrivateHost(currentHost)) {
        return { ...result, status: 'forbidden-host', message: `该地址指向本机或内网（${currentHost}），不加载。` }
      }
      if (hosts.length > 0 && !hosts.includes(currentHost)) {
        return { ...result, status: 'not-authorized', message: `域名 ${currentHost} 不在授权列表内。` }
      }

      // 连接前解析并固定公网 IP（闭合 DNS 重绑定）
      const classified = await classifyResolvedHost(currentHost, resolveIps)
      if (classified.status !== 'ok') {
        return { ...result, status: classified.status, message: classified.message }
      }
      const ip = classified.ips[0] as string

      response = await requestImpl(currentUrl, { signal: controller.signal, ip })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) break
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }
      break
    }

    if (response === null || response.status >= 300) {
      return { ...result, status: 'unreachable', message: '重定向次数过多或没有最终响应，已停止加载。' }
    }

    if (!response.ok) {
      return { ...result, status: 'unreachable', message: `远端返回 ${response.status}，未加载。` }
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
    if (bodyStartsAsTextOrScript(bytes)) {
      return { ...result, status: 'unsupported-format', message: '远端返回的不是图片内容，未加载。' }
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
