import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cycleTabKey,
  EMPTY_SEARCH_RESULTS,
  isOpenableLink,
  isSessionActive,
  matchTerminalShortcut,
  resolveStartupDirectory,
  searchCountLabel,
  sessionStatusLabel,
  shellDisplayName,
  summarizeSessions,
  tabLabel,
  type TerminalTab
} from '../../src/renderer/src/terminal-model'

function tab(key: number, status: TerminalTab['status'] = 'running'): TerminalTab {
  return {
    key,
    relativePath: '',
    epoch: 0,
    status,
    sessionId: status === 'running' || status === 'starting' ? `session-${key}` : null,
    shell: null,
    exitCode: null,
    error: null
  }
}

test('快捷键：搜索／新建／关闭都要求 Shift，避开浏览器占用', () => {
  assert.equal(matchTerminalShortcut({ key: 'F', ctrlKey: true, metaKey: false, shiftKey: true }), 'search')
  assert.equal(matchTerminalShortcut({ key: 'T', ctrlKey: true, metaKey: false, shiftKey: true }), 'new-tab')
  assert.equal(matchTerminalShortcut({ key: 'W', ctrlKey: true, metaKey: false, shiftKey: true }), 'close-tab')
  assert.equal(matchTerminalShortcut({ key: 'f', ctrlKey: true, metaKey: false, shiftKey: false }), null)
  assert.equal(matchTerminalShortcut({ key: 'w', ctrlKey: true, metaKey: false, shiftKey: false }), null)
  assert.equal(matchTerminalShortcut({ key: 'f', ctrlKey: false, metaKey: false, shiftKey: true }), null)
})

test('快捷键：Cmd 组合在 macOS 上等价生效', () => {
  assert.equal(matchTerminalShortcut({ key: 'f', ctrlKey: false, metaKey: true, shiftKey: true }), 'search')
  assert.equal(matchTerminalShortcut({ key: 'Tab', ctrlKey: false, metaKey: true, shiftKey: false }), 'next-tab')
})

test('快捷键：标签循环与字号调整', () => {
  assert.equal(matchTerminalShortcut({ key: 'Tab', ctrlKey: true, metaKey: false, shiftKey: false }), 'next-tab')
  assert.equal(matchTerminalShortcut({ key: 'Tab', ctrlKey: true, metaKey: false, shiftKey: true }), 'prev-tab')
  for (const key of ['=', '+']) {
    assert.equal(matchTerminalShortcut({ key, ctrlKey: true, metaKey: false, shiftKey: false }), 'font-increase')
  }
  for (const key of ['-', '_']) {
    assert.equal(matchTerminalShortcut({ key, ctrlKey: true, metaKey: false, shiftKey: false }), 'font-decrease')
  }
  assert.equal(matchTerminalShortcut({ key: '0', ctrlKey: true, metaKey: false, shiftKey: false }), 'font-reset')
  assert.equal(matchTerminalShortcut({ key: 'r', ctrlKey: true, metaKey: false, shiftKey: true }), null)
})

test('会话状态机：启动中／运行中才算活动会话', () => {
  assert.equal(isSessionActive('starting'), true)
  assert.equal(isSessionActive('running'), true)
  for (const status of ['idle', 'exited', 'failed'] as const) {
    assert.equal(isSessionActive(status), false)
  }
})

test('状态文案区分退出码与启动失败', () => {
  assert.equal(sessionStatusLabel('idle'), '未启动')
  assert.equal(sessionStatusLabel('starting'), '启动中')
  assert.equal(sessionStatusLabel('running'), '运行中')
  assert.equal(sessionStatusLabel('exited'), '已退出')
  assert.equal(sessionStatusLabel('exited', 0), '已退出（退出码 0）')
  assert.equal(sessionStatusLabel('exited', 1), '已退出（退出码 1）')
  assert.equal(sessionStatusLabel('failed'), '启动失败')
})

test('会话摘要分别计数运行中与启动中', () => {
  assert.equal(summarizeSessions([]), '未创建')
  assert.equal(summarizeSessions([tab(1, 'idle'), tab(2, 'exited')]), '2 个标签')
  assert.equal(summarizeSessions([tab(1), tab(2)]), '2 个会话运行中')
  assert.equal(summarizeSessions([tab(1, 'starting')]), '1 个会话启动中')
  assert.equal(summarizeSessions([tab(1), tab(2), tab(3, 'starting')]), '2 运行中 · 1 启动中')
})

test('标签名：项目根有明确文案', () => {
  assert.equal(tabLabel(''), '项目根目录')
  assert.equal(tabLabel('src/main'), 'src/main')
})

test('启动目录：current 取文件所在目录，否则退回项目根', () => {
  assert.equal(resolveStartupDirectory('root', 'src/main/index.ts'), '')
  assert.equal(resolveStartupDirectory('current', ''), '')
  assert.equal(resolveStartupDirectory('current', 'README.md'), '')
  assert.equal(resolveStartupDirectory('current', 'src/main/index.ts'), 'src/main')
  assert.equal(resolveStartupDirectory('current', 'src\\main\\index.ts'), 'src/main')
})

test('标签循环：首尾相接，活动标签缺失时从端部开始', () => {
  const tabs = [tab(1), tab(2), tab(3)]
  assert.equal(cycleTabKey([], null, 1), null)
  assert.equal(cycleTabKey(tabs, 1, 1), 2)
  assert.equal(cycleTabKey(tabs, 3, 1), 1)
  assert.equal(cycleTabKey(tabs, 1, -1), 3)
  assert.equal(cycleTabKey(tabs, 2, -1), 1)
  assert.equal(cycleTabKey(tabs, 99, 1), 1)
  assert.equal(cycleTabKey(tabs, 99, -1), 3)
  assert.equal(cycleTabKey(tabs, null, 1), 1)
})

test('外部链接只允许 http/https', () => {
  assert.equal(isOpenableLink('https://example.com'), true)
  assert.equal(isOpenableLink('http://localhost:3000/path?q=1'), true)
  assert.equal(isOpenableLink('HTTPS://EXAMPLE.COM'), true)
  for (const uri of [
    'file:///C:/Windows/System32/cmd.exe',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'ftp://example.com/file',
    'mailto:a@example.com',
    'example.com',
    'not a url'
  ]) {
    assert.equal(isOpenableLink(uri), false, uri)
  }
})

test('Shell 显示名：优先实际路径，其次配置值，最后自动探测', () => {
  assert.equal(shellDisplayName('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'cmd'), 'pwsh.exe')
  assert.equal(shellDisplayName('/bin/bash', ''), 'bash')
  assert.equal(shellDisplayName(null, 'cmd'), 'cmd')
  assert.equal(shellDisplayName('', 'pwsh'), 'pwsh')
  assert.equal(shellDisplayName(null, ''), '自动探测')
})

test('搜索计数文案覆盖未输入、无结果与当前序号', () => {
  assert.equal(searchCountLabel('', EMPTY_SEARCH_RESULTS), '输入以搜索')
  assert.equal(searchCountLabel('error', EMPTY_SEARCH_RESULTS), '无结果')
  assert.equal(searchCountLabel('error', { resultIndex: -1, resultCount: 5 }), '5 个匹配')
  assert.equal(searchCountLabel('error', { resultIndex: 0, resultCount: 5 }), '1/5')
  assert.equal(searchCountLabel('error', { resultIndex: 4, resultCount: 5 }), '5/5')
})
