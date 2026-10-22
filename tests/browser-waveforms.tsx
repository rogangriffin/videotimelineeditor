import React from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { AudioWaveform } from '../src/AudioWaveform'
import { ClientMedia } from '../src/clientMedia'
import { inspectSource } from '../src/media'
import { emptyProject, uid } from '../src/model'
import { uploadSource, writeProject } from '../src/storage'
import { WaveformCache } from '../src/waveformCache'
import { peakRange, waveformKey, waveformBytes } from '../src/waveform'
import { readWaveform } from '../src/waveformStore'
import { renderMp4 } from '../src/export'
import '../src/styles.css'

const report = (message: string) => { document.querySelector('#results')!.textContent += `${message}\n` }
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message) }
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean, description: string, timeout = 20000) {
  const end = performance.now() + timeout
  while (!check()) { if (performance.now() > end) throw Error(`Timed out: ${description}`); await wait(30) }
}

function fixture() {
  const rate = 48000, frames = rate * 6
  const data = new ArrayBuffer(44 + frames * 4), view = new DataView(data)
  const text = (offset: number, value: string) => [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)))
  text(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, frames * 4, true)
  for (let i = 0; i < frames; i++) {
    const amplitude = i >= rate && i < rate * 2 ? 0.12 : i >= rate * 2 && i < rate * 3 ? 0.8 : 0
    const sample = i === rate * 4.25 ? 32000 : Math.round(Math.sin(i / rate * Math.PI * 2 * 440) * amplitude * 32767)
    view.setInt16(44 + i * 4, sample, true); view.setInt16(46 + i * 4, -sample, true)
  }
  return new File([data], 'waveform-stereo.wav', { type: 'audio/wav', lastModified: 123 })
}

function columnHeight(canvas: HTMLCanvasElement, seconds: number, zoom: number) {
  const ratio = canvas.width / parseFloat(canvas.style.width)
  const x = Math.floor(seconds * zoom * ratio)
  const pixels = canvas.getContext('2d')!.getImageData(x, 0, 1, canvas.height).data
  let count = 0
  for (let y = 0; y < canvas.height; y++) if (pixels[y * 4 + 3]) count++
  return count
}

