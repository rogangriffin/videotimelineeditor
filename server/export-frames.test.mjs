import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { ffmpegPath, runProcess, probe } from './ffmpeg.mjs'
import { prepareTimeline, renderPlan } from './export-plan.mjs'

async function frameColors(filename) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-v', 'error', '-i', filename, '-an', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true })
    const chunks = []; let error = ''
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => code ? reject(new Error(error)) : resolve(Buffer.concat(chunks)))
  })
}

test('mixed-rate exports cover every frame at cuts while preserving layers and real gaps', { timeout: 60000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'framecut-frames-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const media = new Map()
  for (const color of ['red', 'blue']) {
    const filename = path.join(temp, `${color}.mp4`)
    await runProcess(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=48x32:r=24:d=3`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filename])
    media.set(color, { path: filename, asset: { kind: 'video', name: `${color}.mp4` }, info: await probe(filename) })
  }
  const first = 43 / 24, second = first + 34 / 24, third = second + 46 / 24
  const project = {
    width: 48, height: 32, frameRate: 30,
    clips: [
      { assetId: 'red', trackId: 'V1', start: 0, in: 0, out: first },
      { assetId: 'blue', trackId: 'V1', start: first, in: 0, out: 34 / 24 },
      { assetId: 'red', trackId: 'V1', start: second, in: 0.069, out: 0.069 + 46 / 24 },
      { assetId: 'blue', trackId: 'V1', start: third + 0.125, in: 0.123, out: 0.123 + 0.5 },
      { assetId: 'red', trackId: 'V1', start: third + 0.625, in: 0.211, out: 0.211 + 0.019 },
      { assetId: 'blue', trackId: 'V1', start: third + 0.644, in: 0, out: 6 - third - 0.644 },
      { assetId: 'blue', trackId: 'V2', start: 0.35, in: 0, out: 0.3 },
    ],
  }
  for (const [name, input, muted] of [
    ['layers', project, []],
    ['cuts', project, ['V2']],
    ['marked', { ...project, exportStart: 0.11, exportEnd: 5.91 }, []],
  ]) {
    const timeline = prepareTimeline(input, muted)
    const plan = renderPlan(timeline, media)
    const graph = path.join(temp, `${name}.txt`), output = path.join(temp, `${name}.mp4`)
    await writeFile(graph, plan.graph)
    await runProcess(ffmpegPath, ['-v', 'error', '-filter_complex_threads', '2', ...plan.args, '-filter_complex_script', graph, ...plan.output, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', output])
    const colors = await frameColors(output)
    assert.equal(colors.length / 3, Math.ceil(timeline.duration * timeline.frameRate), `${name}: output frame count`)
    for (let frame = 0; frame < colors.length / 3; frame++) {
      const time = frame / timeline.frameRate
      const clip = timeline.clips.filter(c => time >= c.start - 0.000001 && time < c.start + c.out - c.in - 0.000001)
        .sort((a, b) => a.trackId.localeCompare(b.trackId)).at(-1)
      const rgb = [...colors.subarray(frame * 3, frame * 3 + 3)]
      const expected = clip?.assetId
      assert.ok(expected === 'red' ? rgb[0] > 220 && rgb[1] < 20 && rgb[2] < 20
        : expected === 'blue' ? rgb[2] > 220 && rgb[0] < 20 && rgb[1] < 20
          : rgb.every(c => c < 10), `${name}: frame ${frame} (${time}s) expected ${expected ?? 'gap'}, got ${rgb}`)
    }
  }
})
