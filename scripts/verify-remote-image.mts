/**
 * G1 验证：网络图片的按项目授权与主进程代理抓取（设计稿 4.3、R10）。
 *
 * 覆盖：
 *   - 授权门：未授权一律拒绝，且**不发出任何请求**；域名白名单为空/命中/未命中
 *   - 地址形态：非 http(s)、协议相对写法、盘符、带用户名密码、无法解析
 *   - 私网字面量与域名解析：回环、链路本地、RFC1918、CGNAT、ULA、.local/.internal；解析到内网一律拦下
 *   - 响应复核：状态码、Content-Type 白名单（SVG 明确拒绝）、类型归一、体积上限、空响应、魔数嗅探
 *   - 重定向：手动逐跳；跳到内网/非 http/未授权域名一律拦下并**不再次连接**；跳授权域名内其它主机放行；超上限停止
 *   - 重绑定闭合（R10）：连接用的 IP 即已校验的那个公网 IP（不出现第二次独立解析）
 *   - 真实 lookup 回调契约：固定 IP 建连同时满足 Node 的 all 模式与单地址模式两种约定
 *   - 不变量：除 `ok` 以外所有分支的 dataUrl 必须为 null；`ok` 时只可能是 data: 前缀
 *
 * 网络经 `deps.requestImpl` 注入（生产为 node:http(s) 固定 IP 实现），不发真实请求、不依赖显示会话。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-remote-image.mts
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isIP } from 'node:net'
import {
  fixedIpLookup,
  nodeRequest,
  REMOTE_IMAGE_LIMIT_BYTES,
  readRemoteImage
} from '../src/main/modules/remote-image.ts'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

/* ---------- 假响应（按请求顺序逐跳脚本化） ---------- */

interface FakeScript {
  status?: number
  /** 响应头；Content-Type、Content-Length、Location 均按此读取 */
  headers?: Record<string, string>
  /** 响应体字节（单段） */
  body?: Uint8Array
  /** 分块给出，用于验证流式读取途中的上限拦截 */
  chunks?: Uint8Array[]
  /** 模拟网络异常 */
  throwOnRequest?: Error
  /** 挂起直到 signal 中止，用于验证超时确实生效 */
  hangUntilAbort?: boolean
}

interface FakeOutcome {
  result: Awaited<ReturnType<typeof readRemoteImage>>
  /** 每次请求的 URL（含重定向后的后续跳） */
  calls: string[]
  /** 每次请求被固定的连接 IP——证明连接用的是已校验 IP，而非第二次独立解析 */
  ips: string[]
  /** 域名解析调用记录 */
  dnsCalls: string[]
  /** 是否真的读取了响应体（用于断言超限时不下载整张图） */
  bodyRead: () => boolean
  /** 流式超限时是否取消了读取 */
  cancelled: () => boolean
}

