import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { createStorage } from './storage.mjs'
import { ffmpegPath, runProcess, probe } from './ffmpeg.mjs'
import { prepareTimeline, copyPlan } from './export-plan.mjs'
import { spawn } from 'node:child_process'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function decode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-v', 'error', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []; let error = ''
    child.stdout.on('data', c => chunks.push(c)); child.stderr.on('data', c => { error += c })
    child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolve(Buffer.concat(chunks)))
  })
}

test('server MP4 exports preserve edits, alpha, audio, gaps, copy, persistence and cancellation', { timeout: 180000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'framecut-native-'))
  const dataDir = path.join(temp, 'data'), sourcePath = path.join(temp, 'source.mp4'), imagePath = path.join(temp, 'overlay.png')
  let server, base
  async function start() {
    const api = await createStorage({ dataDir, exportOptions: { preferredEncoder: process.env.FRAMECUT_TEST_ENCODER || 'libx264' } })
    server = http.createServer((req, res) => api(req, res))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  t.after(async () => { if (server?.listening) await stop(); await rm(temp, { recursive: true, force: true }) })
  await runProcess(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', "color=red:s=160x90:r=30:d=2,drawbox=c=blue:t=fill:enable='gte(t,1)'", '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath])
  const raw = Buffer.alloc(80 * 80 * 4)
  for (let i = 0; i < raw.length; i += 4) { raw[i + 1] = 255; raw[i + 3] = 128 }
  const rawPath = path.join(temp, 'image.rgba'); await writeFile(rawPath, raw)
  await runProcess(ffmpegPath, ['-v', 'error', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '80x80', '-i', rawPath, '-frames:v', '1', imagePath])
  await start()
  const call = (url, method = 'GET', body, headers = {}) => fetch(base + url, { method, headers: { 'X-Framecut': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const video = await (await call('/api/sources', 'POST', { path: sourcePath })).json()
  const image = await (await call('/api/sources', 'POST', { path: imagePath })).json()
  const project = { version: 1, name: 'Render tests', width: 160, height: 90, frameRate: 30,
    assets: [{ id: 'video', ...video, duration: 2, width: 160, height: 90, frameRate: 30, kind: 'video', hasAudio: true }, { id: 'image', ...image, duration: 5, width: 80, height: 80, kind: 'image', hasAudio: false }],
    clips: [
      { id: 'v', assetId: 'video', trackId: 'V1', start: 0.25, in: 0.25, out: 1.75 },
      { id: 'a', assetId: 'video', trackId: 'A1', start: 0.25, in: 0.25, out: 1.75 },
      { id: 'i', assetId: 'image', trackId: 'V2', start: 0.5, in: 0, out: 0.5 },
      { id: 'end', assetId: 'video', trackId: 'V1', start: 2, in: 1, out: 1.5 },
    ] }
  async function begin(project, mutedTracks = []) {
    const response = await call('/api/exports', 'POST', { project, mutedTracks })
    const result = await response.json()
    assert.equal(response.status, 202, JSON.stringify(result))
    return result
  }
  async function finish(job) {
    const until = Date.now() + 60000
    while (Date.now() < until) {
      const current = await (await call(`/api/exports/${job.id}`)).json()
      if (!['queued', 'running', 'cancelling'].includes(current.status)) return current
      await sleep(100)
    }
    throw new Error('Export timed out')
  }
  async function render(project, muted = []) {
    const job = await finish(await begin(project, muted))
    assert.equal(job.status, 'completed', job.error)
    assert.equal(job.progress, 1)
    return job
  }
  async function pixel(job, time, x = 80, y = 45) {
    const data = await decode(['-ss', String(time), '-i', job.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
    return [...data.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)]
  }
  const job = await render(project)
  t.diagnostic(`Rendered timeline using ${job.encoder} in ${(Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000}s`)
  const info = await probe(job.path)
  assert.equal(info.streams[0].codec_name, 'h264'); assert.equal(info.streams[1].codec_name, 'aac')
  assert.ok(Math.abs(Number(info.format.duration) - 2.5) < 0.06)
  assert.ok((await pixel(job, 0.1)).every(c => c < 10), 'leading gap is black')
  let p = await pixel(job, 0.35); assert.ok(p[0] > 220 && p[1] < 20 && p[2] < 20, `trim starts red: ${p}`)
  p = await pixel(job, 0.7); assert.ok(p[0] > 100 && p[0] < 155 && p[1] > 100 && p[1] < 155 && p[2] < 20, `alpha overlay: ${p}`)
  p = await pixel(job, 0.7, 10, 45); assert.ok(p[0] > 220 && p[1] < 20, `aspect fit preserves underlying video: ${p}`)
  p = await pixel(job, 1.25); assert.ok(p[2] > 220 && p[0] < 20, `source time preserved: ${p}`)
  assert.ok((await pixel(job, 1.85)).every(c => c < 10), 'gap after video is black')
  p = await pixel(job, 2.2); assert.ok(p[2] > 220, 'next clip is visible')
  const pcm = await decode(['-i', job.path, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'])
  const rms = (start, end) => {
    let sum = 0, count = 0
    for (let i = Math.round(start * 48000); i < Math.min(pcm.length / 4, end * 48000); i++) { sum += pcm.readFloatLE(i * 4) ** 2; count++ }
    return Math.sqrt(sum / count)
  }
  assert.ok(rms(0.05, 0.15) < 0.001, 'leading audio silence')
  assert.ok(rms(0.4, 0.6) > 0.02, 'trimmed audio present')
  assert.ok(rms(1.85, 2.35) < 0.001, 'trailing audio silence')
  const mixed = await render({ ...project, clips: [...project.clips, { id: 'a2', assetId: 'video', trackId: 'A2', start: 0.25, in: 0.25, out: 1.75 }] }, ['V2'])
  const doubled = await decode(['-ss', '0.4', '-i', mixed.path, '-t', '0.2', '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'])
  let energy = 0
  for (let i = 0; i < doubled.length; i += 4) energy += doubled.readFloatLE(i) ** 2
  assert.ok(Math.sqrt(energy / (doubled.length / 4)) > rms(0.4, 0.6) * 1.8, 'audio layers sum without automatic normalization')
  p = await pixel(mixed, 0.7); assert.ok(p[0] > 220 && p[1] < 20, 'hidden image excluded')
  const marked = await render({ ...project, exportStart: 1.5, exportEnd: 2.25 }, ['V2', 'A1'])
  const markedInfo = await probe(marked.path)
  assert.equal(markedInfo.streams.length, 1)
  assert.ok(Math.abs(Number(markedInfo.format.duration) - 0.75) < 1 / 30)
  p = await pixel(marked, 0.1); assert.ok(p[2] > 220)
  assert.ok((await pixel(marked, 0.4)).every(c => c < 10))
  const whole = { ...project, clips: [{ id: 'v', assetId: 'video', trackId: 'V1', start: 0, in: 0, out: 2 }, { id: 'a', assetId: 'video', trackId: 'A1', start: 0, in: 0, out: 2 }] }
  const copied = await render(whole)
  assert.equal(copied.encoder, 'Direct copy')
  const sourceHash = await decode(['-i', sourcePath, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-'])
  const copyHash = await decode(['-i', copied.path, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-'])
  assert.equal(sourceHash.toString(), copyHash.toString(), 'compressed video packets are unchanged')
  const blank = await render(whole, ['V1', 'A1'])
  assert.equal((await probe(blank.path)).streams.length, 1)
  assert.ok((await pixel(blank, 0.2)).every(c => c < 10))
  assert.equal((await call('/api/exports', 'POST', { project: whole }, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await call('/api/exports/not-an-id/file')).status, 400)
  const long = await begin({ ...project, width: 1920, height: 1080, clips: [{ id: 'long', assetId: 'image', trackId: 'V1', start: 0, in: 0, out: 600 }] })
  const queued = await begin(whole)
  await call(`/api/exports/${queued.id}`, 'DELETE')
  assert.equal((await finish(queued)).status, 'cancelled')
  await sleep(350)
  await call(`/api/exports/${long.id}`, 'DELETE')
  assert.equal((await finish(long)).status, 'cancelled')
  assert.ok(!(await readdir(path.join(dataDir, 'exports'))).some(name => name.endsWith('partial.mp4') || name.endsWith('filters.txt')))
  await stop(); await start()
  const listing = await (await call('/api/exports')).json()
  assert.ok(listing.jobs.some(j => j.id === job.id && j.status === 'completed'))
  const downloaded = await call(job.url)
  assert.equal(downloaded.headers.get('content-type'), 'video/mp4')
  assert.match(downloaded.headers.get('content-disposition'), /attachment/)
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), await readFile(job.path))
  await writeFile(sourcePath, 'changed source')
  assert.equal((await call('/api/exports', 'POST', { project: whole })).status, 409)
})

test('export ranges retain empty gaps and reject unsafe stream copying', () => {
  const project = { clips: [{ assetId: 'v', trackId: 'V1', start: 3, in: 0, out: 5 }], exportStart: 1, exportEnd: 4 }
  const result = prepareTimeline(project)
  assert.equal(result.duration, 3); assert.deepEqual(result.clips, [{ assetId: 'v', trackId: 'V1', start: 2, in: 0, out: 1 }])
  assert.equal(copyPlan(result, new Map([['v', { asset: { kind: 'video' }, info: { streams: [] } }]])), null)
})
