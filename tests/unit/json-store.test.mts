import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JsonStore } from '../../src/main/storage/json-store'

interface Data {
  value: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function createStore(filePath: string): JsonStore<Data> {
  return new JsonStore<Data>({
    filePath,
    version: 1,
    sanitize: (raw) => {
      if (!isRecord(raw)) return null
      const value = raw['value']
      return typeof value === 'number' ? { value } : null
    },
    createDefault: () => ({ value: 0 })
  })
}

test('文件不存在时返回默认值', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-json-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const store = createStore(join(dir, 'config.json'))
  assert.deepEqual(store.read(), { value: 0 })
})

test('写入后可被新实例读回', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-json-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.json')

  const store = createStore(file)
  store.write({ value: 7 })

  const reloaded = createStore(file)
  assert.deepEqual(reloaded.read(), { value: 7 })
  assert.match(readFileSync(file, 'utf8'), /"version": 1/)
})

test('损坏 JSON 被隔离并回退默认值', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-json-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.json')
  writeFileSync(file, '{ not json', 'utf8')

  const store = createStore(file)
  assert.deepEqual(store.read(), { value: 0 })
  assert.equal(
    readdirSync(dir).some((name) => name.startsWith('config.json.corrupt-')),
    true
  )
})

test('结构不符合预期时同样隔离', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-json-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify({ version: 1, data: { value: 'not-a-number' } }), 'utf8')

  const store = createStore(file)
  assert.deepEqual(store.read(), { value: 0 })
  assert.equal(
    readdirSync(dir).some((name) => name.startsWith('config.json.corrupt-')),
    true
  )
})

test('invalidate 丢弃缓存并重新读取磁盘', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-json-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.json')

  const store = createStore(file)
  store.write({ value: 1 })
  writeFileSync(file, JSON.stringify({ version: 1, data: { value: 2 } }), 'utf8')

  assert.deepEqual(store.read(), { value: 1 })
  store.invalidate()
  assert.deepEqual(store.read(), { value: 2 })
})
