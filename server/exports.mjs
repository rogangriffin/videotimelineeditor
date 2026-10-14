import path from 'node:path'
import { mkdir, readFile, writeFile, readdir, rename, unlink, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ffmpegPath, ffprobePath, runProcess, probe, detectEncoder, encoderArgs } from './ffmpeg.mjs'
import { prepareTimeline, copyPlan, renderPlan } from './export-plan.mjs'

const idPattern = /^[0-9a-f-]{36}$/i
const active = status => ['queued', 'running', 'cancelling'].includes(status)
const fail = (status, message) => Object.assign(new Error(message), { status })
const encoderNames = { h264_qsv: 'Intel Quick Sync', h264_nvenc: 'NVIDIA NVENC', h264_amf: 'AMD AMF', libx264: 'Software H.264', copy: 'Direct copy' }

export async function createExports({ dataDir, resolveSource, binary = ffmpegPath, probeBinary = ffprobePath, preferredEncoder = process.env.FRAMECUT_ENCODER }) {
  const directory = path.join(dataDir, 'exports')
  await mkdir(directory, { recursive: true })
  const jobs = new Map(), queue = []
  let working = false, encoderPromise
  const file = (id, extension) => path.join(directory, `${id}.${extension}`)
  async function persist(job) {
    const snapshot = JSON.stringify(job.record, null, 2)
    job.write = (job.write ?? Promise.resolve()).catch(() => {}).then(async () => {
      const temp = file(job.record.id, `${randomUUID()}.tmp`)
      try { await writeFile(temp, snapshot, { flag: 'wx' }); await rename(temp, file(job.record.id, 'json')) }
      finally { await unlink(temp).catch(() => {}) }
    })
    await job.write
  }
  for (const entry of await readdir(directory)) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(entry)) continue
    try {
      const record = JSON.parse(await readFile(path.join(directory, entry), 'utf8'))
      if (!idPattern.test(record.id)) continue
      const job = { record }
      if (active(record.status)) {
        record.status = 'failed'; record.phase = 'Interrupted'; record.error = 'The server stopped during this export. Start a new export to retry.'
        await unlink(file(record.id, 'partial.mp4')).catch(() => {})
        await unlink(file(record.id, 'filters.txt')).catch(() => {})
        await persist(job)
      }
      jobs.set(record.id, job)
    } catch { /* One damaged record must not hide other exports. */ }
  }
  const get = id => {
    if (!idPattern.test(id || '')) throw fail(400, 'Invalid export ID.')
    const job = jobs.get(id)
    if (!job) throw fail(404, 'Export not found.')
    return job
  }
  async function execute(job) {
    const { record, controller, timeline } = job
    const signal = controller.signal
    const cancelled = () => { if (signal.aborted) throw new Error('Export cancelled.') }
    const partial = file(record.id, 'partial.mp4'), output = file(record.id, 'mp4'), graphFile = file(record.id, 'filters.txt')
    const command = async args => {
      let pending = ''
      await runProcess(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-stats_period', '0.25', ...args, '-map_metadata', '-1', '-movflags', '+faststart', partial], {
        signal,
        onOutput: text => {
          pending += text
          const lines = pending.split(/\r?\n/); pending = lines.pop() || ''
          for (const line of lines) {
            const [key, value] = line.split('=')
            if (key === 'out_time_us' && Number.isFinite(Number(value))) record.progress = Math.max(record.progress, Math.min(0.99, Number(value) / 1e6 / timeline.duration))
            if (key === 'speed' && value !== 'N/A') record.speed = value.trim()
          }
        },
      })
    }
    try {
      cancelled()
      record.status = 'running'; record.phase = 'Inspecting source media'; record.startedAt = new Date().toISOString()
      await persist(job)
      const media = new Map(), bySource = new Map()
      for (const c of timeline.clips) {
        cancelled()
        if (media.has(c.assetId)) continue
        const asset = timeline.assets.find(a => a.id === c.assetId)
        let source = bySource.get(asset.sourceId)
        if (!source) {
          const resolved = await resolveSource(asset.sourceId)
          source = { path: resolved.path, info: await probe(resolved.path, { signal, binary: probeBinary }) }
          bySource.set(asset.sourceId, source)
        }
        media.set(asset.id, { ...source, asset })
      }
      let copy = copyPlan(timeline, media)
      if (copy) {
        record.encoder = encoderNames.copy; record.phase = 'Copying media without re-encoding'
        await persist(job)
        try { await command(copy) }
        catch (error) { cancelled(); copy = null; record.note = 'Direct copy was unavailable; rendering the sequence instead.' }
      }
      if (!copy) {
        record.phase = 'Checking hardware encoder'; await persist(job)
        const oddSize = timeline.width % 2 !== 0 || timeline.height % 2 !== 0
        let encoder = 'libx264'
        if (!oddSize) {
          encoderPromise ??= detectEncoder(binary, preferredEncoder).catch(error => { encoderPromise = undefined; throw error })
          encoder = await encoderPromise
        }
        cancelled()
        const plan = renderPlan(timeline, media)
        await writeFile(graphFile, plan.graph)
        const render = async () => {
          record.encoder = encoderNames[encoder]; record.phase = `Rendering with ${record.encoder}`; record.progress = 0; record.speed = undefined
          await persist(job)
          await command(['-filter_complex_threads', '2', ...plan.args, '-filter_complex_script', graphFile, ...plan.output, ...encoderArgs(encoder, oddSize)])
        }
        try { await render() }
        catch (error) {
          cancelled()
          if (encoder === 'libx264') throw error
          await writeFile(file(record.id, 'hardware.log'), error.message).catch(() => {})
          record.note = `${encoderNames[encoder]} could not render this sequence. Used software encoding instead.`
          encoder = 'libx264'; await render()
        }
      }
      cancelled()
      record.phase = 'Saving MP4'; await persist(job)
      const info = await stat(partial)
      if (!info.size) throw new Error('The encoder did not produce an MP4 file.')
      await rename(partial, output)
      if (signal.aborted) { await unlink(output); cancelled() }
      record.status = 'completed'; record.phase = 'Saved on server'; record.progress = 1; record.size = info.size
      record.path = output; record.url = `/api/exports/${record.id}/file`
    } catch (error) {
      record.status = signal.aborted ? 'cancelled' : 'failed'
      record.phase = signal.aborted ? 'Cancelled' : 'Export failed'
      if (!signal.aborted) {
        await writeFile(file(record.id, 'error.log'), error.stack || error.message).catch(() => {})
        record.error = error.message.slice(-1800)
      }
    } finally {
      await unlink(partial).catch(() => {})
      await unlink(graphFile).catch(() => {})
      record.finishedAt = new Date().toISOString()
      await persist(job)
      delete job.timeline; delete job.controller
    }
  }
  async function drain() {
    if (working) return
    working = true
    try {
      while (queue.length) {
        const job = queue.shift()
        if (job.record.status === 'queued') await execute(job)
      }
    } finally { working = false }
  }
  return {
    directory,
    list: () => [...jobs.values()].map(j => ({ ...j.record })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: id => ({ ...get(id).record }),
    async start(project, mutedTracks) {
      if ([...jobs.values()].filter(j => active(j.record.status)).length >= 4) throw fail(429, 'Four exports are already queued. Wait or cancel one before starting another.')
      if (!Array.isArray(mutedTracks) || mutedTracks.some(t => !['V1', 'V2', 'A1', 'A2'].includes(t))) throw fail(400, 'Invalid track visibility.')
      let timeline
      try { timeline = prepareTimeline(project, mutedTracks) } catch (error) { throw fail(400, error.message) }
      // Resolve only sources used by the exported range and visible/audible tracks.
      for (const id of new Set(timeline.clips.map(c => c.assetId))) await resolveSource(timeline.assets.find(a => a.id === id).sourceId)
      const id = randomUUID()
      const filename = `${project.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 100) || 'Framecut'}.mp4`
      const job = { record: { id, name: project.name, filename, status: 'queued', phase: 'Queued', progress: 0, duration: timeline.duration, createdAt: new Date().toISOString() }, controller: new AbortController(), timeline }
      await persist(job); jobs.set(id, job); queue.push(job)
      setImmediate(() => { void drain().catch(error => console.error('Export queue failed:', error)) })
      return { ...job.record }
    },
    async cancel(id) {
      const job = get(id)
      if (active(job.record.status)) {
        job.controller?.abort()
        job.record.status = job.record.status === 'queued' ? 'cancelled' : 'cancelling'
        job.record.phase = job.record.status === 'cancelled' ? 'Cancelled' : 'Cancelling'
        if (job.record.status === 'cancelled') { job.record.finishedAt = new Date().toISOString(); delete job.timeline }
        await persist(job)
      }
      return { ...job.record }
    },
    async download(id) {
      const record = get(id).record
      if (record.status !== 'completed') throw fail(409, 'This export is not complete.')
      return { filename: record.filename, path: file(id, 'mp4'), size: (await stat(file(id, 'mp4'))).size }
    },
  }
}