document.querySelector<HTMLButtonElement>('#run')!.onclick = async event => {
  (event.currentTarget as HTMLButtonElement).disabled = true
  const session = new ClientMedia()
  const cache = new WaveformCache()
  try {
    const file = fixture()
    const asset = await inspectSource(await uploadSource(file), session, undefined, file)
    const first = cache.acquire(asset), shared = cache.acquire(asset)
    assert(first.promise === shared.promise, 'Source analysis was not shared')
    const waveform = await first.promise
    const at = (from: number, to: number) => peakRange(waveform.levels[0], waveform.rate, from, to)
    assert(at(0, 0.9).every(value => value === 0), 'Silence is not flat')
    assert(Math.abs(at(1.1, 1.9)[1] - 0.12) < 0.001, 'Quiet audio amplitude is inaccurate')
    assert(Math.abs(at(2.1, 2.9)[1] - 0.8) < 0.001, 'Stereo phase cancellation hid audio')
    assert(at(4.24, 4.26)[1] > 0.97, 'Single-sample transient disappeared')
    first.release(); shared.release()
    report(`PASS: worker decodes stereo WAV accurately; phase, silence, transients and amplitude preserved (${waveformBytes(waveform)} bytes of peaks)`)

    const stored = await readWaveform(waveformKey(asset))
    assert(stored?.levels[0].length === waveform.levels[0].length, 'Persistent cache was not written')
    const reopened = new WaveformCache()
    // This deliberately undecodable File proves the new worker used persistence, not a second decode.
    const disk = reopened.acquire({ ...asset, file: new File(['invalid'], file.name) })
    const restored = await disk.promise; disk.release()
    assert(restored.levels[0].every((value, i) => value === waveform.levels[0][i]), 'Persisted peaks changed')
    report('PASS: a fresh worker restores exact peaks from IndexedDB without decoding again')

    const imageCanvas = document.createElement('canvas'); imageCanvas.width = 160; imageCanvas.height = 90
    const imageBlob = await new Promise<Blob>(resolve => imageCanvas.toBlob(value => resolve(value!)))
    const image = await inspectSource(await uploadSource(new File([imageBlob], 'waveform.png', { type: 'image/png' })), session)
    const mp4 = await renderMp4({ ...emptyProject(), width: 160, height: 90, frameRate: 24, assets: [image, asset], clips: [
      { id: uid(), assetId: image.id, trackId: 'V1', start: 0, in: 0, out: 3 },
      { id: uid(), assetId: asset.id, trackId: 'A1', start: 0, in: 0, out: 3 },
    ] }, () => {})
    const video = await inspectSource(await uploadSource(new File([mp4!], 'waveform-video.mp4', { type: 'video/mp4' })), session)
    const embedded = cache.acquire(video)
    const videoPeaks = await embedded.promise; embedded.release()
    const audioRange = peakRange(videoPeaks.levels[0], videoPeaks.rate, 2.1, 2.8)
    assert(audioRange[1] > 0.6 && audioRange[0] < -0.6, 'Embedded video audio waveform is missing')
    report('PASS: worker extracts the actual AAC audio from an MP4 video')

    const project = { ...emptyProject(), name: 'Waveform verification', assets: [asset], clips: [
      { id: uid(), assetId: asset.id, trackId: 'A1' as const, start: 0, in: 0, out: 6 },
      { id: uid(), assetId: asset.id, trackId: 'A2' as const, start: 1, in: 2, out: 3.5 },
    ] }
    const saved = await writeProject(uid(), 0, project)
    localStorage.setItem('framecut-project', saved.id)
    createRoot(document.querySelector('#editor')!).render(<React.StrictMode><App /></React.StrictMode>)
    // Make both audio tracks visible, even on a short browser viewport.
    await until(() => !!document.querySelector('#editor .timeline-scroll'), 'editor mount')
    document.querySelector('#editor .timeline-scroll')!.scrollIntoView({ block: 'center' })
    const scroll = document.querySelector('#editor .timeline-scroll')!
    scroll.scrollTop = scroll.scrollHeight
    await until(() => document.querySelectorAll('#editor [data-waveform-state="ready"] canvas').length === 2, 'timeline waveforms')
    const canvases = () => [...document.querySelectorAll<HTMLCanvasElement>('#editor .waveform canvas')]
    await until(() => canvases().every(canvas => canvas.width > 0), 'waveform paint')
    const [full, trimmed] = canvases()
    const silence = columnHeight(full, 0.5, 80), quiet = columnHeight(full, 1.5, 80), loud = columnHeight(full, 2.5, 80)
    assert(loud > quiet + 4 && quiet >= silence, `Canvas amplitude is incorrect: ${silence}/${quiet}/${loud}`)
    assert(columnHeight(trimmed, 0.25, 80) >= loud - 1, 'Trimmed clip does not start at source time 2s')
    report('PASS: editor canvas shows real amplitudes; trimmed A2 starts at the correct source offset')

    const oldWidth = full.width
    document.querySelector<HTMLButtonElement>('#editor [title="Zoom in"]')!.click()
    await until(() => full.width > oldWidth, 'zoom repaint')
    assert(columnHeight(full, 2.5, 100) >= loud - 1, 'Zoom changed source amplitude')
    let repaints = 0
    const observer = new MutationObserver(events => { repaints += events.length })
    observer.observe(full, { attributes: true, attributeFilter: ['width', 'height'] })
    document.querySelector<HTMLButtonElement>('#editor .play-control')!.click()
    await wait(300)
    document.querySelector<HTMLButtonElement>('#editor .play-control')!.click()
    observer.disconnect()
    assert(repaints === 0, `Playhead updates repainted waveform ${repaints} times`)
    report('PASS: zoom preserves source alignment; playback does not repaint waveform pixels')

    createRoot(document.querySelector('#stress')!).render(<div className="timeline-scroll"><div className="track-row" style={{ width: 3600 * 220 }}><div className="timeline-clip audio-clip" style={{ left: 0, width: 3600 * 220 }}><AudioWaveform asset={asset} sourceIn={0} sourceOut={3600} start={0} zoom={220} /></div></div></div>)
    document.querySelector('#stress')!.scrollIntoView({ block: 'center' })
    await until(() => !!document.querySelector('#stress [data-waveform-state="ready"] canvas'), 'long clip waveform')
    const bounded = document.querySelector<HTMLCanvasElement>('#stress canvas')!
    await until(() => bounded.width > 0, 'long clip paint')
    assert(bounded.width <= 1202, `Long clip allocated ${bounded.width} pixels instead of viewport width`)
    const stressScroll = document.querySelector<HTMLElement>('#stress .timeline-scroll')!
    stressScroll.scrollLeft = 220 * 2
    await until(() => parseFloat(bounded.style.left) > 400, 'scroll repaint')
    assert(columnHeight(bounded, 0.25, 220) > 8, 'Scrolling did not read the matching source region')
    report(`PASS: hour-long clip at maximum zoom uses only ${bounded.width} canvas pixels; scrolling maps back to source audio`)
    report('ALL WAVEFORM CHECKS PASSED')
  } catch (error) { report(`FAIL: ${error instanceof Error ? error.stack : error}`); console.error(error) }
  finally { session.dispose() }
}
