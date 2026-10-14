export type TrackId = 'V2' | 'V1' | 'A1' | 'A2'
export type MediaKind = 'video' | 'audio' | 'image'

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif)$/i
export const DEFAULT_IMAGE_DURATION = 5

export function fitRect(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const w = sourceWidth * scale
  const h = sourceHeight * scale
  return { x: (width - w) / 2, y: (height - h) / 2, w, h }
}

// Stills have no source-time bounds; keep their offsets nonnegative after resizing.
export function resizeImageClip(clip: Clip, edge: 'start' | 'end', time: number): Clip {
  return edge === 'start'
    ? { ...clip, start: time, in: 0, out: endOf(clip) - time }
    : { ...clip, in: 0, out: time - clip.start }
}

export interface Asset {
  id: string
  name: string
  size: number
  lastModified: number
  duration: number
  width: number
  height: number
  frameRate?: number
  kind: MediaKind
  hasAudio: boolean
  sourceId?: string
  sourcePath?: string
  offlineReason?: string
  file?: File
  url?: string
  thumbnail?: string
}

export interface Clip {
  id: string
  assetId: string
  trackId: TrackId
  start: number
  in: number
  out: number
  linkedId?: string
}

export interface Project {
  version: 1
  name: string
  frameRate: number
  width: number
  height: number
  assets: Asset[]
  clips: Clip[]
  exportStart?: number
  exportEnd?: number
}

export const TRACKS: TrackId[] = ['V2', 'V1', 'A1', 'A2']
export const uid = () => crypto.randomUUID()
export const durationOf = (clip: Clip) => clip.out - clip.in
export const endOf = (clip: Clip) => clip.start + durationOf(clip)
export const projectEnd = (project: Project) => Math.max(0, ...project.clips.map(endOf))
export function exportRange(project: Project) {
  const duration = projectEnd(project)
  return {
    start: project.exportStart === undefined ? undefined : Math.min(project.exportStart, duration),
    end: project.exportEnd === undefined ? undefined : Math.min(project.exportEnd, duration),
  }
}

// Rebase intersecting clips to zero while preserving source offsets and empty gaps.
export function prepareExport(project: Project): { project: Project; duration: number; marked: boolean } {
  const { start, end } = exportRange(project)
  if (start === undefined || end === undefined) return { project, duration: projectEnd(project), marked: false }
  if (end <= start) throw new Error('Export end must be after export start. Move or clear the export markers.')
  const clips = project.clips.flatMap(clip => {
    const from = Math.max(start, clip.start)
    const to = Math.min(end, endOf(clip))
    return to > from ? [{ ...clip, start: from - start, in: clip.in + from - clip.start, out: clip.in + to - clip.start }] : []
  })
  return { project: { ...project, clips, exportStart: undefined, exportEnd: undefined }, duration: end - start, marked: true }
}
export const activeClip = (clips: Clip[], trackId: TrackId, time: number): Clip | undefined =>
  clips.filter(c => c.trackId === trackId && time >= c.start && time < endOf(c)).at(-1)
export const emptyProject = (): Project => ({
  version: 1,
  name: 'Untitled Sequence',
  frameRate: 30,
  width: 1920,
  height: 1080,
  assets: [],
  clips: [],
})

export function timecode(seconds: number, fps = 30): string {
  const frames = Math.max(0, Math.floor(seconds * fps + 0.0001))
  const f = frames % fps
  const s = Math.floor(frames / fps) % 60
  const m = Math.floor(frames / (fps * 60)) % 60
  const h = Math.floor(frames / (fps * 3600))
  return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':')
}

export function shortTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function serializeProject(project: Project): string {
  const assets = project.assets.map(({ file: _file, url: _url, sourcePath: _path, offlineReason: _offline, ...asset }) => asset)
  return JSON.stringify({ ...project, assets }, null, 2)
}

export function parseProject(text: string): Project {
  const value = JSON.parse(text) as Project
  if (value?.version !== 1 || !Array.isArray(value.assets) || !Array.isArray(value.clips)) {
    throw new Error('This is not a valid Framecut project.')
  }
  if (!Number.isInteger(value.width) || value.width < 16 || value.width > 3840 || !Number.isInteger(value.height) || value.height < 16 || value.height > 2160 || ![24, 25, 30, 60].includes(value.frameRate)) {
    throw new Error('The project has invalid sequence settings.')
  }
  for (const asset of value.assets) {
    if (typeof asset.id !== 'string' || typeof asset.name !== 'string' || !Number.isFinite(asset.size) || asset.size < 0 || !Number.isFinite(asset.duration) || asset.duration <= 0 || (asset.frameRate !== undefined && (!Number.isFinite(asset.frameRate) || asset.frameRate < 1 || asset.frameRate > 240)) || !['video', 'audio', 'image'].includes(asset.kind)) {
      throw new Error('The project contains an invalid media file entry.')
    }
  }
  if ([value.exportStart, value.exportEnd].some(marker => marker !== undefined && (!Number.isFinite(marker) || marker < 0)) ||
      (value.exportStart !== undefined && value.exportEnd !== undefined && value.exportEnd <= value.exportStart)) {
    throw new Error('The project contains invalid export markers.')
  }
  const assetById = new Map(value.assets.map(a => [a.id, a]))
  for (const clip of value.clips) {
    const asset = assetById.get(clip.assetId)
    if (!asset || !TRACKS.includes(clip.trackId) || !Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.in) || clip.in < 0 || !Number.isFinite(clip.out) || clip.out <= clip.in || (asset.kind !== 'image' && clip.out > asset.duration + 0.01) || (asset.kind === 'image' && !clip.trackId.startsWith('V'))) {
      throw new Error('The project contains an invalid timeline clip.')
    }
  }
  return { ...value, assets: value.assets.map(a => ({ ...a })), clips: value.clips.map(c => ({ ...c })) }
}

export function snapTime(time: number, targets: number[], threshold: number): number {
  let best = Math.max(0, time)
  let distance = threshold
  for (const target of targets) {
    const delta = Math.abs(target - time)
    if (delta < distance) { best = target; distance = delta }
  }
  return best
}

export function freeStart(clips: Clip[], trackId: TrackId, desired: number, duration: number, exclude: string[] = []): number {
  let start = Math.max(0, desired)
  const occupied = clips.filter(c => c.trackId === trackId && !exclude.includes(c.id)).sort((a, b) => a.start - b.start)
  for (const clip of occupied) {
    if (start + duration <= clip.start + 0.001) break
    if (start < endOf(clip) - 0.001) start = endOf(clip)
  }
  return start
}

export function matchingFile(asset: Asset, file: File): boolean {
  return asset.name === file.name && asset.size === file.size
}
