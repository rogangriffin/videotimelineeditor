import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createStorage } from './storage.mjs'

test('disk media and projects persist across restarts; ranges, validation, and conflicts', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'framecut-test-'))
  const dataDir = path.join(temp, 'data')
  const homeDir = path.join(temp, 'footage')
  await mkdir(homeDir)
  const mediaPath = path.join(homeDir, 'sample video.mp4')
  const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
  await writeFile(mediaPath, bytes)
  await writeFile(path.join(homeDir, 'secret.txt'), 'not media')
  let server, base
  async function start() {
    const api = await createStorage({ dataDir, homeDir })
    server = http.createServer((req, res) => api(req, res))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  t.after(async () => { await stop(); await rm(temp, { recursive: true, force: true }) })
  const call = (url, method = 'GET', body, headers = {}) => fetch(base + url, { method, headers: { 'X-Framecut': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  await start()
  const listing = await (await call('/api/browse')).json()
  assert.equal(listing.path, homeDir)
  assert.deepEqual(listing.entries.map(e => e.name), ['sample video.mp4'])
  const source = await (await call('/api/sources', 'POST', { path: mediaPath })).json()
  assert.equal(source.sourcePath, mediaPath)
  let response = await call(source.url, 'GET', undefined, { Range: 'bytes=4-9' })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), `bytes 4-9/${bytes.length}`)
  assert.equal(await response.text(), '456789')
  response = await call(source.url, 'GET', undefined, { Range: 'bytes=-3' })
  assert.equal(await response.text(), 'xyz')
  response = await call(source.url, 'GET', undefined, { Range: 'bytes=30-' })
  assert.equal(await response.text(), 'uvwxyz')
  response = await call(source.url, 'HEAD')
  assert.equal(Number(response.headers.get('content-length')), bytes.length)
  assert.equal(await response.text(), '')
  for (const range of ['bytes=99-', 'bytes=4-2', 'bytes=-0', 'bytes=1-3,5-8']) assert.equal((await call(source.url, 'GET', undefined, { Range: range })).status, 416)
  assert.equal((await call('/api/sources', 'POST', { path: path.join(homeDir, 'secret.txt') })).status, 400)
  const id = randomUUID()
  const project = { version: 1, name: 'Test sequence', width: 1920, height: 1080, frameRate: 30, exportStart: 0.5, exportEnd: 2,
    assets: [{ id: 'asset', sourceId: source.sourceId, name: source.name, size: source.size, lastModified: source.lastModified, duration: 5, width: 1920, height: 1080, kind: 'video', hasAudio: false, url: 'blob:stale' }],
    clips: [{ id: 'clip', assetId: 'asset', trackId: 'V1', start: 0, in: 1, out: 4 }] }
  response = await call(`/api/projects/${id}`, 'PUT', { revision: 0, project })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).revision, 1)
  const disk = JSON.parse(await readFile(path.join(dataDir, 'projects', `${id}.json`), 'utf8'))
  assert.equal(disk.project.assets[0].url, undefined)
  assert.equal(disk.project.exportStart, 0.5)
  assert.equal(disk.project.exportEnd, 2)
  for (const markers of [{ exportStart: -1 }, { exportEnd: '2' }, { exportStart: null }, { exportStart: 2, exportEnd: 2 }, { exportStart: 3, exportEnd: 2 }]) {
    assert.equal((await call(`/api/projects/${id}`, 'PUT', { revision: 1, project: { ...project, ...markers } })).status, 400)
  }
  assert.equal((await call(`/api/projects/${id}`, 'PUT', { revision: 0, project })).status, 409)
  assert.equal((await call(`/api/projects/${id}`, 'PUT', { revision: 1, project: { ...project, width: -1 } })).status, 400)
  await stop(); await start()
  const restored = await (await call(`/api/projects/${id}`)).json()
  assert.deepEqual(restored.project.clips, project.clips)
  assert.equal(restored.project.exportStart, 0.5)
  assert.equal(restored.project.exportEnd, 2)
  assert.equal(restored.project.assets[0].url, source.url)
  assert.deepEqual(Buffer.from(await (await call(source.url)).arrayBuffer()), bytes)
  const simultaneous = await Promise.all([1, 2].map(() => call(`/api/projects/${id}`, 'PUT', { revision: 1, project })))
  assert.deepEqual(simultaneous.map(r => r.status).sort(), [200, 409])
  assert.equal((await (await call('/api/projects')).json())[0].name, project.name)
  await rename(mediaPath, path.join(homeDir, 'moved.mp4'))
  const missing = await (await call(`/api/projects/${id}`)).json()
  assert.equal(missing.project.assets[0].url, undefined)
  assert.match(missing.project.assets[0].offlineReason, /missing/)
  assert.equal((await call(source.url)).status, 409)
  const upload = await fetch(base + '/api/uploads?name=upload.mp4', { method: 'POST', headers: { 'X-Framecut': '1' }, body: bytes })
  const uploaded = await upload.json()
  assert.equal(upload.status, 201)
  assert.deepEqual(Buffer.from(await (await call(uploaded.url)).arrayBuffer()), bytes)
  await writeFile(uploaded.sourcePath, 'changed')
  assert.equal((await call(uploaded.url)).status, 409)
  assert.equal((await call('/api/projects', 'GET', undefined, { Origin: 'https://other.example' })).status, 403)
  assert.equal((await call('/api/browse', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await fetch(base + '/api/sources', { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await call('/api/projects/not-an-id')).status, 400)
})

test('image imports, MIME types, long still clips, and source relinking persist', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'framecut-images-'))
  const api = await createStorage({ dataDir: path.join(temp, 'data'), homeDir: temp })
  const server = http.createServer((req, res) => api(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = (url, method = 'GET', body) => fetch(base + url, { method, headers: { 'X-Framecut': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (const [ext, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['bmp', 'image/bmp'], ['avif', 'image/avif']]) {
    const filename = `still.${ext}`
    const originalPath = path.join(temp, filename)
    await writeFile(originalPath, 'image fixture')
    assert.ok((await (await call('/api/browse')).json()).entries.some(e => e.name === filename))
    const source = await (await call('/api/sources', 'POST', { path: originalPath })).json()
    assert.equal((await call(source.url)).headers.get('content-type'), mime)
    const upload = await fetch(base + `/api/uploads?name=${filename}`, { method: 'POST', headers: { 'X-Framecut': '1' }, body: 'image fixture' })
    assert.equal(upload.status, 201)
    assert.equal((await call((await upload.json()).url)).headers.get('content-type'), mime)
    const project = { version: 1, name: 'Still sequence', width: 1920, height: 1080, frameRate: 30,
      assets: [{ ...source, id: 'image', duration: 5, width: 600, height: 900, kind: 'image', hasAudio: false }],
      clips: [{ id: 'clip', assetId: 'image', trackId: 'V1', start: 2, in: 8, out: 128 }] }
    const id = randomUUID()
    assert.equal((await call(`/api/projects/${id}`, 'PUT', { revision: 0, project })).status, 200)
    assert.deepEqual((await (await call(`/api/projects/${id}`)).json()).project.clips, project.clips)
    for (const clip of [{ ...project.clips[0], out: -1 }, { ...project.clips[0], trackId: 'A1' }]) {
      assert.equal((await call(`/api/projects/${id}`, 'PUT', { revision: 1, project: { ...project, clips: [clip] } })).status, 400)
    }
    await mkdir(path.join(temp, ext))
    const relocated = path.join(temp, ext, filename)
    await rename(originalPath, relocated)
    assert.equal((await (await call(`/api/projects/${id}`)).json()).project.assets[0].url, undefined)
    const replacement = await (await call('/api/sources', 'POST', { path: relocated })).json()
    project.assets[0] = { ...project.assets[0], ...replacement }
    assert.equal((await call(`/api/projects/${id}`, 'PUT', { revision: 1, project })).status, 200)
    assert.equal((await (await call(`/api/projects/${id}`)).json()).project.assets[0].url, replacement.url)
  }
})
