/**
 * G1 验证：网络图片的按项目授权与主进程代理抓取（设计稿 4.3）。
 *
 * 覆盖：
 *   - 授权门：未授权一律拒绝，且**不发出任何请求**；域名白名单为空/命中/未命中
 *   - 地址形态：非 http(s)、协议相对写法、盘符、带用户名密码、无法解析
 *   - 私网字面量：回环、链路本地、RFC1918、CGNAT、ULA、.local/.internal
 *   - 响应复核：状态码、Content-Type 白名单（SVG 明确拒绝）、类型归一、体积上限、空响应
 *   - 重定向复核：跳到内网/非 http/未授权域名一律拦下，且不返回任何可加载内容
 *   - 不变量：除 `ok` 以外所有分支的 dataUrl 必须为 null；`ok` 时只可能是 data: 前缀
 *
 * 网络经 `deps.fetchImpl` 注入，不发真实请求、不依赖显示会话。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/ts-loader/register.mjs scripts/verify-remote-image.mts
 */

import { REMOTE_IMAGE_LIMIT_BYTES, readRemoteImage } from '../src/main/modules/remote-image.ts'

interface Check {
  name: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
}

/* ---------- 假响应 ---------- */

interface FakeScript {
  status?: number
  ok?: boolean
  /** 响应头；Content-Type 与 Content-Length 按此读取 */
  headers?: Record<string, string>
  /** 重定向后的最终地址（fetch 会跟随重定向，response.url 即最终地址） */
  url?: string
  /** 响应体字节。给了 chunks 就走 ReadableStream，否则走 arrayBuffer */
  body?: Uint8Array
  /** 分块给出，用于验证流式读取途中的上限拦截 */
  chunks?: Uint8Array[]
  /** 模拟网络异常 */
  throwOnFetch?: Error
  /** 挂起直到 signal 中止，用于验证超时确实生效 */
  hangUntilAbort?: boolean
}

interface FakeOutcome {
  result: Awaited<ReturnType<typeof readRemoteImage>>
  /** 是否真的读取了响应体（用于断言超限时不下载整张图） */
  bodyRead: () => boolean
  /** 流式超限时是否取消了读取 */
  cancelled: () => boolean
}

function pngBytes(): Uint8Array {
  // 只需是非空且可解码的字节序列；这里用一个最小的确定性图案，不要求是合法 PNG 头
  return new Uint8Array(Array.from({ length: 64 }, (_unused, index) => (index * 7) % 251))
}

async function withFake(
  script: FakeScript,
  url: string,
  allowNetworkImages = true,
  allowedImageHosts: string[] = [],
  timeoutMs?: number,
  resolvedHosts: string[] | Error = ['93.184.216.34']
) {
  /** 响应体是否真的被消费过——超限时应当一次都不读 */
  let read = false
  let cancelled = false
  const calls: string[] = []
  const dnsCalls: string[] = []
  /** 默认解析到一个公网 IP，使既有「已授权即放行」用例不因真实 DNS 而变化；传入 Error 可模拟解析失败 */
  const dnsLookup = async (host: string): Promise<string[]> => {
    dnsCalls.push(host)
    if (resolvedHosts instanceof Error) throw resolvedHosts
    return resolvedHosts
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input))
    if (script.throwOnFetch !== undefined) throw script.throwOnFetch

    if (script.hangUntilAbort === true) {
      const signal = init?.signal
      throw await new Promise((_resolve, reject) => {
        const rejectWithAbort = (): void => reject(signal?.reason ?? new Error('请求被中止'))
        if (signal?.aborted === true) {
          rejectWithAbort()
          return
        }
        signal?.addEventListener('abort', rejectWithAbort, { once: true })
      })
    }

    const status = script.status ?? 200
    const ok = script.ok ?? (status >= 200 && status < 300)
    const headers = new Map(Object.entries(script.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
    const body = script.body ?? (script.chunks === undefined ? pngBytes() : undefined)

    const headersView = {
      get: (name: string): string | null => headers.get(name.toLowerCase()) ?? null
    }

    if (body !== undefined) {
      return {
        status,
        ok,
        url: script.url ?? url,
        headers: headersView,
        body: null,
        arrayBuffer: async () => {
          read = true
          return body.slice().buffer
        }
      }
    }

    const chunks = script.chunks ?? []
    let cursor = 0
    return {
      status,
      ok,
      url: script.url ?? url,
      headers: headersView,
      body: {
        getReader: () => ({
          read: async () => {
            if (cursor >= chunks.length) return { done: true, value: undefined }
            const value = chunks[cursor]
            cursor += 1
            read = true
            return { done: false, value }
          },
          cancel: async () => {
            cancelled = true
          }
        })
      },
      arrayBuffer: async () => new Uint8Array(0).buffer
    }
  }) as unknown as typeof fetch

  const result = await readRemoteImage(
    { url, allowNetworkImages, allowedImageHosts },
    { fetchImpl, dnsLookup, timeoutMs }
  )
  const outcome: FakeOutcome = { result, bodyRead: () => read, cancelled: () => cancelled }
  return { ...outcome, calls, dnsCalls }
}

