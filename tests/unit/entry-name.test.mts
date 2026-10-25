import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeEntryName, normalizeRenameName } from '../../src/main/modules/entry-name'

const isWindows = process.platform === 'win32'

test('接受常规单段名称', () => {
  for (const name of ['README.md', '中文 文件名.txt', 'a-b_c.txt', 'UPPER.TXT']) {
    const result = normalizeEntryName(name)
    assert.equal(result.ok, true, `应接受 ${name}`)
    if (result.ok) assert.equal(result.normalized, name)
  }
})

test('拒绝空名称、路径分隔符与占位符', () => {
  for (const name of ['', '/', '\\', 'a/b', 'a\\b', '.', '..']) {
    const result = normalizeEntryName(name)
    assert.equal(result.ok, false, `应拒绝 ${JSON.stringify(name)}`)
  }
})

test('拒绝 Windows 保留设备名、ADS 与尾点尾空格', { skip: !isWindows }, () => {
  for (const name of ['CON', 'nul.txt', 'COM1', 'file.txt:stream', 'file.txt.', 'file.txt ']) {
    const result = normalizeEntryName(name)
    assert.equal(result.ok, false, `应拒绝 ${name}`)
  }
})

test('重命名失败措辞带新名称主语', () => {
  const result = normalizeRenameName('a/b')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /^新名称不合法：/)
})
