import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/clientMedia.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { ClientMedia } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const descriptor = { sourceId: 'source', name: 'clip.mp4', size: 4, lastModified: 123, sourcePath: '/clip.mp4', url: '/api/media/source' }

test('media is not exposed until every byte has loaded; shared sources download once', async t => {
  let stream
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(new Uint8Array([1, 2])) } }), { headers: { 'Content-Type': 'video/mp4' } }))
  const session = new ClientMedia()
  t.after(() => session.dispose())
  let settled = false
  const pending = session.load(descriptor).then(result => { settled = true; return result })
  const duplicate = session.load(descriptor)
  await new Promise(setImmediate)
  assert.equal(settled, false)
  stream.enqueue(new Uint8Array([3, 4])); stream.close()
  const local = await pending
  assert.equal(local, await duplicate)
  assert.equal(fetch.mock.callCount(), 1)
  assert.ok(local.file instanceof File)
  assert.equal(local.file.size, 4)
  assert.equal(local.file.type, 'video/mp4')
  assert.match(local.url, /^blob:/)
  assert.deepEqual([...new Uint8Array(await local.file.arrayBuffer())], [1, 2, 3, 4])
  const assets = [{ ...descriptor, id: 'one' }, { ...descriptor, id: 'two' }]
  const loaded = await session.loadProject({ assets, clips: [] })
  assert.ok(loaded.assets.every(a => a.file === local.file && a.url === local.url))
  assert.equal(assets[0].url, descriptor.url)
  assert.equal(fetch.mock.callCount(), 1)
})

test('truncated or failed transfers remain unavailable and can be retried', async t => {
  let response = () => new Response(new Uint8Array([1, 2]))
  t.mock.method(globalThis, 'fetch', async () => response())
  const session = new ClientMedia()
  t.after(() => session.dispose())
  const failed = await session.loadProject({ assets: [{ ...descriptor, id: 'one' }], clips: [] })
  assert.equal(failed.assets[0].url, undefined)
  assert.equal(failed.assets[0].file, undefined)
  assert.match(failed.assets[0].offlineReason, /not completely loaded/)
  response = () => new Response('Unavailable', { status: 503 })
  await assert.rejects(session.load(descriptor), /503/)
  response = () => new Response(new Uint8Array([1, 2, 3, 4]))
  assert.equal((await session.load(descriptor)).file.size, 4)
})

test('local uploads are reused without a download; disposal releases URLs and cancels loads', async t => {
  const revoked = []
  const revoke = URL.revokeObjectURL.bind(URL)
  t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); revoke(url) })
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
  } })))
  const session = new ClientMedia()
  const original = new File(['1234'], descriptor.name)
  const local = await session.load(descriptor, undefined, original)
  assert.equal(local.file, original)
  assert.equal(fetch.mock.callCount(), 0)
  const pending = session.load({ ...descriptor, sourceId: 'pending' })
  await new Promise(setImmediate)
  session.dispose()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(revoked, [local.url])
  await assert.rejects(session.load(descriptor), { name: 'AbortError' })
  session.dispose()
  assert.equal(revoked.length, 1)
})
