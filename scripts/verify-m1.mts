/**
 * M1 验证：项目登记与只读浏览。
 *
 * 对应推进计划 M1 退出条件：
 *   - 验收场景 1：打开同一路径两次只产生一条记录；应用重启后记录仍在；移除记录后磁盘文件仍在。
 *   - 验收场景 3：README 的项目内相对图片可正确显示；脚本与项目外路径被阻止。
 *   - 验收场景 9：非 Git 目录可用，界面不误报为错误状态。
 *   - 无 README 的项目可用（M1-6）。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/ts-loader/register.mjs scripts/verify-m1.mts
 */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { highlightCode } from '../src/main/modules/code-highlight.ts'
import { listDirectory, previewFile } from '../src/main/modules/file-browser.ts'
import { detectReadme, renderMarkdownFile } from '../src/main/modules/markdown-preview.ts'
import { createRegistry, createRegistryStore, toSummary } from '../src/main/modules/project-registry.ts'

const keepFixture = process.argv.includes('--keep')
const root = join(tmpdir(), 'workbench-m1-fixture')
const appDataDir = join(root, 'app-data')
const projectDir = join(root, 'sample-project')
const plainDir = join(root, 'plain-directory')
const outsideDir = join(root, 'outside')

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

const README = [
  '# 示例项目',
  '',
  '这是一个用于验证 M1 的示例项目，第一段正文应被提取为项目简介。',
  '',
  '![项目内图片](assets/logo.png)',
  '![项目外图片](../../outside/secret.png)',
  '',
  '<script>alert("xss")</script>',
  '',
  '[外链](https://example.com/docs)',
  '[项目内文档](docs/guide.md)',
  ''
].join('\n')

const CHECKS: Array<{ name: string; pass: boolean; detail: string }> = []
function check(name: string, pass: boolean, detail: string): void {
  CHECKS.push({ name, pass, detail })
}

function buildFixture(): void {
  const junction = join(projectDir, 'junction')
  try {
    rmSync(junction, { force: true })
  } catch {
    // 忽略
  }
  rmSync(root, { recursive: true, force: true })

  mkdirSync(join(projectDir, 'assets'), { recursive: true })
  mkdirSync(join(projectDir, 'docs'), { recursive: true })
  mkdirSync(join(projectDir, 'src'), { recursive: true })
  mkdirSync(join(projectDir, 'empty-folder'), { recursive: true })
  mkdirSync(plainDir, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })
  mkdirSync(appDataDir, { recursive: true })

  writeFileSync(join(outsideDir, 'secret.png'), PNG_BYTES)

  writeFileSync(join(projectDir, 'README.md'), README)
  writeFileSync(join(projectDir, 'README.zh-CN.md'), '# 中文说明\n\n中文简介。\n')
  writeFileSync(join(projectDir, 'assets', 'logo.png'), PNG_BYTES)
  writeFileSync(join(projectDir, 'docs', 'guide.md'), '# 指南\n')
  writeFileSync(
    join(projectDir, 'src', 'sample.ts'),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是写入夹具文件的 TypeScript 源码，${name} 是目标文件里的模板占位符，不是本文件的插值
    '// 示例\nconst value: number = 42\nfunction greet(name: string): string {\n  return `hello ${name}`\n}\n'
  )
  writeFileSync(join(projectDir, 'notes.txt'), '第一行\n第二行\n')
  writeFileSync(join(projectDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))
  writeFileSync(join(projectDir, 'legacy.txt'), Buffer.from([0xb0, 0xa1, 0xb0, 0xa1, 0xb2, 0xe2, 0xca, 0xd4]))
  writeFileSync(join(projectDir, 'active.svg'), '<svg onload="alert(1)"></svg>')
  writeFileSync(join(projectDir, 'plain-directory-marker.txt'), 'x')

  // 目录联接：指向同一项目的另一种路径写法，用于验证去重基于真实路径身份
  symlinkSync(projectDir, join(root, 'project-alias'), process.platform === 'win32' ? 'junction' : 'dir')
  // 指向项目外的联接：用于验证浏览阶段不放行项目外目标
  symlinkSync(outsideDir, junction, process.platform === 'win32' ? 'junction' : 'dir')
}

