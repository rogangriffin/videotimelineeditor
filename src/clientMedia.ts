import type { Asset, Project } from './model'
import type { SourceRecord } from './storage'

export type MediaProgress = (message: string) => void
type LocalMedia = { file: File; url: string }

// A project owns its media URLs for the lifetime of its undo/redo history.
// Never hand a server URL to a player or decoder.
export class ClientMedia {
  private controller = new AbortController()
  private entries = new Map<string, Promise<LocalMedia>>()
  private urls = new Set<string>()

  async load(source: SourceRecord, progress?: MediaProgress, original?: File): Promise<LocalMedia> {
    this.controller.signal.throwIfAborted()
    if (!source.url) throw new Error(source.offlineReason || `${source.name} is unavailable.`)
    const key = `${source.sourceId}:${source.size}:${source.lastModified}`
    const existing = this.entries.get(key)
    if (existing) return existing
    const pending = this.download(source, progress, original)
    this.entries.set(key, pending)
    try { return await pending }
    catch (error) { this.entries.delete(key); throw error }
  }

  private async download(source: SourceRecord, progress?: MediaProgress, original?: File): Promise<LocalMedia> {
    const signal = this.controller.signal
    progress?.(`Loading ${source.name} into browser…`)
    let file = original
    if (!file) {
      const response = await fetch(source.url!, { signal })
      if (!response.ok) throw new Error(`Could not load ${source.name} (${response.status}). Check the source and retry.`)
      if (!response.body) throw new Error(`No media data was returned for ${source.name}.`)
      const reader = response.body.getReader()
      const chunks: BlobPart[] = []
      let received = 0
      let lastUpdate = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.byteLength
          if (Date.now() - lastUpdate > 100) {
            progress?.(`Loading ${source.name} · ${Math.min(100, Math.floor(received / Math.max(1, source.size) * 100))}%`)
            lastUpdate = Date.now()
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      if (received !== source.size) throw new Error(`${source.name} was not completely loaded. Retry loading the media.`)
      file = new File(chunks, source.name, { type: response.headers.get('content-type') || '', lastModified: source.lastModified })
    }
    signal.throwIfAborted()
    if (file.size !== source.size) throw new Error(`${source.name} does not match the saved source size.`)
    const url = URL.createObjectURL(file)
    this.urls.add(url)
    return { file, url }
  }

  async loadProject(project: Project, progress?: MediaProgress): Promise<Project> {
    const assets: Asset[] = []
    for (const [index, asset] of project.assets.entries()) {
      this.controller.signal.throwIfAborted()
      if (!asset.url || !asset.sourceId) { assets.push({ ...asset, file: undefined, url: undefined }); continue }
      try {
        const local = await this.load(asset as SourceRecord, message => progress?.(`${index + 1}/${project.assets.length} · ${message}`))
        assets.push({ ...asset, ...local, offlineReason: undefined })
      } catch (error) {
        this.controller.signal.throwIfAborted()
        assets.push({ ...asset, file: undefined, url: undefined, offlineReason: error instanceof Error ? error.message : 'Media could not be loaded.' })
      }
    }
    return { ...project, assets }
  }

  dispose() {
    this.controller.abort()
    for (const url of this.urls) URL.revokeObjectURL(url)
    this.urls.clear()
    this.entries.clear()
  }
}
