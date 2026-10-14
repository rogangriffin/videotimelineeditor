// Keep the transport independent of React renders. Native media time is the
// authority while playing; readyState is only a startup/seek gate.
export interface PreviewElement {
  currentTime: number
  readyState: number
  seeking: boolean
  paused: boolean
  ended: boolean
  playbackRate: number
  play(): Promise<void>
  pause(): void
}

export interface PreviewClip {
  id: string
  start: number
  in: number
  audio: boolean
  element?: PreviewElement
}

export class PlaybackTransport {
  private active = new Map<string, { element: PreviewElement; positioned: boolean; started: boolean; pending: boolean; lastCorrection: number }>()
  private master?: string
  private lastTick?: number
  private lastMotion?: number
  private disposed = false
  private generation = 0

  constructor(private onError: (message: string) => void) {}

  seek() {
    this.generation++
    for (const state of this.active.values()) {
      state.element.pause()
      state.element.playbackRate = 1
      state.positioned = false
      state.started = false
    }
    this.master = undefined
    this.lastMotion = undefined
  }

  step(now: number, current: number, boundary: number, clips: PreviewClip[]) {
    const delta = this.lastTick === undefined ? 0 : Math.max(0, (now - this.lastTick) / 1000)
    this.lastTick = now
    const ids = new Set(clips.map(c => c.id))
    for (const [id, state] of this.active) {
      if (!ids.has(id)) { state.element.pause(); state.element.playbackRate = 1; this.active.delete(id) }
    }

    for (const clip of clips) {
      const el = clip.element
      if (!el) continue
      let state = this.active.get(clip.id)
      if (!state || state.element !== el) {
        state = { element: el, positioned: false, started: false, pending: false, lastCorrection: now }
        this.active.set(clip.id, state)
      }
      if (!state.positioned && el.readyState >= 1) {
        const target = Math.max(0, clip.in + current - clip.start)
        if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target
        state.positioned = true
      }
    }

    const ready = (clip: PreviewClip) => {
      const state = this.active.get(clip.id)
      return state?.positioned && clip.element && clip.element.readyState >= 2 && !clip.element.seeking
    }
    const previousMaster = clips.find(c => c.id === this.master && this.active.get(c.id)?.started)
    // Wait as a group only when starting, seeking, or replacing the clock source.
    // A secondary video's temporary readiness dip must never pause running audio.
    if (!previousMaster && clips.some(c => !ready(c))) {
      this.lastMotion ??= now
      return { time: current, waiting: now - this.lastMotion > 350 }
    }
    for (const clip of clips) {
      const state = this.active.get(clip.id)
      const el = clip.element
      if (!state || !el || state.started || state.pending || !ready(clip)) continue
      if (el.ended) { state.started = true; continue }
      state.pending = true
      const generation = this.generation
      void el.play().then(() => { if (generation === this.generation) state.started = true }).catch(error => {
        if (!this.disposed && error.name !== 'AbortError') this.onError(`Playback could not start: ${error.message}`)
      }).finally(() => { state.pending = false })
    }

    const master = (previousMaster?.audio ? previousMaster : undefined) ?? clips.find(c => c.audio && this.active.get(c.id)?.started) ?? previousMaster
      ?? clips.find(c => this.active.get(c.id)?.started)
    this.master = master?.id
    let next = current
    if (!clips.length || master?.element?.ended) next = current + delta
    else if (master?.element && !master.element.seeking) next = master.start + master.element.currentTime - master.in
    next = Math.max(current, Math.min(boundary, next))
    if (next > current + 0.00001) this.lastMotion = now
    else this.lastMotion ??= now

    for (const clip of clips) {
      const state = this.active.get(clip.id)
      const el = clip.element
      if (!master || clip.id === master.id || !state?.started || !el || el.seeking || el.ended) continue
      const drift = clip.in + next - clip.start - el.currentTime
      // Correct small drift with speed, without flushing the decoder. Re-seek
      // only after a large discontinuity, at most once every two seconds.
      if (Math.abs(drift) > 0.75 && now - state.lastCorrection >= 2000) {
        el.currentTime = Math.max(0, clip.in + next - clip.start)
        state.lastCorrection = now
        el.playbackRate = 1
      } else {
        const rate = Math.abs(drift) < 0.04 ? 1 : Math.max(0.95, Math.min(1.05, 1 + drift * 0.1))
        if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate
      }
    }
    return { time: next, waiting: clips.length > 0 && now - this.lastMotion > 350 }
  }

  dispose() {
    this.disposed = true
    for (const state of this.active.values()) { state.element.pause(); state.element.playbackRate = 1 }
    this.active.clear()
  }
}