function cleanup(): void {
  for (const link of [join(root, 'project-alias'), join(projectDir, 'junction')]) {
    try {
      rmSync(link, { force: true })
    } catch {
      // 忽略
    }
  }
  rmSync(root, { recursive: true, force: true })
}

function main(): void {
  buildFixture()

  const storePath = join(appDataDir, 'projects.json')
  const registry = createRegistry(createRegistryStore(storePath))
  const describe = (project: {
    normalizedIdentity: string
    descriptionOverride: string | null
    readmePath: string | null
  }): {
    text: string | null
    source: 'user' | 'readme' | 'path'
  } => {
    if (project.descriptionOverride !== null) return { text: project.descriptionOverride, source: 'user' }
    const detection = detectReadme(project.normalizedIdentity, project.readmePath)
    if (detection.selected === null) return { text: project.normalizedIdentity, source: 'path' }
    const document = renderMarkdownFile({
      projectId: 'probe',
      projectRoot: project.normalizedIdentity,
      relativePath: detection.selected
    })
    const firstParagraph = document.html.match(/<p>([\s\S]*?)<\/p>/)
    if (firstParagraph === null) return { text: project.normalizedIdentity, source: 'path' }
    const text = (firstParagraph[1] as string).replace(/<[^>]*>/g, '').trim()
    return text.length > 0 ? { text, source: 'readme' } : { text: project.normalizedIdentity, source: 'path' }
  }

  /* ---------- 验收场景 1：登记、去重、重启保留、移除不删磁盘 ---------- */

  const first = registry.register(projectDir)
  check('登记新目录', first.status === 'added' && first.project !== null, `status=${first.status}`)

  const again = registry.register(projectDir)
  check(
    '同一路径重复登记不新增记录',
    again.status === 'existing' && registry.list().length === 1,
    `status=${again.status} 记录数=${registry.list().length}`
  )

  const viaAlias = registry.register(join(root, 'project-alias'))
  check(
    '经目录联接的同一目录被识别为已登记',
    viaAlias.status === 'existing' && registry.list().length === 1,
    `status=${viaAlias.status} 记录数=${registry.list().length}`
  )

  const caseVariant = process.platform === 'win32' ? projectDir.toUpperCase() : projectDir
  const viaCase = registry.register(caseVariant)
  check(
    '大小写不同的同一路径被识别为已登记',
    viaCase.status === 'existing' && registry.list().length === 1,
    `status=${viaCase.status}（输入 ${caseVariant}）`
  )

  const trailing = registry.register(`${projectDir}${process.platform === 'win32' ? '\\' : '/'}`)
  check('带尾部分隔符的同一路径被识别为已登记', trailing.status === 'existing', `status=${trailing.status}`)

  // 重启：新建 store 实例读取同一文件
  const reloaded = createRegistry(createRegistryStore(storePath))
  check('重启后记录仍在', reloaded.list().length === 1, `记录数=${reloaded.list().length}`)

  const plain = reloaded.register(plainDir)
  check('普通目录（非 Git）可登记', plain.status === 'added', `status=${plain.status}`)
  check(
    '登记不改变 Git 属性初值',
    plain.project?.isGitRepository === null,
    `isGitRepository=${String(plain.project?.isGitRepository)}`
  )

  const missing = reloaded.register(join(root, 'does-not-exist'))
  check('目录不存在时明确拒绝', missing.status === 'unavailable' && missing.message !== null, String(missing.message))

  // 移除登记：记录消失，磁盘保留
  const targetId = first.project?.id ?? ''
  const removed = reloaded.remove(targetId)
  check('移除登记返回成功', removed, `removed=${String(removed)}`)
  check('移除后记录减少', reloaded.list().length === 1, `记录数=${reloaded.list().length}`)
  check(
    '移除登记不删除磁盘文件',
    existsSync(join(projectDir, 'README.md')) && existsSync(join(projectDir, 'assets', 'logo.png')),
    'README 与图片仍在'
  )

  /* ---------- 置顶与最近打开排序 ---------- */

  const afterRemove = createRegistry(createRegistryStore(storePath))
  const plainId = afterRemove.list()[0]?.id ?? ''
  afterRemove.update(plainId, { pinned: true })
  const reAdded = afterRemove.register(projectDir)
  const summaries = afterRemove
    .list()
    .map((project) => toSummary(project, describe))
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return right.lastOpenedAt.localeCompare(left.lastOpenedAt)
    })
  check('置顶项目排在首位', summaries[0]?.pinned === true, `首位=${summaries[0]?.displayName ?? '无'}`)
  check('列表包含两个项目', summaries.length === 2, `数量=${summaries.length}`)

  const beforeTouch = afterRemove.get(reAdded.project?.id ?? '')?.lastOpenedAt ?? ''
  afterRemove.touch(reAdded.project?.id ?? '')
  const afterTouch = afterRemove.get(reAdded.project?.id ?? '')?.lastOpenedAt ?? ''
  check(
    '打开项目刷新最近打开时间',
    afterTouch >= beforeTouch && afterTouch.length > 0,
    `${beforeTouch} → ${afterTouch}`
  )

  /* ---------- 视图状态持久化 ---------- */

  afterRemove.saveViewState({
    projectId: reAdded.project?.id ?? '',
    page: 'files',
    relativePath: 'docs',
    scrollTop: 120,
    terminalPanelHeight: 320,
    filesPaneWidth: 460
  })
  const restored = createRegistry(createRegistryStore(storePath)).getViewState(reAdded.project?.id ?? '')
  check(
    '视图状态可持久化并恢复',
    restored?.page === 'files' &&
      restored.relativePath === 'docs' &&
      restored.terminalPanelHeight === 320 &&
      restored.filesPaneWidth === 460,
    `page=${String(restored?.page)} path=${String(restored?.relativePath)} 面板高=${String(restored?.terminalPanelHeight)} 分栏宽=${String(restored?.filesPaneWidth)}`
  )

  // 旧版本记录缺少新字段时应回退默认值，而不是写入 undefined
  const legacyStorePath = join(appDataDir, 'legacy-view-state.json')
  writeFileSync(
    legacyStorePath,
    JSON.stringify({
      version: 1,
      data: {
        projects: [],
        viewStates: [
          {
            projectId: 'legacy',
            page: 'overview',
            relativePath: '',
            scrollTop: 0,
            terminalPanelHeight: 300
          }
        ]
      }
    }),
    'utf8'
  )
  const legacyState = createRegistryStore(legacyStorePath).read().viewStates[0]
  check(
    '缺少新字段的旧视图状态回退默认值',
    legacyState?.filesPaneWidth === 380 && legacyState?.terminalPanelHeight === 300,
    `分栏宽=${String(legacyState?.filesPaneWidth)} 面板高=${String(legacyState?.terminalPanelHeight)}`
  )

  /* ---------- 存储容错 ---------- */

  const corruptPath = join(appDataDir, 'corrupt.json')
  writeFileSync(corruptPath, '{ this is not json')
  const corruptStore = createRegistryStore(corruptPath)
  const recovered = corruptStore.read()
  check('元数据损坏时回退默认值且不抛异常', recovered.projects.length === 0, `记录数=${recovered.projects.length}`)

  /* ---------- 项目简介来源 ---------- */

  const withReadme = summaries.find((project) => project.normalizedIdentity === first.project?.normalizedIdentity)
  check(
    '简介优先取自 README 首段',
    withReadme?.descriptionSource === 'readme' && (withReadme?.description ?? '').includes('示例项目'),
    `source=${String(withReadme?.descriptionSource)} text=${String(withReadme?.description).slice(0, 40)}`
  )

  const plainSummary = summaries.find((project) => project.normalizedIdentity === plain.project?.normalizedIdentity)
  check(
    '无 README 时回退到路径且项目仍可用',
    plainSummary?.descriptionSource === 'path' && plainSummary?.available === true,
    `source=${String(plainSummary?.descriptionSource)} available=${String(plainSummary?.available)}`
  )

  /* ---------- 目录不可用时的表达 ---------- */

  const unavailableDir = join(root, 'will-disappear')
  mkdirSync(unavailableDir, { recursive: true })
  const temp = afterRemove.register(unavailableDir)
  rmSync(unavailableDir, { recursive: true, force: true })
  const unavailableSummary = afterRemove
    .list()
    .map((project) => toSummary(project, describe))
    .find((project) => project.id === temp.project?.id)
  check(
    '目录消失后标记为不可用并给出原因',
    unavailableSummary?.available === false && (unavailableSummary?.unavailableReason ?? '').length > 0,
    String(unavailableSummary?.unavailableReason)
  )
  check('不可用项目仍保留在列表中', unavailableSummary !== undefined, `记录数=${afterRemove.list().length}`)
  const resolveFailed = afterRemove.resolveRoot(temp.project?.id ?? '')
  check(
    '不可用项目的根目录解析被拒绝',
    resolveFailed.ok === false,
    resolveFailed.ok ? '意外成功' : resolveFailed.reason
  )

  /* ---------- 验收场景 3：README 图片放行、脚本与外链阻止 ---------- */

  const readme = renderMarkdownFile({
    projectId: 'probe',
    projectRoot: projectDir,
    relativePath: 'README.md'
  })
  check('README 自审无违规', readme.violations.length === 0, readme.violations.join('；') || '无')
  check(
    '项目内相对图片被解析为待加载资源',
    readme.assets.length === 1 && readme.assets[0] === 'assets/logo.png',
    readme.assets.join(', ')
  )
  check('输出不含任何可加载 src', !/\ssrc\s*=/i.test(readme.html), '已确认')
  check('脚本被移除', !/<script/i.test(readme.html) && !/alert/i.test(readme.html), '已确认')
  check(
    '项目外图片被阻止',
    readme.blocked.some((notice) => notice.kind === 'image' && notice.reason === 'outside-project'),
    readme.blocked.map((notice) => notice.reason).join(', ')
  )
  check('外链计入待外部打开', readme.externalLinkCount >= 1, `externalLinkCount=${readme.externalLinkCount}`)
  check('项目内链接可被识别', readme.projectLinks.includes('docs/guide.md'), readme.projectLinks.join(', '))

  /* ---------- 文件列表 ---------- */

  const listing = listDirectory({ projectRoot: projectDir, relativePath: '' })
  check('根目录列表可读取', listing.error === null, String(listing.error))
  check('目录排在文件之前', listing.entries[0]?.kind === 'directory', `首项=${String(listing.entries[0]?.name)}`)
  check(
    '目录内条目完整',
    ['assets', 'docs', 'src', 'empty-folder'].every((name) => listing.entries.some((entry) => entry.name === name)),
    listing.entries.map((entry) => entry.name).join(', ')
  )
  check(
    '文件条目带尺寸与时间',
    listing.entries.some(
      (entry) => entry.name === 'README.md' && entry.size > 0 && !entry.modifiedAt.startsWith('1970')
    ),
    'README.md 有尺寸与时间'
  )
  check('根目录面包屑为空', listing.breadcrumb.length === 0, `长度=${listing.breadcrumb.length}`)

  const nested = listDirectory({ projectRoot: projectDir, relativePath: 'src' })
  check(
    '子目录列表与面包屑正确',
    nested.error === null &&
      nested.breadcrumb.length === 1 &&
      nested.breadcrumb[0]?.name === 'src' &&
      nested.entries.some((entry) => entry.name === 'sample.ts'),
    `面包屑=${nested.breadcrumb.map((crumb) => crumb.name).join('/')}`
  )

  const escapeList = listDirectory({ projectRoot: projectDir, relativePath: '../outside' })
  check('浏览项目外目录被拒绝', escapeList.error !== null, String(escapeList.error))

  const junctionList = listDirectory({ projectRoot: projectDir, relativePath: 'junction' })
  check('浏览经目录联接指向项目外被拒绝', junctionList.error !== null, String(junctionList.error))

  /* ---------- 文件预览 ---------- */

  const markdownPreview = previewFile({ projectRoot: projectDir, relativePath: 'README.md' })
  check(
    'Markdown 预览返回渲染结果',
    markdownPreview.kind === 'markdown' && markdownPreview.markdown !== null,
    `kind=${markdownPreview.kind}`
  )

  const codePreview = previewFile({ projectRoot: projectDir, relativePath: 'src/sample.ts' })
  check(
    '代码预览含语言、行号与高亮',
    codePreview.kind === 'code' &&
      codePreview.language === 'typescript' &&
      codePreview.lineCount === 6 &&
      (codePreview.highlightedHtml ?? '').includes('tok-keyword') &&
      (codePreview.highlightedHtml ?? '').includes('data-line="1"'),
    `kind=${codePreview.kind} language=${String(codePreview.language)} lines=${String(codePreview.lineCount)}`
  )
  check('高亮输出不含未转义的尖括号', !/<(?!\/?span)/.test(codePreview.highlightedHtml ?? ''), '仅包含 span 标签')

  const textPreview = previewFile({ projectRoot: projectDir, relativePath: 'notes.txt' })
  check(
    '纯文本预览返回内容与行数',
    textPreview.kind === 'text' && textPreview.text === '第一行\n第二行\n' && textPreview.lineCount === 3,
    `kind=${textPreview.kind} lines=${String(textPreview.lineCount)}`
  )

  const imagePreview = previewFile({ projectRoot: projectDir, relativePath: 'assets/logo.png' })
  check(
    '图片预览返回 data URL',
    imagePreview.kind === 'image' &&
      imagePreview.image?.status === 'ok' &&
      (imagePreview.image?.dataUrl ?? '').startsWith('data:image/png;base64,'),
    `status=${String(imagePreview.image?.status)}`
  )

  const binaryPreview = previewFile({ projectRoot: projectDir, relativePath: 'binary.bin' })
  check(
    '二进制文件给出明确说明而非空白页',
    binaryPreview.kind === 'unsupported' && (binaryPreview.message ?? '').includes('二进制'),
    String(binaryPreview.message)
  )

  const legacyPreview = previewFile({ projectRoot: projectDir, relativePath: 'legacy.txt' })
  check(
    '非 UTF-8 文件给出编码说明',
    legacyPreview.kind === 'unsupported' && (legacyPreview.message ?? '').includes('UTF-8'),
    String(legacyPreview.message)
  )

  const svgPreview = previewFile({ projectRoot: projectDir, relativePath: 'active.svg' })
  check(
    'SVG 不作为图片渲染',
    svgPreview.kind === 'unsupported' && (svgPreview.message ?? '').includes('主动内容'),
    String(svgPreview.message)
  )

  const dirPreview = previewFile({ projectRoot: projectDir, relativePath: 'docs' })
  check('对目录请求预览被拒绝', dirPreview.kind === 'error', String(dirPreview.message))

  const escapePreview = previewFile({ projectRoot: projectDir, relativePath: 'junction/secret.png' })
  check('预览经目录联接指向项目外的文件被拒绝', escapePreview.kind === 'error', String(escapePreview.message))

  /* ---------- 高亮转义安全性 ---------- */

  const dangerous = highlightCode('<script>alert(1)</script>\nconst a = "</code>"', 'typescript')
  check(
    '高亮对源码中的标签做转义',
    !/<script/i.test(dangerous.html) && dangerous.html.includes('&lt;script&gt;'),
    '已转义'
  )

  /* ---------- 无 README 项目的降级（M1-6） ---------- */

  const plainDetection = detectReadme(plainDir)
  check(
    '无 README 时明确返回未找到',
    plainDetection.selected === null && plainDetection.variants.length === 0,
    `selected=${String(plainDetection.selected)}`
  )
  const plainListing = listDirectory({ projectRoot: plainDir, relativePath: '' })
  check('无 README 的目录仍可浏览', plainListing.error === null, String(plainListing.error))

  /* ---------- 输出 ---------- */

  console.log('=== M1 验证：项目登记与只读浏览 ===')
  console.log(`样例目录：${root}`)
  console.log(`运行时：Node ${process.versions.node}　平台：${process.platform}\n`)

  let passed = 0
  for (const item of CHECKS) {
    if (item.pass) passed += 1
    console.log(`${item.pass ? '[通过]' : '[失败]'} ${item.name} — ${item.detail}`)
  }
  console.log(`\n合计：${passed}/${CHECKS.length} 项通过`)

  if (keepFixture) console.log(`\n样例目录已保留：${root}`)
  else cleanup()

  process.exit(passed === CHECKS.length ? 0 : 1)
}

main()
