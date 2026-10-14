import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync(new URL('../src/playback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { PlaybackTransport } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
class Media {
  time = 0; seeks = 0; plays = 0; pauses = 0; playbackRate = 1
  readyState = 4; seeking = false; paused = true; ended = false
  get currentTime() { return this.time }
  set currentTime(time) { this.time = time; this.seeks++ }
  play() { this.paused = false; this.plays++; return Promise.resolve() }
  pause() { this.paused = true; this.pauses++ }
}
const clip = (id, element, audio = false, start = 0, from = 0) => ({ id, element, audio, start, in: from })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('sustained playback follows audio without repeated pauses or seeks when video readiness fluctuates', async () => {
  const audio = new Media(), video = new Media()
  const entries = [clip('v', video), clip('a', audio, true)]
  const transport = new PlaybackTransport(assert.fail)
  transport.step(0, 0, 10, entries); await flush()
  let time = 0
  for (let i = 1; i <= 250; i++) {
    audio.time = i / 50
    video.time = audio.time - 0.12
    video.readyState = i % 2 ? 2 : 3
    video.seeking = i % 7 === 0
    const result = transport.step(i * 20, time, 10, entries)
    time = result.time
    assert.equal(result.waiting, false)
  }
  assert.equal(time, 5)
  assert.equal(audio.plays, 1); assert.equal(video.plays, 1)
  assert.equal(audio.pauses, 0); assert.equal(video.pauses, 0)
  assert.equal(audio.seeks, 0); assert.equal(video.seeks, 0)
  assert.ok(video.playbackRate >= 1 && video.playbackRate <= 1.05)
  transport.dispose()
  assert.equal(video.playbackRate, 1)
})

test('startup waits without repeated seeks, delayed indicator reports real stalls, explicit seek repositions once', async () => {
  const audio = new Media(), video = new Media()
  video.readyState = 1
  const entries = [clip('v', video, false, 0, 3), clip('a', audio, true, 0, 3)]
  const transport = new PlaybackTransport(assert.fail)
  for (let i = 0; i <= 20; i++) {
    const result = transport.step(i * 20, 0, 10, entries)
    assert.equal(result.time, 0)
    assert.equal(result.waiting, i * 20 > 350)
  }
  assert.equal(audio.seeks, 1); assert.equal(video.seeks, 1)
  assert.equal(audio.pauses, 0); assert.equal(video.pauses, 0)
  video.readyState = 2
  transport.step(420, 0, 10, entries); await flush()
  audio.time = 3.5; video.time = 3.5
  assert.equal(transport.step(440, 0, 10, entries).time, 0.5)
  transport.seek()
  transport.step(460, 2, 10, entries); await flush()
  assert.equal(audio.time, 5); assert.equal(video.time, 5)
  assert.equal(audio.seeks, 2); assert.equal(video.seeks, 2)
  assert.equal(audio.pauses, 1); assert.equal(video.pauses, 1)
  assert.equal(transport.step(900, 2, 10, entries).waiting, true)
  audio.time = 5.1
  assert.equal(transport.step(920, 2, 10, entries).waiting, false)
  transport.dispose()
})

test('prepositioned cuts need no decoder reset, and natural ends and gaps advance to boundaries', async () => {
  const first = new Media(), second = new Media()
  second.time = 3
  const transport = new PlaybackTransport(assert.fail)
  transport.step(0, 0, 1, [clip('first', first, true)]); await flush()
  first.time = 1.01
  assert.equal(transport.step(1000, 0, 1, [clip('first', first, true)]).time, 1)
  transport.step(1016, 1, 2, [clip('second', second, true, 1, 3)]); await flush()
  assert.equal(first.pauses, 1); assert.equal(second.seeks, 0)
  second.time = 3.5
  assert.equal(transport.step(1500, 1, 2, [clip('second', second, true, 1, 3)]).time, 1.5)
  second.ended = true; second.paused = true
  assert.equal(transport.step(2000, 1.5, 2, [clip('second', second, true, 1, 3)]).time, 2)
  assert.equal(second.plays, 1)
  assert.equal(transport.step(2500, 2, 5, []).time, 2.5)
  transport.dispose()
})