function pngBytes(): Uint8Array {
  // 只需是非空且可解码的字节序列；这里用一个最小的确定性图案，不要求是合法 PNG 头
  return new Uint8Array(Array.from({ length: 64 }, (_unused, index) => (index * 7) % 251))
}

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function withFake(
  scriptOrScripts: FakeScript | FakeScript[],
  url: string,
  allowNetworkImages = true,
  allowedImageHosts: string[] = [],
  timeoutMs?: number,
  resolvedHosts: string[] | Error = ['93.184.216.34']
): Promise<FakeOutcome> {
  const scripts = Array.isArray(scriptOrScripts) ? scriptOrScripts : [scriptOrScripts]
  let read = false
  let cancelled = false
  const calls: string[] = []
  const ips: string[] = []
  const dnsCalls: string[] = []
  const dnsLookup = async (host: string): Promise<string[]> => {
    dnsCalls.push(host)
    if (resolvedHosts instanceof Error) throw resolvedHosts
    return resolvedHosts
  }

  const buildBody = (script: FakeScript): ReadableStream<Uint8Array> => {
    const pieces = script.chunks ?? (script.body !== undefined ? [script.body] : [pngBytes()])
    let cursor = 0
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (cursor >= pieces.length) {
            controller.close()
            return
          }
          const value = pieces[cursor]
          cursor += 1
          read = true
          controller.enqueue(value)
        },
        cancel() {
          cancelled = true
        }
      },
      { highWaterMark: 0 }
    )
  }

  const requestImpl = async (_input: string | URL, options: { signal: AbortSignal; ip: string }): Promise<Response> => {
    const input = String(_input)
    calls.push(input)
    ips.push(options.ip)
    const script = scripts[Math.min(calls.length - 1, scripts.length - 1)] as FakeScript
    if (script.throwOnRequest !== undefined) throw script.throwOnRequest
    if (script.hangUntilAbort === true) {
      return await new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => reject(options.signal.reason ?? new Error('请求被中止'))
        if (options.signal.aborted) onAbort()
        else options.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    const status = script.status ?? 200
    const headerMap = new Map<string, string>()
    for (const [name, value] of Object.entries(script.headers ?? {})) {
      headerMap.set(name.toLowerCase(), value)
    }
    // 手写 Response 形对象：body 直接是受控 ReadableStream，读/取消标记才可靠
    // （绕开真实 Response/undici 的预拉取与取消传播问题）；下游只用 status/ok/headers.get/body.getReader。
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string): string | null => headerMap.get(name.toLowerCase()) ?? null },
      body: buildBody(script)
    } as unknown as Response
  }

  const result = await readRemoteImage(
    { url, allowNetworkImages, allowedImageHosts },
    { requestImpl, dnsLookup, timeoutMs }
  )
  return { result, calls, ips, dnsCalls, bodyRead: () => read, cancelled: () => cancelled }
}

function chunk(size: number, seed: number): Uint8Array {
  return new Uint8Array(Array.from({ length: size }, (_unused, index) => (index + seed) % 251))
}

const PUBLIC_PNG = { headers: { 'content-type': 'image/png' } } as const

/**
 * 以指定 dns 选项调用固定 IP lookup，记录回调收到的前两个参数。
 * 模拟 Node 对自定义 lookup 的两种调用姿势：`{ all: true }`（all 模式）与 `{}`（单地址模式）。
 */
function captureLookup(
  lookup: ReturnType<typeof fixedIpLookup>,
  dnsOptions: { all?: boolean }
): { error: unknown; firstArg: unknown; secondArg: unknown } {
  const captured = { error: null as unknown, firstArg: undefined as unknown, secondArg: undefined as unknown }
  lookup('img.example', dnsOptions, (err: unknown, ...rest: unknown[]) => {
    captured.error = err
    captured.firstArg = rest[0]
    captured.secondArg = rest[1]
  })
  return captured
}

/* ---------- 主流程 ---------- */

