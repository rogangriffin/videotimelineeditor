import type { Asset } from './model'
import { waveformBytes, waveformKey, type Waveform } from './waveform'

interface Entry {
  key: string; file?: File; refs: number; used: number; bytes: number
  promise: Promise<Waveform>; resolve: (value: Waveform) => void; reject: (error: Error) => void
  settled: boolean; releaseTimer?: ReturnType<typeof setTimeout>
}

export class WaveformCache {
  private entries = new Map<string, Entry>()
  private queue: Entry[] = []
  private active?: Entry
  private worker?: Worker
  private idleTimer?: ReturnType<typeof setTimeout>
  private bytes = 0

  constructor(
    private createWorker = () => new Worker(new URL('./waveform.worker.ts', import.meta.url), { type: 'module' }),
    private maxBytes = 64 * 1024 * 1024,
  ) {}

  acquire(asset: Asset) {
    if (!asset.file) throw new Error('Media is offline.')
    const key = waveformKey(asset)
    let entry = this.entries.get(key)
    if (!entry) {
      let resolve!: Entry['resolve'], reject!: Entry['reject']
      const promise = new Promise<Waveform>((yes, no) => { resolve = yes; reject = no })
      entry = { key, file: asset.file, refs: 0, used: 0, bytes: 0, promise, resolve, reject, settled: false }
      this.entries.set(key, entry)
      this.queue.push(entry)
    }
    const current = entry
    clearTimeout(current.releaseTimer)
    current.refs++; current.used = performance.now()
    this.pump()
    let released = false
    return { promise: current.promise, release: () => {
      if (released) return
      released = true
      current.refs--
      // React StrictMode replays effects; allow the new subscriber to reuse the job.
      if (!current.refs) current.releaseTimer = setTimeout(() => {
        if (!current.settled) {
          this.queue = this.queue.filter(item => item !== current)
          if (this.active === current) { this.stopWorker(); this.active = undefined }
          this.entries.delete(key)
          current.file = undefined; current.settled = true
          current.reject(new DOMException('Waveform analysis cancelled.', 'AbortError'))
          this.pump()
        }
        this.prune()
      }, 0)
    } }
  }

  private stopWorker() {
    clearTimeout(this.idleTimer)
    this.worker?.terminate(); this.worker = undefined
  }

  private pump() {
    if (this.active) return
    clearTimeout(this.idleTimer)
    const entry = this.queue.shift()
    if (!entry) {
      this.idleTimer = setTimeout(() => this.stopWorker(), 1000)
      return
    }
    this.active = entry
    try {
      if (!this.worker) {
        this.worker = this.createWorker()
        this.worker.onmessage = event => {
          const current = this.active
          if (!current || event.data.key !== current.key) return
          if (event.data.error) this.finish(undefined, new Error(event.data.error))
          else this.finish(event.data.waveform)
        }
        this.worker.onerror = () => { this.stopWorker(); this.finish(undefined, new Error('Waveform worker could not run.')) }
        this.worker.onmessageerror = () => { this.stopWorker(); this.finish(undefined, new Error('Waveform data could not be read.')) }
      }
      this.worker.postMessage({ key: entry.key, file: entry.file })
    } catch (error) { this.stopWorker(); this.finish(undefined, error as Error) }
  }

  private finish(waveform?: Waveform, error?: Error) {
    const entry = this.active!
    this.active = undefined
    entry.file = undefined; entry.settled = true
    if (waveform) {
      entry.bytes = waveformBytes(waveform); this.bytes += entry.bytes
      entry.resolve(waveform)
    } else { this.entries.delete(entry.key); entry.reject(error!) }
    this.prune(); this.pump()
  }

  private prune() {
    for (const entry of [...this.entries.values()].sort((a, b) => a.used - b.used)) {
      if (this.bytes <= this.maxBytes) break
      if (!entry.refs && entry.settled) { this.entries.delete(entry.key); this.bytes -= entry.bytes }
    }
  }
}

export const waveforms = new WaveformCache()
