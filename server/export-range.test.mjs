import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Compile the pure timeline model so these checks also run on Node 22.
const source = readFileSync(new URL('../src/model.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { emptyProject, prepareExport, parseProject, serializeProject, resizeImageClip, fitRect } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const clip = (id, trackId, start, from, to) => ({ id, assetId: 'media', trackId, start, in: from, out: to })

test('image clips extend from either edge, survive save/load and export-range trimming', () => {
  const image = { id: 'media', name: 'photo.png', size: 100, duration: 5, width: 600, height: 900, kind: 'image', hasAudio: false }
  let still = resizeImageClip(clip('still', 'V1', 10, 0, 5), 'start', 2)
  assert.deepEqual(still, clip('still', 'V1', 2, 0, 13))
  still = resizeImageClip(still, 'end', 30)
  assert.deepEqual(still, clip('still', 'V1', 2, 0, 28))
  const project = { ...emptyProject(), assets: [image], clips: [still], exportStart: 12, exportEnd: 20 }
  assert.deepEqual(parseProject(serializeProject(project)), project)
  const trimmed = prepareExport(project).project
  assert.deepEqual(trimmed.clips, [clip('still', 'V1', 0, 10, 18)])
  assert.deepEqual(parseProject(serializeProject(trimmed)).clips, trimmed.clips)
  assert.deepEqual(resizeImageClip(trimmed.clips[0], 'end', 12), clip('still', 'V1', 0, 0, 12))
  assert.throws(() => parseProject(JSON.stringify({ ...project, assets: [{ ...image, kind: 'video' }] })), /invalid timeline clip/)
  assert.throws(() => parseProject(JSON.stringify({ ...project, clips: [{ ...still, trackId: 'A1' }] })), /invalid timeline clip/)
})

test('images fill the largest centered rectangle without stretching or cropping', () => {
  assert.deepEqual(fitRect(600, 900, 1920, 1080), { x: 600, y: 0, w: 720, h: 1080 })
  assert.deepEqual(fitRect(2400, 600, 1920, 1080), { x: 0, y: 300, w: 1920, h: 480 })
  assert.deepEqual(fitRect(320, 180, 1920, 1080), { x: 0, y: 0, w: 1920, h: 1080 })
})

test('export cuts linked audio/video and overlays, preserves offsets, and leaves the edit untouched', () => {
  const project = { ...emptyProject(), exportStart: 4, exportEnd: 8, clips: [
    clip('video', 'V1', 2, 10, 20), clip('audio', 'A1', 2, 10, 20),
    clip('overlay', 'V2', 6, 1, 6), clip('before', 'V1', 0, 0, 4), clip('after', 'A2', 8, 0, 3),
  ] }
  const original = structuredClone(project)
  const result = prepareExport(project)
  assert.equal(result.duration, 4)
  assert.equal(result.marked, true)
  assert.deepEqual(result.project.clips, [clip('video', 'V1', 0, 12, 16), clip('audio', 'A1', 0, 12, 16), clip('overlay', 'V2', 2, 1, 3)])
  assert.deepEqual(project, original)
})

test('export preserves leading, internal, trailing, and entirely empty gaps', () => {
  const project = { ...emptyProject(), exportStart: 1, exportEnd: 9, clips: [clip('a', 'V1', 2, 0, 1), clip('b', 'A1', 5, 0, 1), clip('c', 'V1', 10, 0, 2)] }
  const result = prepareExport(project)
  assert.equal(result.duration, 8)
  assert.deepEqual(result.project.clips, [clip('a', 'V1', 1, 0, 1), clip('b', 'A1', 4, 0, 1)])
  const gap = prepareExport({ ...project, exportStart: 7, exportEnd: 9 })
  assert.equal(gap.duration, 2)
  assert.deepEqual(gap.project.clips, [])
})

test('partial and cleared markers export the full sequence; shortened timelines clamp or reject empty ranges', () => {
  const project = { ...emptyProject(), clips: [clip('a', 'V1', 0, 0, 10)] }
  for (const markers of [{}, { exportStart: 2 }, { exportEnd: 6 }, { exportStart: undefined, exportEnd: undefined }]) {
    const input = { ...project, ...markers }
    assert.deepEqual(prepareExport(input), { project: input, duration: 10, marked: false })
  }
  assert.equal(prepareExport({ ...project, exportStart: 2, exportEnd: 20 }).duration, 8)
  assert.throws(() => prepareExport({ ...project, exportStart: 12, exportEnd: 20 }), /Export end must be after/)
})

test('marker serialization remains compatible with old projects and validates malformed markers', () => {
  const project = { ...emptyProject(), exportStart: 0, exportEnd: 2 }
  assert.deepEqual(parseProject(serializeProject(project)), project)
  assert.deepEqual(parseProject(serializeProject(emptyProject())), emptyProject())
  for (const markers of [{ exportStart: -1 }, { exportEnd: null }, { exportEnd: '2' }, { exportStart: 2, exportEnd: 1 }]) {
    assert.throws(() => parseProject(JSON.stringify({ ...project, ...markers })), /invalid export markers/)
  }
})
