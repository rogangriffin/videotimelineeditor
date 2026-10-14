import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import '../src/styles.css'
import { ClientMedia } from '../src/clientMedia'
import { inspectSource, mediaSource } from '../src/media'
import { uploadSource, readProject, writeProject } from '../src/storage'
import { emptyProject, timecode as formatTimecode, uid } from '../src/model'
import { renderMp4 } from '../src/export'
import { Input, MP4, VideoSampleSink, AudioBufferSink } from 'mediabunny'

const report = (message: string) => { document.querySelector('#results')!.textContent += `${message}\n` }
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message) }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, description: string, timeout = 15000) {
  const end = performance.now() + timeout
  while (!check()) { if (performance.now() > end) throw Error(`Timed out: ${description}`); await wait(30) }
}

document.querySelector<HTMLButtonElement>('#run')!.onclick = async event => {
  (event.currentTarget as HTMLButtonElement).disabled = true
  const setup = new ClientMedia()
  const playback = new ClientMedia()
  const originalFetch = window.fetch.bind(window)
  let mediaRequests = 0
  let blockMedia = false
  window.fetch = async (...args) => {
    if (String(args[0]).includes('/api/media/')) {
      mediaRequests++
      if (blockMedia) throw Error('Server media deliberately unavailable during playback')
    }
    return originalFetch(...args)
  }
  try {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ef3522'; ctx.fillRect(0, 0, 320, 180)
    const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)))
    const image = await inspectSource(await uploadSource(new File([png], 'preload-picture.png', { type: 'image/png' })), setup)
    const fixtureDuration = 8
    const samples = 48000 * fixtureDuration
    const wav = new ArrayBuffer(44 + samples * 2); const view = new DataView(wav)
    const text = (offset: number, value: string) => [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)))
    text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    text(36, 'data'); view.setUint32(40, samples * 2, true)
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * Math.PI * 2 * 440 / 48000) * 2000), true)
    const audio = await inspectSource(await uploadSource(new File([wav], 'preload-tone.wav', { type: 'audio/wav' })), setup)
    const rendered = await renderMp4({ ...emptyProject(), width: 320, height: 180, frameRate: 24, assets: [image, audio], clips: [
      { id: uid(), assetId: image.id, trackId: 'V1', start: 0, in: 0, out: fixtureDuration },
      { id: uid(), assetId: audio.id, trackId: 'A1', start: 0, in: 0, out: fixtureDuration },
    ] }, () => {})
    const video = await inspectSource(await uploadSource(new File([rendered!], 'preload-video.mp4', { type: 'video/mp4' })), setup)
    const full = { ...emptyProject(), name: 'Client preload verification', width: 320, height: 180, frameRate: 24, assets: [video], clips: [
      { id: uid(), assetId: video.id, trackId: 'V1' as const, start: 0, in: 0, out: video.duration },
      { id: uid(), assetId: video.id, trackId: 'A1' as const, start: 0, in: 0, out: video.duration },
    ] }
    const edited = { ...full, clips: full.clips.flatMap(c => [{ ...c, out: 0.75 }, { ...c, id: uid(), start: 0.75, in: 1, out: 2 }]) }
    const saved = await writeProject(uid(), 0, edited)
    const loaded = await playback.loadProject((await readProject(saved.id)).project)
    assert(loaded.assets.every(a => a.file && a.url?.startsWith('blob:')), 'Project was not fully preloaded')
    report('PASS: saved video/audio project reloads as complete local files and blob URLs')
    localStorage.setItem('framecut-project', saved.id)
    const beforeAppLoad = mediaRequests
    let root = createRoot(document.querySelector('#editor')!)
    root.render(<React.StrictMode><App /></React.StrictMode>)
    const program = () => document.querySelector<HTMLVideoElement>('#editor .program-video')
    await until(() => !!program() && program()!.readyState >= 3, 'project media ready')
    const player = program()!
    assert(document.querySelectorAll('#editor .preload-media').length === 2, 'Upcoming audio/video clips were not prepared ahead of the cut')
    assert(player.src.startsWith('blob:'), 'Video player is still streaming')
    assert(document.querySelector<HTMLAudioElement>('#editor .program-screen audio')?.src.startsWith('blob:'), 'Audio player is still streaming')
    report(`PASS: video and audio players use local sources (${mediaRequests - beforeAppLoad} preload request(s), including StrictMode cancellation)`)
    blockMedia = true
    const beforeOffline = mediaRequests
    ctx.drawImage(player, 0, 0)
    assert(ctx.getImageData(100, 100, 1, 1).data[0] > 180, 'Preview is blank')
    const input = new Input({ source: mediaSource(loaded.assets[0]), formats: [MP4] })
    try {
      const sample = await new VideoSampleSink((await input.getPrimaryVideoTrack())!).getSample(1)
      assert(sample, 'Cannot decode video locally'); sample?.close()
      const audioBuffer = await new AudioBufferSink((await input.getPrimaryAudioTrack())!).getBuffer(1)
      assert(audioBuffer && audioBuffer.buffer.getChannelData(0).some(value => Math.abs(value) > 0.01), 'Audio is silent')
    } finally { input.dispose() }
    const play = document.querySelector<HTMLButtonElement>('#editor .play-control')!
    const timecode = () => document.querySelector('#editor .timeline-current')!.textContent
    // Simulate a decoder not being ready at Play; the clock must wait.
    const time = timecode()
    Object.defineProperty(player, 'readyState', { configurable: true, get: () => 1 })
    play.click(); await wait(200)
    assert(timecode() === time, 'Timeline advanced before media was ready')
    Reflect.deleteProperty(player, 'readyState')
    await until(() => play.title === 'Play (Space)' && timecode() === '00:00:01:18', 'playback across trimmed clip transition')
    report('PASS: timeline waits for readiness; video/audio play through a trimmed clip transition with server media blocked')
    const copied = await renderMp4({ ...full, assets: loaded.assets }, () => {})
    assert(copied === loaded.assets[0].file, 'Unchanged MP4 was not copied from the local file')
    const trimmed = await renderMp4({ ...loaded, clips: loaded.clips.slice(0, 1).map(c => ({ ...c, out: 0.5 })) }, () => {})
    assert(trimmed && trimmed.size > 0, 'Local render failed')
    assert(mediaRequests === beforeOffline, 'Playback or export fetched media from the server')
    report('PASS: preview pixels, decoded sound, MP4 copy, and edited export require zero server media requests after loading')
    blockMedia = false
    const fullSaved = await writeProject(uid(), 0, full)
    localStorage.setItem('framecut-project', fullSaved.id)
    root.unmount()
    root = createRoot(document.querySelector('#editor')!)
    root.render(<App />)
    await until(() => !!program() && program()!.readyState >= 3, 'full-length clip loaded')
    blockMedia = true
    const beforeFullPlay = mediaRequests
    const fullPlay = document.querySelector<HTMLButtonElement>('#editor .play-control')!
    const fullVideo = program()!
    const fullAudio = document.querySelector<HTMLAudioElement>('#editor .program-screen audio:not(.preload-media)')!
    fullPlay.click()
    await until(() => !fullAudio.paused && fullAudio.currentTime > 0.15, 'full clip starts')
    const startedAt = performance.now()
    let audioPauses = 0, videoSeeks = 0
    fullAudio.addEventListener('pause', () => { if (!fullAudio.ended && fullAudio.currentTime < video.duration - 0.1) audioPauses++ })
    fullVideo.addEventListener('seeking', () => videoSeeks++)
    // HAVE_CURRENT_DATA/HAVE_FUTURE_DATA changes during ordinary decoding must
    // not trigger a pause-all/reseek feedback loop.
    Object.defineProperty(fullVideo, 'readyState', { configurable: true, get: () => Math.floor(performance.now() / 70) % 2 ? 2 : 3 })
    await until(() => fullPlay.title === 'Play (Space)' && timecode() === formatTimecode(video.duration, 24), 'playback stops at the natural source end')
    Reflect.deleteProperty(fullVideo, 'readyState')
    assert(audioPauses === 0 && videoSeeks === 0, `Readiness changes interrupted playback: ${audioPauses} audio pauses, ${videoSeeks} video seeks`)
    assert(performance.now() - startedAt < (video.duration + 2) * 1000, 'Playback repeatedly stalled')
    assert(mediaRequests === beforeFullPlay, 'Full-length playback requested server media')
    report(`PASS: ${fixtureDuration}-second playback with fluctuating video readiness: ${audioPauses} audio pauses, ${videoSeeks} video seeks; reaches natural end`)
    report('ALL CLIENT MEDIA CHECKS PASSED')
  } catch (error) { report(`FAIL: ${(error as Error).stack}`) }
  finally { window.fetch = originalFetch; setup.dispose(); playback.dispose() }
}
