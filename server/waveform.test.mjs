import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const compile = name => ts.transpileModule(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const coreUrl = url(compile('waveform'))
const { PeakBuilder, PEAKS_PER_SECOND, peakRange, waveformLevel, waveformKey, waveformBytes } = await import(coreUrl)
const { WaveformCache } = await import(url(compile('waveformCache').replace("'./waveform'", JSON.stringify(coreUrl))))
const near = (value, expected) => assert.ok(Math.abs(value - expected) < 2 / 32767, `${value} != ${expected}`)

test('waveforms preserve silence, amplitude differences, single-sample transients and opposite stereo phases', () => {
  const rate = 48000
  const left = new Float32Array(rate * 3)
  for (let i = rate; i < rate * 2; i++) left[i] = Math.sin(i / rate * 440 * Math.PI * 2) * 0.15
  left[rate * 2 + 123] = 0.95
  const right = Float32Array.from(left, value => -value)
  const builder = new PeakBuilder()
  builder.add(left, rate, 0); builder.add(right, rate, 0)
  const waveform = builder.finish()
  assert.deepEqual(peakRange(waveform.levels[0], waveform.rate, 0, 0.9), [0, 0])
  near(peakRange(waveform.levels[0], waveform.rate, 1, 2)[1], 0.15)
  const bucket = Math.floor((2 + 123 / rate) * waveform.rate)
  const [min, max] = peakRange(waveform.levels[0], waveform.rate, bucket / waveform.rate, (bucket + 1) / waveform.rate)
  near(min, -0.95); near(max, 0.95)
  for (let level = 0; level < waveform.levels.length; level++) {
    near(peakRange(waveform.levels[level], waveform.rate / 2 ** level, 0, 3)[1], 0.95)
  }
  assert.ok(waveformBytes(waveform) < left.byteLength / 20, 'Envelope storage is much smaller than PCM')
})

test('chunk boundaries, sample rates, negative timestamps, delayed streams and gaps retain source-time alignment', () => {
  for (const rate of [44100, 48000]) {
    const pcm = Float32Array.from({ length: rate * 2 + 17 }, (_, i) => Math.sin(i * 0.13) * (i % 5) / 5)
    const complete = new PeakBuilder(); complete.add(pcm, rate, 0)
    const chunked = new PeakBuilder()
    for (let i = 0; i < pcm.length; i += 1024) chunked.add(pcm.subarray(i, i + 1024), rate, i / rate)
    assert.deepEqual(chunked.finish(), complete.finish())
  }
  const delayed = new PeakBuilder()
  delayed.add(new Float32Array([1, -1, 0.5, -0.5]), PEAKS_PER_SECOND, -2 / PEAKS_PER_SECOND)
  delayed.add(new Float32Array([0.25, -0.25]), PEAKS_PER_SECOND, 1)
  const waveform = delayed.finish()
  near(peakRange(waveform.levels[0], waveform.rate, 0, 2 / waveform.rate)[1], 0.5)
  assert.deepEqual(peakRange(waveform.levels[0], waveform.rate, 0.1, 0.9), [0, 0])
  near(peakRange(waveform.levels[0], waveform.rate, 1, 1.01)[1], 0.25)
  assert.deepEqual(peakRange(waveform.levels[0], waveform.rate, 2, 3), [0, 0])
})

test('zoom levels keep rendering work bounded; trimmed and split ranges match source audio without normalization', () => {
  const builder = new PeakBuilder()
  builder.add(new Float32Array(PEAKS_PER_SECOND).fill(0.1), PEAKS_PER_SECOND, 0)
  builder.add(new Float32Array(PEAKS_PER_SECOND).fill(0.8), PEAKS_PER_SECOND, 1)
  const waveform = builder.finish()
  for (const pixelsPerSecond of [18, 80, 220, 440]) {
    const level = waveformLevel(waveform, pixelsPerSecond)
    assert.ok(level.rate / pixelsPerSecond < 2)
    near(peakRange(level.peaks, level.rate, 0.2, 0.5)[1], 0.1)
    near(peakRange(level.peaks, level.rate, 1.2, 1.5)[1], 0.8)
  }
  const odd = new PeakBuilder(); odd.add(new Float32Array([0.2, -0.3, 0.9]), PEAKS_PER_SECOND, 0)
  near(peakRange(odd.finish().levels.at(-1), PEAKS_PER_SECOND / 4, 0, 1)[1], 0.9)
})

test('source fingerprints invalidate peaks after replacement or modification', () => {
  const source = { sourceId: 'source', name: 'a.wav', size: 10, lastModified: 20 }
  assert.equal(waveformKey(source), waveformKey({ ...source }))
  for (const change of [{ sourceId: 'replacement' }, { size: 11 }, { lastModified: 21 }]) {
    assert.notEqual(waveformKey(source), waveformKey({ ...source, ...change }))
  }
})

class WorkerStub {
  messages = []; terminated = false
  postMessage(message) { this.messages.push(message) }
  terminate() { this.terminated = true }
  complete(waveform) { this.onmessage({ data: { key: this.messages.at(-1).key, waveform } }) }
}
const asset = (sourceId = 'source') => ({ sourceId, name: 'tone.wav', size: 4, lastModified: 123, file: new File(['1234'], 'tone.wav') })
const fixture = { rate: PEAKS_PER_SECOND, levels: [new Int16Array([0, 100])] }
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('clips share one analysis, queued work is serial, and StrictMode replay keeps the same job', async () => {
  const workers = []
  const cache = new WaveformCache(() => { const worker = new WorkerStub(); workers.push(worker); return worker })
  const first = cache.acquire(asset()), shared = cache.acquire(asset())
  first.release()
  const replay = cache.acquire(asset())
  const next = cache.acquire(asset('next'))
  assert.equal(workers.length, 1); assert.equal(workers[0].messages.length, 1)
  assert.equal(first.promise, shared.promise); assert.equal(first.promise, replay.promise)
  workers[0].complete(fixture)
  assert.equal(await first.promise, fixture)
  assert.equal(workers[0].messages.length, 2)
  workers[0].complete(fixture); await next.promise
  shared.release(); replay.release(); next.release()
  const cached = cache.acquire(asset())
  assert.equal(await cached.promise, fixture); assert.equal(workers[0].messages.length, 2)
  cached.release()
})

test('last subscriber cancels decoding and queued jobs; failures allow retry and unused envelopes are evicted', async () => {
  const workers = []
  const cache = new WaveformCache(() => { const worker = new WorkerStub(); workers.push(worker); return worker }, 0)
  const first = cache.acquire(asset()), queued = cache.acquire(asset('queued'))
  const cancelled = assert.rejects(first.promise, { name: 'AbortError' })
  const cancelledQueue = assert.rejects(queued.promise, { name: 'AbortError' })
  queued.release(); first.release()
  await Promise.all([cancelled, cancelledQueue]); await tick()
  assert.equal(workers[0].terminated, true)
  const retry = cache.acquire(asset())
  const failed = assert.rejects(retry.promise, /worker/)
  workers.at(-1).onerror(); await failed; retry.release()
  const success = cache.acquire(asset()); workers.at(-1).complete(fixture)
  await success.promise; success.release(); await tick()
  const evicted = cache.acquire(asset())
  assert.equal(workers.at(-1).messages.length, 2, 'LRU budget evicts released envelopes')
  workers.at(-1).complete(fixture); await evicted.promise; evicted.release()
})
