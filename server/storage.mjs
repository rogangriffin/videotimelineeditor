import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, rename, unlink, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { createExports } from './exports.mjs'

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const mediaTypes = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' }
const fail = (status, message) => Object.assign(new Error(message), { status })
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
const validId = id => { if (!idPattern.test(id ?? '')) throw fail(400, 'Invalid ID.'); return id }

async function body(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 16 * 1024 * 1024) throw fail(413, 'Project is too large.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) } catch { throw fail(400, 'Invalid JSON request.') }
}

async function atomicWrite(filename, value) {
  const temp = `${filename}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' })
    await rename(temp, filename)
  } finally { await unlink(temp).catch(() => {}) }
}

function validateProject(p) {
  if (!p || p.version !== 1 || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 200 || !Array.isArray(p.assets) || !Array.isArray(p.clips)) throw fail(400, 'Invalid project.')
  if (!Number.isInteger(p.width) || p.width < 16 || p.width > 3840 || !Number.isInteger(p.height) || p.height < 16 || p.height > 2160 || ![24, 25, 30, 60].includes(p.frameRate)) throw fail(400, 'Invalid sequence settings.')
  if ([p.exportStart, p.exportEnd].some(marker => marker !== undefined && (!Number.isFinite(marker) || marker < 0)) ||
      (p.exportStart !== undefined && p.exportEnd !== undefined && p.exportEnd <= p.exportStart)) throw fail(400, 'Invalid export markers.')
  const assets = new Map()
  for (const a of p.assets) {
    if (!a || typeof a.id !== 'string' || assets.has(a.id) || typeof a.name !== 'string' || !Number.isFinite(a.size) || a.size < 0 || !Number.isFinite(a.duration) || a.duration <= 0 || !['video', 'audio', 'image'].includes(a.kind) || !Number.isFinite(a.width) || !Number.isFinite(a.height) || typeof a.hasAudio !== 'boolean') throw fail(400, 'Invalid media entry.')
    validId(a.sourceId)
    assets.set(a.id, a)
  }
  const clips = new Set()
  for (const c of p.clips) {
    const a = assets.get(c?.assetId)
    if (!a || typeof c.id !== 'string' || clips.has(c.id) || !['V1', 'V2', 'A1', 'A2'].includes(c.trackId) || !Number.isFinite(c.start) || c.start < 0 || !Number.isFinite(c.in) || c.in < 0 || !Number.isFinite(c.out) || c.out <= c.in || (a.kind !== 'image' && c.out > a.duration + 0.01) || (a.kind === 'image' && !c.trackId.startsWith('V'))) throw fail(400, 'Invalid timeline clip.')
    clips.add(c.id)
  }
  return { version: 1, name: p.name.trim(), width: p.width, height: p.height, frameRate: p.frameRate,
    assets: p.assets.map(({ file, url, sourcePath, offlineReason, ...a }) => a), clips: p.clips,
    ...(p.exportStart !== undefined ? { exportStart: p.exportStart } : {}),
    ...(p.exportEnd !== undefined ? { exportEnd: p.exportEnd } : {}) }
}

export async function createStorage({ dataDir = process.env.FRAMECUT_DATA_DIR || path.resolve('data'), homeDir = os.homedir(), exportOptions = {} } = {}) {
  const root = path.resolve(dataDir)
  const projects = path.join(root, 'projects')
  const sources = path.join(root, 'sources')
  const media = path.join(root, 'media')
  await Promise.all([projects, sources, media].map(dir => mkdir(dir, { recursive: true })))
  const read = async (dir, id) => JSON.parse(await readFile(path.join(dir, `${validId(id)}.json`), 'utf8'))
  const locks = new Map()
  async function locked(id, fn) {
    const previous = locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    locks.set(id, next)
    try { return await next } finally { if (locks.get(id) === next) locks.delete(id) }
  }
  async function describe(source) {
    let offlineReason
    try {
      const s = await stat(source.path)
      if (!s.isFile() || s.size !== source.size || s.mtimeMs !== source.lastModified) offlineReason = 'Source changed on disk. Choose the original file to reconnect it.'
    } catch { offlineReason = 'Source is missing or cannot be read.' }
    return { sourceId: source.id, name: source.name, size: source.size, lastModified: source.lastModified, sourcePath: source.path,
      url: offlineReason ? undefined : `/api/media/${source.id}`, offlineReason }
  }
  async function register(filename, name) {
    const resolved = await realpath(filename)
    const s = await stat(resolved)
    if (!s.isFile() || !mediaTypes[path.extname(name ?? resolved).toLowerCase()]) throw fail(400, 'Choose a supported video, audio, or image file.')
    const record = { id: randomUUID(), path: resolved, name: name ?? path.basename(resolved), size: s.size, lastModified: s.mtimeMs }
    await atomicWrite(path.join(sources, `${record.id}.json`), record)
    return describe(record)
  }
  const exports = await createExports({ ...exportOptions, dataDir: root, resolveSource: async id => {
    const source = await read(sources, id)
    const descriptor = await describe(source)
    if (descriptor.offlineReason) throw fail(409, descriptor.offlineReason)
    return source
  } })
  return async function api(req, res, next = () => { res.writeHead(404); res.end() }) {
    if (!req.url?.startsWith('/api/')) return next()
    try {
      // This server has local disk access: accept only this application's loopback origin.
      const host = req.headers.host || ''
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) throw fail(403, 'Use a localhost address.')
      if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-origin access is not allowed.')
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-framecut'] !== '1') throw fail(403, 'Missing application request header.')
      const url = new URL(req.url, `http://${host}`)
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[1] === 'exports') {
        if (parts.length === 2 && req.method === 'GET') return json(res, { directory: exports.directory, jobs: exports.list() })
        if (parts.length === 2 && req.method === 'POST') {
          const input = await body(req)
          return json(res, await exports.start(validateProject(input.project), input.mutedTracks ?? []), 202)
        }
        if (parts.length === 3 && req.method === 'GET') return json(res, exports.get(validId(parts[2])))
        if (parts.length === 3 && req.method === 'DELETE') return json(res, await exports.cancel(validId(parts[2])))
        if (parts.length === 4 && parts[3] === 'file' && ['GET', 'HEAD'].includes(req.method)) {
          const output = await exports.download(validId(parts[2]))
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': output.size, 'Content-Disposition': `attachment; filename="export.mp4"; filename*=UTF-8''${encodeURIComponent(output.filename)}`, 'X-Content-Type-Options': 'nosniff' })
          if (req.method === 'HEAD') return res.end()
          await pipeline(createReadStream(output.path), res)
          return
        }
        throw fail(404, 'Export not found.')
      }
      if (req.method === 'GET' && url.pathname === '/api/browse') {
        const requested = url.searchParams.get('path') || homeDir
        if (!path.isAbsolute(requested)) throw fail(400, 'Enter an absolute folder path.')
        const dir = await realpath(requested)
        const entries = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() || e.isFile() && mediaTypes[path.extname(e.name).toLowerCase()])
          .map(e => ({ name: e.name, path: path.join(dir, e.name), directory: e.isDirectory() }))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
        return json(res, { path: dir, parent: path.dirname(dir), entries })
      }
      if (req.method === 'POST' && url.pathname === '/api/sources') {
        const input = await body(req)
        if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw fail(400, 'Enter an absolute media path.')
        return json(res, await register(input.path), 201)
      }
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        const name = url.searchParams.get('name')
        if (!name || name !== path.basename(name) || !mediaTypes[path.extname(name).toLowerCase()]) throw fail(400, 'Unsupported media filename.')
        const dest = path.join(media, `${randomUUID()}${path.extname(name).toLowerCase()}`)
        try {
          await pipeline(req, createWriteStream(dest, { flags: 'wx' }))
          return json(res, await register(dest, name), 201)
        } catch (error) { await unlink(dest).catch(() => {}); throw error }
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const entries = []
        for (const name of await readdir(projects)) {
          if (!name.endsWith('.json')) continue
          try { const p = JSON.parse(await readFile(path.join(projects, name), 'utf8')); entries.push({ id: p.id, name: p.project.name, updatedAt: p.updatedAt }) } catch { /* A corrupt project must not hide the other projects. */ }
        }
        return json(res, entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
      }
      if (parts[1] === 'projects' && parts.length === 3) {
        const id = validId(parts[2])
        if (req.method === 'GET') {
          const saved = await read(projects, id)
          saved.project.assets = await Promise.all(saved.project.assets.map(async a => {
            try { return { ...a, ...await describe(await read(sources, a.sourceId)) } }
            catch { return { ...a, url: undefined, offlineReason: 'Source record is missing.' } }
          }))
          return json(res, saved)
        }
        if (req.method === 'PUT') {
          const input = await body(req)
          const project = validateProject(input.project)
          // Validate IDs against registered sources, including currently offline files.
          await Promise.all(project.assets.map(a => read(sources, a.sourceId)))
          const saved = await locked(id, async () => {
            let current
            try { current = await read(projects, id) } catch (e) { if (e.code !== 'ENOENT') throw e }
            if ((current?.revision ?? 0) !== input.revision) throw fail(409, 'This project was saved in another tab. Open it again before saving, or use Save as new.')
            const record = { id, revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), project }
            await atomicWrite(path.join(projects, `${id}.json`), record)
            return record
          })
          return json(res, saved)
        }
      }
      if (parts[1] === 'media' && parts.length === 3 && ['GET', 'HEAD'].includes(req.method)) {
        const source = await read(sources, parts[2])
        const descriptor = await describe(source)
        if (descriptor.offlineReason) throw fail(409, descriptor.offlineReason)
        const size = source.size
        let start = 0, end = size - 1, status = 200
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
          if (!match || (!match[1] && !match[2])) { res.setHeader('Content-Range', `bytes */${size}`); throw fail(416, 'Invalid byte range.') }
          start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
          end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.setHeader('Content-Range', `bytes */${size}`); throw fail(416, 'Byte range is outside the file.') }
          status = 206
          res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        }
        res.writeHead(status, { 'Content-Type': mediaTypes[path.extname(source.path).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': size ? end - start + 1 : 0, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        if (req.method === 'HEAD' || size === 0) return res.end()
        await pipeline(createReadStream(source.path, { start, end }), res)
        return
      }
      throw fail(404, 'Not found.')
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      const status = error.status ?? (error.code === 'ENOENT' ? 404 : error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 500)
      json(res, { error: status === 404 ? 'The file or project could not be found.' : status === 500 ? 'The server could not complete the disk operation.' : error.message }, status)
      if (status === 500) console.error(error)
    }
  }
}
