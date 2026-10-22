import { memo, useEffect, useRef, useState } from 'react'
import type { Asset } from './model'
import { peakRange, waveformLevel, type Waveform } from './waveform'
import { waveforms } from './waveformCache'

// Clip movement and playhead ticks reuse the same source envelope and painted pixels.
export const AudioWaveform = memo(function AudioWaveform({ asset, sourceIn, sourceOut, start, zoom }: {
  asset: Asset; sourceIn: number; sourceOut: number; start: number; zoom: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const lastPaint = useRef<{ waveform?: Waveform; signature: string }>(undefined)
  const [visible, setVisible] = useState(false)
  const [result, setResult] = useState<{ file: File; waveform?: Waveform; error?: string }>()
  const waveform = result?.file === asset.file ? result?.waveform : undefined
  const error = result?.file === asset.file ? result?.error : undefined

  useEffect(() => {
    const element = host.current!
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: element.closest('.timeline-scroll'),
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible || !asset.file || !asset.url) { setResult(undefined); return }
    let cancelled = false
    const file = asset.file
    const lease = waveforms.acquire(asset)
    void lease.promise.then(value => { if (!cancelled) setResult({ file, waveform: value }) }, reason => {
      if (!cancelled) setResult({ file, error: reason instanceof Error ? reason.message : 'Audio could not be decoded.' })
    })
    return () => { cancelled = true; lease.release() }
  }, [visible, asset.file, asset.url, asset.sourceId, asset.size, asset.lastModified, asset.name])

  useEffect(() => {
    const element = host.current!
    const target = canvas.current!
    if (!visible) { target.width = 0; lastPaint.current = undefined; return }
    const scroll = element.closest('.timeline-scroll')
    let frame = 0
    const paint = () => {
      frame = 0
      const bounds = element.getBoundingClientRect()
      const viewport = scroll?.getBoundingClientRect()
      const left = Math.max(0, (viewport ? viewport.left + scroll!.clientLeft : 0) - bounds.left)
      const right = Math.min(bounds.width, (viewport ? viewport.left + scroll!.clientLeft + scroll!.clientWidth : window.innerWidth) - bounds.left)
      const width = Math.max(0, right - left)
      // Bound backing stores to the viewport, even for hour-long clips at maximum zoom.
      const ratio = Math.min(2, window.devicePixelRatio || 1)
      const pixels = Math.ceil(width * ratio)
      const height = Math.ceil(bounds.height * ratio)
      const signature = `${left}:${width}:${pixels}:${height}:${ratio}:${sourceIn}:${sourceOut}:${zoom}`
      if (signature === lastPaint.current?.signature && waveform === lastPaint.current.waveform) return
      lastPaint.current = { signature, waveform }
      target.style.left = `${left}px`; target.style.width = `${width}px`; target.style.height = `${bounds.height}px`
      target.width = pixels; target.height = height
      if (!waveform || !pixels || !height) return
      const ctx = target.getContext('2d')!
      const level = waveformLevel(waveform, zoom * ratio)
      const center = height / 2
      const amplitude = Math.max(0, center - 1)
      ctx.fillStyle = '#8fddcc'
      for (let x = 0; x < pixels; x++) {
        const from = sourceIn + (left + x / ratio) / zoom
        if (from >= sourceOut) break
        const to = Math.min(sourceOut, sourceIn + (left + (x + 1) / ratio) / zoom)
        const [min, max] = peakRange(level.peaks, level.rate, from, to)
        // Silence remains on the center line; amplitude is never normalized per clip.
        const top = center - max * amplitude
        ctx.fillRect(x, top, 1, Math.max(1, (max - min) * amplitude))
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
    const resize = new ResizeObserver(schedule)
    resize.observe(element)
    if (scroll) resize.observe(scroll)
    scroll?.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame); resize.disconnect()
      scroll?.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule)
    }
  }, [visible, waveform, sourceIn, sourceOut, start, zoom])

  const state = !asset.file || !asset.url ? 'offline' : error ? 'error' : waveform ? 'ready' : 'loading'
  return <div ref={host} className="waveform" data-waveform-state={state} title={error} aria-hidden="true">
    <canvas ref={canvas} />
    {visible && state === 'loading' && <span>Analyzing audio…</span>}
    {visible && state === 'error' && <span>Waveform unavailable</span>}
  </div>
})
