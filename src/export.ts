import {
  AudioBufferSink, AudioBufferSource, BufferTarget,
  CanvasSource, Conversion, Input, Mp4OutputFormat, Output, Quality, StreamTarget,
  VideoSample, VideoSampleSink, VideoSampleSource,
  canEncodeAudio, canEncodeVideo,
} from 'mediabunny'
import type { StreamTargetChunk } from 'mediabunny'
import type { Asset, Clip, Project, TrackId } from './model'
import { endOf, fitRect, prepareExport, projectEnd } from './model'
import { MEDIA_FORMATS, loadStillImage, mediaSource } from './media'

export interface ExportProgress { phase: string; progress: number }
export interface FileSaveHandle {
  createWritable(): Promise<{
    write(data: { type: 'write'; position: number; data: Uint8Array } | Uint8Array): Promise<void>
    close(): Promise<void>
    abort(): Promise<void>
  }>
}

async function createTarget(saveHandle?: FileSaveHandle) {
  if (!saveHandle) {
    const buffer = new BufferTarget()
    return {
      target: buffer as BufferTarget | StreamTarget,
      result: () => {
        if (!buffer.buffer) throw new Error('The MP4 encoder did not produce a file.')
        return new Blob([buffer.buffer], { type: 'video/mp4' })
      },
      abort: async () => {},
    }
  }
  const file = await saveHandle.createWritable()
  let closed = false
  const target = new StreamTarget(new WritableStream<StreamTargetChunk>({
    write: chunk => file.write({ type: 'write', position: chunk.position, data: chunk.data }),
    close: async () => { await file.close(); closed = true },
    abort: async () => { if (!closed) { await file.abort(); closed = true } },
  }), { chunked: true })
  return {
    target: target as BufferTarget | StreamTarget,
    result: () => null,
    abort: async () => { if (!closed) { await file.abort(); closed = true } },
  }
}

function simpleClip(project: Project, mutedTracks: TrackId[]): { asset: Asset; video: Clip; audio?: Clip } | null {
  const visible = project.clips.filter(c => !mutedTracks.includes(c.trackId))
  const videos = visible.filter(c => c.trackId.startsWith('V'))
  const audios = visible.filter(c => c.trackId.startsWith('A'))
  if (videos.length !== 1 || audios.length > 1) return null
  const video = videos[0]
  if (Math.abs(projectEnd(project) - endOf(video)) > 0.01) return null
  const asset = project.assets.find(a => a.id === video.assetId)
  if (!asset?.url || asset.kind !== 'video' || video.start !== 0 || video.in !== 0 || asset.width !== project.width || asset.height !== project.height) return null
  if (audios.length && (audios[0].assetId !== asset.id || audios[0].start !== 0 || audios[0].in !== 0 || Math.abs(audios[0].out - video.out) > 0.01)) return null
  if (asset.hasAudio !== !!audios.length) return null
  return { asset, video, audio: audios[0] }
}

async function tryCopyExport(project: Project, mutedTracks: TrackId[], onProgress: (status: ExportProgress) => void, saveHandle?: FileSaveHandle): Promise<Blob | null | undefined> {
  const candidate = simpleClip(project, mutedTracks)
  if (!candidate || !/\.(mp4|m4v)$/i.test(candidate.asset.name)) return undefined
  const input = new Input({ source: mediaSource(candidate.asset), formats: MEDIA_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    if (!video || await video.getCodec() !== 'avc' || (candidate.audio && (!audio || await audio.getCodec() !== 'aac'))) return undefined
    const rateInfo = await video.computeFrameRateMetrics({ targetPacketCount: 120 })
    if (!rateInfo.frameRateIsConstant || !Number.isFinite(rateInfo.bestGuessFrameRate) || Math.abs(rateInfo.bestGuessFrameRate - project.frameRate) > 0.07) return undefined
    const tracks = await input.getTracks()
    if (tracks.length !== (candidate.audio ? 2 : 1)) return undefined

    if (Math.abs(candidate.video.out - candidate.asset.duration) < 0.01) {
      onProgress({ phase: 'Copying original MP4', progress: 0.01 })
      if (!saveHandle) {
        onProgress({ phase: 'Complete', progress: 1 })
        return candidate.asset.file!
      }
      const file = await saveHandle.createWritable()
      const reader = candidate.asset.file!.stream().getReader()
      let written = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await file.write(value)
          written += value.byteLength
          onProgress({ phase: 'Copying original MP4', progress: written / candidate.asset.size })
        }
        await file.close()
      } catch (error) { await file.abort(); throw error }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      onProgress({ phase: 'Complete', progress: 1 })
      return null
    }

    const destination = await createTarget(saveHandle)
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: destination.target })
    try {
      const conversion = await Conversion.init({ input, output, tracks: 'primary', trim: { end: candidate.video.out } })
      if (!conversion.isValid) { await destination.abort(); return undefined }
      conversion.onProgress = progress => onProgress({ phase: 'Copying compressed media', progress })
      await conversion.execute()
      onProgress({ phase: 'Complete', progress: 1 })
      return destination.result()
    } catch (error) { await destination.abort(); throw error }
  } finally { input.dispose() }
}