function chunk(size: number, seed: number): Uint8Array {
  return new Uint8Array(Array.from({ length: size }, (_unused, index) => (index + seed) % 251))
}

const PUBLIC_PNG = { headers: { 'content-type': 'image/png' } } as const

/* ---------- 主流程 ---------- */

async function main(): Promise<void> {
  console.log('=== G1 验证：网络图片授权与主进程代理抓取 ===')
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

    const failed = await withFake(
      { throwOnFetch: new Error('getaddrinfo ENOTFOUND img.example') },
      'https://img.example/badge.png'
    )
    check(
      '网络异常归为不可达并保留原因',
      failed.result.status === 'unreachable' && (failed.result.message ?? '').includes('ENOTFOUND'),
      String(failed.result.message)
    )

    const hung = await withFake({ hangUntilAbort: true }, 'https://slow.example/a.png', true, [], 20)
    check(
      '超过时限即中止并归为不可达',
      hung.result.status === 'unreachable' && hung.result.dataUrl === null,
      `status=${hung.result.status} 消息=${String(hung.result.message)}`
    )
  }

  /* ---------- 五、重定向复核 ---------- */
  {
    const toInternal = await withFake(
      { url: 'http://127.0.0.1:9/status.png', headers: { 'content-type': 'image/png' } },
      'https://img.example/redirect.png'
    )
    check(
      '重定向到本机地址：拦下且不返回内容',
      toInternal.result.status === 'forbidden-host' && toInternal.result.dataUrl === null,
      `status=${toInternal.result.status}`
    )

    const toFile = await withFake(
      { url: 'file:///c:/windows/win.ini', headers: { 'content-type': 'image/png' } },
      'https://img.example/redirect.png'
    )
    check(
      '重定向到非 http 协议：拒绝',
      toFile.result.status === 'unsupported-protocol' && toFile.result.dataUrl === null,
      `status=${toFile.result.status}`
    )

    const toUnlisted = await withFake(
      { url: 'https://evil.example/x.png', headers: { 'content-type': 'image/png' } },
      'https://img.example/redirect.png',
      true,
      ['img.example']
    )
    check(
      '重定向到未授权域名：拒绝',
      toUnlisted.result.status === 'not-authorized' && toUnlisted.result.dataUrl === null,
      `status=${toUnlisted.result.status}`
    )

    const toAllowed = await withFake(
      { url: 'https://cdn.example/x.png', headers: { 'content-type': 'image/png' } },
      'https://img.example/redirect.png',
      true,
      ['img.example', 'cdn.example']
    )
    check('重定向到授权域名内其它主机：放行', toAllowed.result.status === 'ok', String(toAllowed.result.status))
  }

  /* ---------- 六、跨分支不变量 ---------- */
  {
    const cases: Array<[string, FakeScript, string, boolean, string[]]> = [
      ['正常', PUBLIC_PNG, 'https://img.example/a.png', true, []],
      [
        '404',
        { status: 404, ok: false, headers: { 'content-type': 'image/png' } },
        'https://img.example/a.png',
        true,
        []
      ],
      ['SVG', { headers: { 'content-type': 'image/svg+xml' } }, 'https://img.example/a.png', true, []],
      [
        '超限',
        { headers: { 'content-type': 'image/png' }, body: chunk(REMOTE_IMAGE_LIMIT_BYTES + 10, 3) },
        'https://img.example/a.png',
        true,
        []
      ],
      ['网络错误', { throwOnFetch: new Error('socket hang up') }, 'https://img.example/a.png', true, []],
      ['内网', PUBLIC_PNG, 'http://169.254.169.254/a.png', true, []],
      ['未授权', PUBLIC_PNG, 'https://img.example/a.png', false, []],
      ['白名单外', PUBLIC_PNG, 'https://img.example/a.png', true, ['only.example']]
    ]

    let onlyOkCarriesDataUrl = true
    let allDataUrlsAreDataScheme = true
    for (const [label, script, url, allowNetworkImages, hosts] of cases) {
      const outcome = await withFake(script, url, allowNetworkImages, hosts)
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
