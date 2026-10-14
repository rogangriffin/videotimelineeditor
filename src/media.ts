import { ADTS, FLAC, MATROSKA, MP3, MP4, OGG, QTFF, WAVE, WEBM, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import type { Asset } from './model'
import { DEFAULT_IMAGE_DURATION, IMAGE_EXTENSIONS, fitRect, uid } from './model'
import type { SourceRecord } from './storage'
import { ClientMedia, type MediaProgress } from './clientMedia'

export const MEDIA_FORMATS = [MP4, QTFF, WEBM, MATROSKA, MP3, WAVE, OGG, FLAC, ADTS]

export const mediaSource = (asset: Asset) => {
  if (!asset.file) throw new Error(`${asset.name} must finish loading into the browser first.`)
  return new BlobSource(asset.file)
}

export async function loadStillImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not read the image from disk.')
  // Decode a single frame, including for animated image formats.
  return createImageBitmap(await response.blob())
}

export async function inspectSource(source: SourceRecord, session: ClientMedia, progress?: MediaProgress, original?: File): Promise<Asset> {
  const file = { ...source, ...await session.load(source, progress, original) }
  if (!file.url) throw new Error(file.offlineReason || 'Media is unavailable.')
  if (IMAGE_EXTENSIONS.test(file.name)) {
    const image = await loadStillImage(file.url)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 90
      const ctx = canvas.getContext('2d')!
      const rect = fitRect(image.width, image.height, canvas.width, canvas.height)
      ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h)
      return { ...file, id: uid(), duration: DEFAULT_IMAGE_DURATION, width: image.width, height: image.height,
        kind: 'image', hasAudio: false, thumbnail: canvas.toDataURL('image/png') }
    } finally { image.close() }
  }
  const input = new Input({ source: new BlobSource(file.file), formats: MEDIA_FORMATS })
  try {
  if (!(await input.canRead())) throw new Error(`${file.name} is not a supported media file.`)
  const video = await input.getPrimaryVideoTrack()
  const audio = await input.getPrimaryAudioTrack()
  if (!video && !audio) throw new Error(`${file.name} has no playable video or audio track.`)
  const duration = await input.getDurationFromMetadata() ?? await input.computeDuration()
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${file.name} has an invalid duration.`)

  let thumbnail: string | undefined
  let width = 0
  let height = 0
  let frameRate: number | undefined
  if (video) {
    width = await video.getDisplayWidth()
    height = await video.getDisplayHeight()
    try {
      const metrics = await video.computeFrameRateMetrics({ targetPacketCount: 120 })
      if (Number.isFinite(metrics.bestGuessFrameRate)) frameRate = metrics.bestGuessFrameRate
    } catch { /* The editor can use its default sequence rate. */ }
    try {
      const first = await video.getFirstTimestamp()
      const sample = await new VideoSampleSink(video).getSample(Math.min(duration - 0.01, Math.max(first, duration * 0.1)))
      if (sample) {
        const canvas = document.createElement('canvas')
        canvas.width = 160
        canvas.height = 90
        const ctx = canvas.getContext('2d')!
        ctx.fillStyle = '#090a0d'
        ctx.fillRect(0, 0, 160, 90)
        const scale = Math.min(160 / sample.displayWidth, 90 / sample.displayHeight)
        const w = sample.displayWidth * scale
        const h = sample.displayHeight * scale
        sample.draw(ctx, (160 - w) / 2, (90 - h) / 2, w, h)
        thumbnail = canvas.toDataURL('image/jpeg', 0.72)
        sample.close()
      }
    } catch { /* A video can still be previewed even if a thumbnail cannot be decoded. */ }
  }
  return {
    ...file,
    id: uid(), name: file.name, size: file.size, lastModified: file.lastModified,
    duration, width, height, frameRate, kind: video ? 'video' : 'audio', hasAudio: !!audio,
    thumbnail,
  }
  } finally { input.dispose() }
}