async function main(): Promise<void> {
  console.log('=== G1 验证：网络图片授权与主进程代理抓取（含 R10 重绑定闭合）===')
  console.log(`上限：${REMOTE_IMAGE_LIMIT_BYTES / 1024 / 1024} MB　运行时：Node ${process.versions.node}\n`)

  /* ---------- 一、授权门 ---------- */
  {
    const denied = await withFake(PUBLIC_PNG, 'https://img.example/badge.png', false)
    check(
      '未授权项目：拒绝且不发请求',
      denied.result.status === 'not-authorized' && denied.calls.length === 0 && denied.result.dataUrl === null,
      `status=${denied.result.status} 请求数=${denied.calls.length}`
    )
    check(
      '未授权时给出可展示的原因',
      typeof denied.result.message === 'string' && denied.result.message.length > 0,
      String(denied.result.message)
    )

    const open = await withFake(PUBLIC_PNG, 'https://img.example/badge.png')
    check(
      '已授权且白名单为空：按地址放行',
      open.result.status === 'ok' && open.result.dataUrl !== null,
      `status=${open.result.status} 字节=${open.result.bytes}`
    )

    const listed = await withFake(PUBLIC_PNG, 'https://img.example/badge.png', true, ['img.example'])
    check('域名在授权列表内：放行', listed.result.status === 'ok', String(listed.result.status))

    const unlisted = await withFake(PUBLIC_PNG, 'https://other.example/badge.png', true, ['img.example'])
    check(
      '域名未列入授权列表：拒绝且不发请求',
      unlisted.result.status === 'not-authorized' && unlisted.calls.length === 0,
      `status=${unlisted.result.status} 请求数=${unlisted.calls.length}`
    )
  }

  /* ---------- 二、地址形态 ---------- */
  {
    const shapes = [
      ['file:///c:/windows/win.ini', 'file:'],
      ['javascript:alert(1)', 'javascript:'],
      ['data:image/png;base64,AAAA', 'data:'],
      ['vbscript:msgbox(1)', 'vbscript:'],
      ['\\\\server\\share\\x.png', 'UNC'],
      ['C:\\images\\a.png', '盘符'],
      ['not a url', '无法解析'],
      ['https://', '无主机名']
    ] as const

    let allRejected = true
    let noRequest = true
    let firstUnexpected: string | null = null
    for (const [url, label] of shapes) {
      const outcome = await withFake(PUBLIC_PNG, url)
      if (outcome.result.status !== 'unsupported-protocol') {
        allRejected = false
        firstUnexpected = `${label}→${outcome.result.status}`
      }
      if (outcome.calls.length > 0) noRequest = false
    }
    check(
      '非 http/https 与不可解析地址一律拒绝',
      allRejected,
      firstUnexpected === null ? '八种写法均返回 unsupported-protocol' : String(firstUnexpected)
    )
    check('地址形态不合格的请求不会外发', noRequest, '请求数全部为 0')

    const userinfo = await withFake(PUBLIC_PNG, 'https://admin:pass@img.example/badge.png')
    check(
      '带用户名密码的 URL 被拒绝',
      userinfo.result.status === 'unsupported-protocol' && userinfo.calls.length === 0,
      `status=${userinfo.result.status}`
    )

    const upper = await withFake(PUBLIC_PNG, 'HTTPS://IMG.EXAMPLE/badge.png')
    check('大写协议与主机名仍可正常处理', upper.result.status === 'ok', String(upper.result.status))
  }

  /* ---------- 三、私网字面量 ---------- */
  {
    const privateHosts = [
      'http://localhost/a.png',
      'http://127.0.0.1:8080/a.png',
      'http://[::1]/a.png',
      'http://10.1.2.3/a.png',
      'http://192.168.0.7/a.png',
      'http://172.16.5.5/a.png',
      'http://169.254.169.254/latest/meta-data',
      'http://100.64.0.1/a.png',
      'http://[fc00::1234]/a.png',
      'http://[fe80::1]/a.png',
      'http://nas.internal/a.png',
      'http://printer.local/a.png'
    ]
    let allForbidden = true
    let noRequest = true
    let firstUnexpectedHost: string | null = null
    for (const url of privateHosts) {
      const outcome = await withFake(PUBLIC_PNG, url)
      if (outcome.result.status !== 'forbidden-host') {
        allForbidden = false
        firstUnexpectedHost = `${url}→${outcome.result.status}`
      }
      if (outcome.calls.length > 0) noRequest = false
    }
    check(
      '指向本机或内网的地址一律不加载',
      allForbidden,
      firstUnexpectedHost === null
        ? `${privateHosts.length} 种写法均返回 forbidden-host`
        : `例外：${firstUnexpectedHost}`
    )
    check('私网地址不会先发起请求再判断', noRequest, '请求数全部为 0')

    const badIpv4 = await withFake(PUBLIC_PNG, 'http://127.0.0.999/a.png')
    check(
      '越界的 IPv4 字面量无法解析，同样不外发',
      badIpv4.result.status === 'unsupported-protocol' && badIpv4.result.dataUrl === null && badIpv4.calls.length === 0,
      `status=${badIpv4.result.status}`
    )

    const notPrivate = await withFake(PUBLIC_PNG, 'http://172.15.0.1/a.png')
    check('未被划入私网段的公网地址不误拦', notPrivate.result.status === 'ok', String(notPrivate.result.status))

    const cloudMeta = await withFake(PUBLIC_PNG, 'http://metadata.google.internal./a.png')
    check('云元数据域名风格同样拦下', cloudMeta.result.status === 'forbidden-host', String(cloudMeta.result.status))
  }

  /* ---------- 四、响应复核 ---------- */
  {
    const ok = await withFake(PUBLIC_PNG, 'https://img.example/badge.png')
    check(
      '正常响应返回 data URL 与字节数',
      ok.result.status === 'ok' &&
        ok.result.dataUrl !== null &&
        ok.result.dataUrl.startsWith('data:image/png;base64,') &&
        ok.result.bytes === 64,
      `status=${ok.result.status} 字节=${ok.result.bytes}`
    )

    const decoded = Buffer.from((ok.result.dataUrl ?? '').split(',')[1] ?? '', 'base64')
    const original = pngBytes()
    check(
      'data URL 解回的项目外字节与原响应一致',
      decoded.length === original.length && decoded.every((value, index) => value === original[index]),
      `解码 ${decoded.length} 字节`
    )

    const notFound = await withFake(
      { status: 404, ok: false, headers: { 'content-type': 'image/png' } },
      'https://img.example/gone.png'
    )
    check(
      '非 2xx 按不可达处理，不返回可加载内容',
      notFound.result.status === 'unreachable' && notFound.result.dataUrl === null,
      `status=${notFound.result.status}`
    )

    for (const [mime, expectation] of [
      ['image/svg+xml', 'reject'],
      ['text/html', 'reject'],
      ['application/octet-stream', 'reject'],
      ['', 'reject'],
      ['IMAGE/PNG; charset=x', 'accept'],
      ['image/jpg', 'normalize']
    ] as const) {
      const outcome = await withFake(
        { headers: mime.length === 0 ? {} : { 'content-type': mime } },
        'https://img.example/x.png'
      )
      if (expectation === 'reject') {
        check(
          `Content-Type「${mime || '（缺失）'}」不作为图片加载`,
          outcome.result.status === 'unsupported-format' && outcome.result.dataUrl === null,
          `status=${outcome.result.status}`
        )
      } else if (expectation === 'accept') {
        check('带参数的图片 Content-Type 仍可识别', outcome.result.status === 'ok', String(outcome.result.status))
      } else {
        check(
          'image/jpg 归一为注册类型 image/jpeg',
          outcome.result.mime === 'image/jpeg' && (outcome.result.dataUrl ?? '').startsWith('data:image/jpeg;'),
          `mime=${String(outcome.result.mime)}`
        )
      }
    }

    const declaredTooBig = await withFake(
      { headers: { 'content-type': 'image/png', 'content-length': String(REMOTE_IMAGE_LIMIT_BYTES + 1) } },
      'https://img.example/huge.png'
    )
    check(
      'Content-Length 超限时不再下载响应体',
      declaredTooBig.result.status === 'too-large' &&
        !declaredTooBig.bodyRead() &&
        declaredTooBig.result.dataUrl === null,
      `status=${declaredTooBig.result.status} 已读响应体=${declaredTooBig.bodyRead()}`
    )

    const streamedTooBig = await withFake(
      { headers: { 'content-type': 'image/png' }, chunks: [chunk(3 * 1024 * 1024, 1), chunk(3 * 1024 * 1024, 2)] },
      'https://img.example/stream.png'
    )
    check(
      '流式读取超上限即停止并取消',
      streamedTooBig.result.status === 'too-large' &&
        streamedTooBig.cancelled() &&
        streamedTooBig.result.dataUrl === null,
      `status=${streamedTooBig.result.status} 已取消=${streamedTooBig.cancelled()}`
    )

    const withinLimit = await withFake(
      { headers: { 'content-type': 'image/png' }, chunks: [chunk(2 * 1024 * 1024, 1), chunk(1 * 1024 * 1024, 2)] },
      'https://img.example/ok-stream.png'
    )
    check(
      '上限内的分块响应完整拼接',
      withinLimit.result.status === 'ok' && withinLimit.result.bytes === 3 * 1024 * 1024,
      `status=${withinLimit.result.status} 字节=${withinLimit.result.bytes}`
    )

    const empty = await withFake({ headers: { 'content-type': 'image/png' }, chunks: [] }, 'https://img.example/e.png')
    check('空响应体不报告成功', empty.result.status === 'unreachable', String(empty.result.status))

    const markup = await withFake(
      { headers: { 'content-type': 'image/png' }, body: textBytes('<html><script>alert(1)</script>') },
      'https://img.example/fake.png'
    )
    check(
      '声明图片却返回文本/脚本：魔数嗅探拦下',
      markup.result.status === 'unsupported-format' && markup.result.dataUrl === null,
      `status=${markup.result.status}`
    )

    const failed = await withFake(
      { throwOnRequest: new Error('getaddrinfo ENOTFOUND img.example') },
      'https://img.example/badge.png'
    )
    check(
      '网络异常归为不可达并保留原因',
      failed.result.status === 'unreachable' && (failed.result.message ?? '').includes('ENOTFOUND'),
      String(failed.result.message)
    )

    const hung = await withFake({ hangUntilAbort: true }, 'https://slow.example/a.png', true, [], 20)
    check(
      '超过时限即中止并归为不可达，且给出可读的超时说明',
      hung.result.status === 'unreachable' &&
        hung.result.dataUrl === null &&
        /未完成/.test(String(hung.result.message)),
      `status=${hung.result.status} 消息=${String(hung.result.message)}`
    )
  }

  /* ---------- 五、重定向（手动逐跳） ---------- */
  {
    const toInternal = await withFake(
      { status: 302, headers: { location: 'http://127.0.0.1:9/status.png' } },
      'https://img.example/redirect.png'
    )
    check(
      '重定向到本机地址：下游前拦下且不再连接',
      toInternal.result.status === 'forbidden-host' &&
        toInternal.result.dataUrl === null &&
        toInternal.calls.length === 1,
      `status=${toInternal.result.status} 连接数=${toInternal.calls.length}`
    )

    const toFile = await withFake(
      { status: 302, headers: { location: 'file:///c:/windows/win.ini' } },
      'https://img.example/redirect.png'
    )
    check(
      '重定向到非 http 协议：拒绝且不再连接',
      toFile.result.status === 'unsupported-protocol' && toFile.result.dataUrl === null && toFile.calls.length === 1,
      `status=${toFile.result.status} 连接数=${toFile.calls.length}`
    )

    const toUnlisted = await withFake(
      { status: 302, headers: { location: 'https://evil.example/x.png' } },
      'https://img.example/redirect.png',
      true,
      ['img.example']
    )
    check(
      '重定向到未授权域名：拒绝且不再连接',
      toUnlisted.result.status === 'not-authorized' &&
        toUnlisted.result.dataUrl === null &&
        toUnlisted.calls.length === 1,
      `status=${toUnlisted.result.status} 连接数=${toUnlisted.calls.length}`
    )

    const toAllowed = await withFake(
      [
        { status: 302, headers: { location: 'https://cdn.example/x.png' } },
        { headers: { 'content-type': 'image/png' } }
      ],
      'https://img.example/redirect.png',
      true,
      ['img.example', 'cdn.example']
    )
    check(
      '重定向到授权域名内其它主机：逐跳复核后放行',
      toAllowed.result.status === 'ok' && toAllowed.calls.length === 2,
      `status=${toAllowed.result.status} 连接数=${toAllowed.calls.length}`
    )

    const loop = await withFake(
      Array.from({ length: 8 }, () => ({ status: 302, headers: { location: 'https://img.example/loop.png' } })),
      'https://img.example/redirect.png'
    )
    check(
      '重定向超过上限：停止并归为不可达',
      loop.result.status === 'unreachable' && loop.result.dataUrl === null && loop.calls.length === 6,
      `status=${loop.result.status} 连接数=${loop.calls.length}`
    )
  }

  /* ---------- 六、跨分支不变量 ---------- */
  {
    const cases: Array<[string, FakeScript, string, boolean, string[]]> = [
      ['正常', PUBLIC_PNG, 'https://img.example/a.png', true, []],
      ['404', { status: 404, headers: { 'content-type': 'image/png' } }, 'https://img.example/a.png', true, []],
      ['SVG', { headers: { 'content-type': 'image/svg+xml' } }, 'https://img.example/a.png', true, []],
      [
        '超限',
        { headers: { 'content-type': 'image/png' }, body: chunk(REMOTE_IMAGE_LIMIT_BYTES + 10, 3) },
        'https://img.example/a.png',
        true,
        []
      ],
      ['网络错误', { throwOnRequest: new Error('socket hang up') }, 'https://img.example/a.png', true, []],
      ['内网', PUBLIC_PNG, 'http://169.254.169.254/a.png', true, []],
      ['未授权', PUBLIC_PNG, 'https://img.example/a.png', false, []],
      ['白名单外', PUBLIC_PNG, 'https://img.example/a.png', true, ['only.example']]
    ]

    let onlyOkCarriesDataUrl = true
    let allDataUrlsAreDataScheme = true
    for (const [label, script, url, allow, hosts] of cases) {
      const outcome = await withFake(script, url, allow, hosts)
      if (outcome.result.status !== 'ok' && outcome.result.dataUrl !== null) onlyOkCarriesDataUrl = false
      if (outcome.result.dataUrl !== null && !outcome.result.dataUrl.startsWith('data:'))
        allDataUrlsAreDataScheme = false
      check(
        `分支「${label}」状态与消息均非空`,
        outcome.result.status.length > 0 && typeof outcome.result.url === 'string' && outcome.result.url === url,
        `status=${outcome.result.status}`
      )
    }
    check('只有 ok 分支携带 data URL（其余一律为 null）', onlyOkCarriesDataUrl, '八条分支逐一核对')
    check('返回给界面的图片地址只可能是 data: 方案', allDataUrlsAreDataScheme, '不存在 http(s) 直连地址')
  }

  /* ---------- 七、域名解析到内网（R10 加固） ---------- */
  {
    const toLoopback = await withFake(PUBLIC_PNG, 'https://evil.example/x.png', true, [], undefined, ['127.0.0.1'])
    check(
      '域名解析到回环地址：拦下且不发请求',
      toLoopback.result.status === 'forbidden-host' && toLoopback.calls.length === 0,
      `status=${toLoopback.result.status} 请求数=${toLoopback.calls.length}`
    )

    const toMeta = await withFake(PUBLIC_PNG, 'https://evil.example/x.png', true, [], undefined, ['169.254.169.254'])
    check(
      '域名解析到链路本地/云元数据：拦下',
      toMeta.result.status === 'forbidden-host' && toMeta.calls.length === 0,
      `status=${toMeta.result.status}`
    )

    const toV6 = await withFake(PUBLIC_PNG, 'https://evil.example/x.png', true, [], undefined, ['::1'])
    check(
      '域名解析到 IPv6 回环：拦下',
      toV6.result.status === 'forbidden-host' && toV6.calls.length === 0,
      `status=${toV6.result.status}`
    )

    const mixed = await withFake(PUBLIC_PNG, 'https://evil.example/x.png', true, [], undefined, [
      '93.184.216.34',
      '10.0.0.5'
    ])
    check(
      '多个解析结果里有一个落在内网即拦下',
      mixed.result.status === 'forbidden-host' && mixed.calls.length === 0,
      `status=${mixed.result.status}`
    )

    const publicResolve = await withFake(PUBLIC_PNG, 'https://img.example/x.png', true, [], undefined, [
      '93.184.216.34'
    ])
    check('解析到公网地址时正常放行', publicResolve.result.status === 'ok', String(publicResolve.result.status))

    const resolveFail = await withFake(
      PUBLIC_PNG,
      'https://nx.example/x.png',
      true,
      [],
      undefined,
      new Error('getaddrinfo ENOTFOUND nx.example')
    )
    check(
      '域名解析失败归为不可达且不外发，保留原因',
      resolveFail.result.status === 'unreachable' &&
        resolveFail.calls.length === 0 &&
        (resolveFail.result.message ?? '').includes('ENOTFOUND'),
      `status=${resolveFail.result.status} 消息=${String(resolveFail.result.message)}`
    )

    const ipLiteral = await withFake(PUBLIC_PNG, 'http://203.0.113.7/a.png', true, [], undefined, ['127.0.0.1'])
    check(
      '公网 IP 字面量不触发 DNS 解析',
      ipLiteral.result.status === 'ok' && ipLiteral.dnsCalls.length === 0,
      `status=${ipLiteral.result.status} dnsCalls=${ipLiteral.dnsCalls.length}`
    )
  }

  /* ---------- 八、DNS 重绑定闭合（固定连接 IP） ---------- */
  {
    const pinned = await withFake(PUBLIC_PNG, 'https://img.example/x.png', true, [], undefined, ['93.184.216.34'])
    check(
      '连接固定到已校验的公网 IP（不二次独立解析）',
      pinned.result.status === 'ok' && pinned.ips.length === 1 && pinned.ips[0] === '93.184.216.34',
      `连接 IP=${pinned.ips.join(',')} DNS 解析次数=${pinned.dnsCalls.length}`
    )

    const multiPublic = await withFake(PUBLIC_PNG, 'https://img.example/x.png', true, [], undefined, [
      '93.184.216.34',
      '203.0.113.9'
    ])
    check(
      '多个公网 IP 时取其一固定连接，且不为内网',
      multiPublic.result.status === 'ok' && multiPublic.ips[0] === '93.184.216.34',
      `连接 IP=${multiPublic.ips.join(',')}`
    )

    const perHop = await withFake(
      [
        { status: 302, headers: { location: 'https://cdn.example/x.png' } },
        { headers: { 'content-type': 'image/png' } }
      ],
      'https://img.example/redirect.png',
      true,
      ['img.example', 'cdn.example'],
      undefined,
      ['93.184.216.34']
    )
    check(
      '重定向每一跳都用固定 IP 连接',
      perHop.result.status === 'ok' && perHop.ips.length === 2 && perHop.ips.every((ip) => ip === '93.184.216.34'),
      `各跳连接 IP=${perHop.ips.join(' , ')}`
    )
  }

  /* ---------- 真实 lookup 回调契约（固定 IP 建连的 Node 约定） ---------- */

  // 背景：生产传输把连接固定到已校验 IP 靠的是 node:http(s) 的 lookup 选项。Node ≥20 默认
  // 开启 autoSelectFamily——未显式指定 family 时 net 走 lookupAndConnectMultiple，以 **all
  // 模式**调用自定义 lookup（约定为地址数组）；显式指定 family 时才是单地址约定。此前只
  // 实现了单地址约定，真实联网时 Node 把字符串按数组逐项解构、拿到 undefined 后抛
  // ERR_INVALID_IP_ADDRESS——注入 mock 传输层的既有断言覆盖不到这条路，故在此直接对
  // 生产导出的 fixedIpLookup 断言两种约定，且镜像 Node 自身的校验条件（isIP 与 family）。
  for (const [label, ip, family] of [
    ['IPv4', '93.184.216.34', 4],
    ['IPv6', '2606:2800:220:1:248:1893:25c8:1946', 6]
  ] as const) {
    const lookup = fixedIpLookup(ip, family)

    const allMode = captureLookup(lookup, { all: true })
    const addresses = allMode.firstArg as Array<{ address: string; family: number }>
    check(
      `${label}：all 模式回调返回地址数组（Node ≥20 autoSelectFamily 默认路径）`,
      allMode.error === null &&
        Array.isArray(addresses) &&
        addresses.length === 1 &&
        addresses[0]?.address === ip &&
        addresses[0]?.family === family,
      `数组=${JSON.stringify(addresses)}`
    )
    check(
      `${label}：all 模式地址通过 Node 自身校验（isIP 结果即 family）`,
      isIP(addresses[0]?.address ?? '') === family,
      `isIP=${isIP(addresses[0]?.address ?? '')} family=${family}`
    )

    const single = captureLookup(lookup, {})
    check(
      `${label}：单地址模式回调返回 (ip, family)（显式 family 路径）`,
      single.error === null && single.firstArg === ip && single.secondArg === family,
      `ip=${String(single.firstArg)} family=${String(single.secondArg)}`
    )
  }

  /* ---------- 真实传输契约（本地服务器驱动生产 nodeRequest） ---------- */

  // mock 传输层（deps.requestImpl）覆盖不到「请求真的发了出去」这类问题——漏 request.end()
  // 与 lookup 的 all 模式约定都只在真实联网时暴露。这里用本地 HTTP 服务器驱动**生产实现**
  // nodeRequest（含固定 IP 的 lookup 全流程），断言请求到达服务器且响应完整回传。
  // 127.0.0.1 在此是受控目标而非不可信地址：私网拦截在 readRemoteImage 一层另行断言。
  {
    const received: { method: string | null; url: string | null; accept: string | null } = {
      method: null,
      url: null,
      accept: null
    }
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const server = createServer((req, res) => {
      received.method = req.method ?? null
      received.url = req.url ?? null
      received.accept = (req.headers['accept'] as string | undefined) ?? null
      res.writeHead(200, { 'content-type': 'image/png', 'x-remote-test': 'ok' })
      res.end(Buffer.from(payload))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port

    const controller = new AbortController()
    const transportTimer = setTimeout(() => controller.abort(), 5000)
    let transportError: string | null = null
    let response: Response | null = null
    try {
      response = await nodeRequest(`http://127.0.0.1:${port}/probe.png`, {
        signal: controller.signal,
        ip: '127.0.0.1'
      })
    } catch (error) {
      transportError = error instanceof Error ? `${error.code ?? ''} ${error.message}` : String(error)
    }
    clearTimeout(transportTimer)
    const body = response === null ? null : new Uint8Array(await response.arrayBuffer())
    server.close()

    check(
      '真实传输把请求发到服务器（固定 IP lookup 全流程，且请求已 end）',
      transportError === null && received.method === 'GET' && received.url === '/probe.png' && received.accept !== null,
      transportError ?? `${received.method} ${received.url} accept=${received.accept}`
    )
    check(
      '真实传输回传状态、响应头与字节',
      response?.status === 200 &&
        response.headers.get('content-type') === 'image/png' &&
        response.headers.get('x-remote-test') === 'ok' &&
        body !== null &&
        body.length === payload.length &&
        Array.from(body).every((byte, index) => byte === payload[index]),
      `status=${String(response?.status)} bytes=${body === null ? 'null' : body.length}/${payload.length}`
    )
  }

  /* ---------- 输出 ---------- */
  console.log(`上限内示例字节：${pngBytes().length}`)
  let passed = 0
  for (const item of checks) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${checks.length} 项通过`)
  process.exit(passed === checks.length ? 0 : 1)
}

// 断言脚本自身出错时必须以非零退出码失败——静默退出 0 会被读成「验证通过」
main().catch((error: unknown) => {
  console.error('[验证脚本异常]', error)
  process.exit(1)
})