export async function renderMp4(project: Project, onProgress: (status: ExportProgress) => void, mutedTracks: TrackId[] = [], saveHandle?: FileSaveHandle): Promise<Blob | null> {
  const prepared = prepareExport(project)
  project = prepared.project
  const duration = prepared.duration
  if (!duration) throw new Error('Add at least one clip to the timeline before exporting.')
  const missing = project.assets.filter(a => project.clips.some(c => c.assetId === a.id) && !a.file)
  if (missing.length) throw new Error(`Relink ${missing.length} missing media file${missing.length > 1 ? 's' : ''} before exporting.`)
  // Marked ranges are rendered for accurate cuts, including between keyframes.
  const copied = prepared.marked ? undefined : await tryCopyExport(project, mutedTracks, onProgress, saveHandle)
  if (copied !== undefined) return copied
  if (!(await canEncodeVideo('avc', { width: project.width, height: project.height }))) {
    throw new Error('This browser cannot encode H.264 MP4 at the sequence resolution. Try a recent Chromium browser or reduce the sequence resolution.')
  }

  const inputs = new Map<string, Input>()
  const images = new Map<string, ImageBitmap>()
  for (const asset of project.assets) {
    if (asset.url && asset.kind !== 'image') inputs.set(asset.id, new Input({ source: mediaSource(asset), formats: MEDIA_FORMATS }))
  }

  const videoClips = project.clips.filter(c => c.trackId.startsWith('V') && !mutedTracks.includes(c.trackId))
  const orderedClips = [...videoClips].sort((a, b) => a.start - b.start)
  const hasImages = videoClips.some(clip => project.assets.find(a => a.id === clip.assetId)?.kind === 'image')
  const noOverlays = !hasImages && orderedClips.every((clip, index) => index === 0 || clip.start >= endOf(orderedClips[index - 1]) - 0.0001)
  let needsTransform = videoClips.some(clip => {
    const asset = project.assets.find(a => a.id === clip.assetId)
    return !asset || asset.width !== project.width || asset.height !== project.height
  })
  if (noOverlays && !needsTransform) {
    for (const assetId of new Set(videoClips.map(c => c.assetId))) {
      const track = await inputs.get(assetId)!.getPrimaryVideoTrack()
      if (!track) continue
      const ratio = await track.getPixelAspectRatio()
      if ((await track.getRotation()) !== 0 || await track.getFlip() || ratio.num !== ratio.den) { needsTransform = true; break }
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = project.width
  canvas.height = project.height
  const ctx = canvas.getContext('2d', { alpha: false })!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const audioClips = project.clips.filter(c => c.trackId.startsWith('A') && !mutedTracks.includes(c.trackId))
  if (audioClips.length && !(await canEncodeAudio('aac'))) throw new Error('This browser cannot encode AAC audio for MP4 export.')
  const destination = await createTarget(saveHandle)
  let finalized = false
  try {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: destination.target })
    const videoSource = noOverlays
      ? new VideoSampleSource({ codec: 'avc', quality: new Quality('high'), ...(needsTransform ? { transform: { width: project.width, height: project.height, fit: 'contain' as const, alpha: 'discard' as const } } : {}) })
      : new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') })
    output.addVideoTrack(videoSource, { frameRate: project.frameRate })

    let audioSource: AudioBufferSource | undefined
    if (audioClips.length) {
      audioSource = new AudioBufferSource({ codec: 'aac', quality: new Quality('high') })
      output.addAudioTrack(audioSource)
    }

    let renderedAudio: AudioBuffer | undefined
    if (audioSource) {
      onProgress({ phase: 'Mixing audio', progress: 0.02 })
      const sampleRate = 48000
      const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate)
      for (let index = 0; index < audioClips.length; index++) {
        const clip = audioClips[index]
        const input = inputs.get(clip.assetId)!
        const track = await input.getPrimaryAudioTrack()
        if (!track) continue
        const sink = new AudioBufferSink(track)
        for await (const chunk of sink.buffers(clip.in, clip.out)) {
          const visibleStart = Math.max(clip.in, chunk.timestamp)
          const visibleEnd = Math.min(clip.out, chunk.timestamp + chunk.duration)
          if (visibleEnd <= visibleStart) continue
          const node = offline.createBufferSource()
          node.buffer = chunk.buffer
          node.connect(offline.destination)
          node.start(clip.start + visibleStart - clip.in, visibleStart - chunk.timestamp, visibleEnd - visibleStart)
        }
        onProgress({ phase: 'Mixing audio', progress: 0.03 + 0.12 * (index + 1) / audioClips.length })
      }
      renderedAudio = await offline.startRendering()
    }

    const totalFrames = Math.ceil(duration * project.frameRate)
    const windows: { clip: Clip; first: number; last: number; samples?: AsyncGenerator<VideoSample | null>; image?: ImageBitmap }[] = []
    for (const clip of videoClips) {
      const firstFrame = Math.max(0, Math.ceil(clip.start * project.frameRate - 0.0001))
      const lastFrame = Math.min(totalFrames, Math.ceil(endOf(clip) * project.frameRate - 0.0001))
      if (lastFrame <= firstFrame) continue
      const asset = project.assets.find(a => a.id === clip.assetId)!
      if (asset.kind === 'image') {
        if (!images.has(asset.id)) images.set(asset.id, await loadStillImage(asset.url!))
        windows.push({ clip, first: firstFrame, last: lastFrame, image: images.get(asset.id)! })
        continue
      }
      const track = await inputs.get(clip.assetId)!.getPrimaryVideoTrack()
      if (!track) continue
      function* timestamps() {
        for (let frame = firstFrame; frame < lastFrame; frame++) yield clip.in + frame / project.frameRate - clip.start
      }
      windows.push({ clip, first: firstFrame, last: lastFrame, samples: new VideoSampleSink(track).samplesAtTimestamps(timestamps()) })
    }
    windows.sort((a, b) => a.first - b.first)

    await output.start()
    let audioCursor = 0
    const audioChunkFrames = 2 * 48000
    const addAudioThrough = async (time: number) => {
      if (!audioSource || !renderedAudio) return
      const targetFrame = Math.min(renderedAudio.length, (Math.floor(time / 2) + 1) * audioChunkFrames)
      while (audioCursor < targetFrame) {
        const next = Math.min(renderedAudio.length, audioCursor + audioChunkFrames)
        const buffer = new AudioBuffer({ numberOfChannels: renderedAudio.numberOfChannels, length: next - audioCursor, sampleRate: renderedAudio.sampleRate })
        for (let channel = 0; channel < renderedAudio.numberOfChannels; channel++) {
          buffer.copyToChannel(renderedAudio.getChannelData(channel).subarray(audioCursor, next), channel)
        }
        await audioSource.add(buffer)
        audioCursor = next
      }
    }
    onProgress({ phase: 'Rendering video', progress: 0.16 })

    let nextWindow = 0
    let active: typeof windows = []
    for (let frame = 0; frame < totalFrames;) {
      const time = frame / project.frameRate
      while (nextWindow < windows.length && windows[nextWindow].first <= frame) active.push(windows[nextWindow++])
      active = active.filter(window => window.last > frame)
      await addAudioThrough(time)
      if (!active.length) {
        const nextStart = windows[nextWindow]?.first ?? totalFrames
        const gapEnd = Math.min(totalFrames, nextStart, frame + 2 * project.frameRate)
        const gapDuration = Math.min(duration - time, (gapEnd - frame) / project.frameRate)
        if (videoSource instanceof VideoSampleSource) {
          const black = new VideoSample(canvas, { timestamp: time, duration: gapDuration })
          await videoSource.add(black)
          black.close()
        } else {
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          await videoSource.add(time, gapDuration)
        }
        frame = gapEnd
      } else if (videoSource instanceof VideoSampleSource) {
        const sample = (await active[0].samples!.next()).value
        if (sample) {
          sample.setTimestamp(time)
          sample.setDuration(Math.min(1 / project.frameRate, duration - time))
          await videoSource.add(sample)
          sample.close()
        } else {
          const black = new VideoSample(canvas, { timestamp: time, duration: Math.min(1 / project.frameRate, duration - time) })
          await videoSource.add(black)
          black.close()
        }
        frame++
      } else {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        for (const window of [...active].sort((a, b) => (a.clip.trackId === 'V1' ? 0 : 1) - (b.clip.trackId === 'V1' ? 0 : 1))) {
          if (window.image) {
            const rect = fitRect(window.image.width, window.image.height, canvas.width, canvas.height)
            ctx.drawImage(window.image, rect.x, rect.y, rect.w, rect.h)
            continue
          }
          const sample = (await window.samples!.next()).value
          if (!sample) continue
          const rect = fitRect(sample.displayWidth, sample.displayHeight, canvas.width, canvas.height)
          sample.draw(ctx, rect.x, rect.y, rect.w, rect.h)
          sample.close()
        }
        await videoSource.add(time, Math.min(1 / project.frameRate, duration - time))
        frame++
      }
      if (frame % project.frameRate === 0 || frame === totalFrames) {
        onProgress({ phase: 'Rendering video', progress: 0.16 + 0.8 * frame / totalFrames })
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    await addAudioThrough(duration)
    audioSource?.close()
    videoSource.close()
    onProgress({ phase: 'Finalizing MP4', progress: 0.97 })
    await output.finalize()
    finalized = true
    onProgress({ phase: 'Complete', progress: 1 })
    return destination.result()
  } finally {
    if (!finalized) await destination.abort()
    for (const input of inputs.values()) input.dispose()
    for (const image of images.values()) image.close()
  }
}
