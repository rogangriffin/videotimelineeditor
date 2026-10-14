import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStorage } from './storage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')
const api = await createStorage({ dataDir: process.env.FRAMECUT_DATA_DIR || path.join(root, 'data') })
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
http.createServer((req, res) => api(req, res, async () => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const filename = pathname === '/' ? path.join(dist, 'index.html') : path.resolve(dist, `.${pathname}`)
    if (!filename.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return }
    const info = await stat(filename)
    if (!info.isFile()) throw new Error('Not a file')
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': info.size })
    if (req.method === 'HEAD') res.end()
    else createReadStream(filename).on('error', () => res.destroy()).pipe(res)
  } catch { res.writeHead(404); res.end('Not found. Run npm run build before npm start.') }
})).listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Framecut: http://127.0.0.1:${process.env.PORT || 4173}`))
