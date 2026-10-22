// Envelope precision: ~2 ms, finer than a device pixel at the editor's maximum zoom.
export const PEAKS_PER_SECOND = 512
export const WAVEFORM_VERSION = 1
export interface Waveform { rate: number; levels: Int16Array[] }
const SCALE = 32767
const BLOCK_BUCKETS = 8192

export function waveformKey(source: { sourceId?: string; name: string; size: number; lastModified: number }) {
  return JSON.stringify([WAVEFORM_VERSION, source.sourceId ?? source.name, source.size, source.lastModified, 'primary-audio'])
}

// Store just the envelope while decoding; PCM chunks are never retained.
export class PeakBuilder {
  private blocks = new Map<number, Int16Array>()
  private length = 0

  add(samples: Float32Array, sampleRate: number, timestamp: number) {
    let previousBlock = -1
    let block: Int16Array | undefined
    for (let i = 0; i < samples.length;) {
      const bucket = Math.floor((timestamp + i / sampleRate) * PEAKS_PER_SECOND + 1e-7)
      const end = Math.min(samples.length, Math.max(i + 1, Math.ceil(((bucket + 1) / PEAKS_PER_SECOND - timestamp) * sampleRate - 1e-7)))
      if (bucket < 0) { i = end; continue }
      const blockIndex = Math.floor(bucket / BLOCK_BUCKETS)
      if (blockIndex !== previousBlock) {
        block = this.blocks.get(blockIndex)
        if (!block) {
          block = new Int16Array(BLOCK_BUCKETS * 2)
          for (let j = 0; j < block.length; j += 2) { block[j] = SCALE; block[j + 1] = -SCALE }
          this.blocks.set(blockIndex, block)
        }
        previousBlock = blockIndex
      }
      let min = 1, max = -1
      for (; i < end; i++) {
        const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0
        min = Math.min(min, value); max = Math.max(max, value)
      }
      const index = (bucket % BLOCK_BUCKETS) * 2
      block![index] = Math.min(block![index], Math.floor(min * SCALE))
      block![index + 1] = Math.max(block![index + 1], Math.ceil(max * SCALE))
      this.length = Math.max(this.length, bucket + 1)
    }
  }

  finish(): Waveform {
    const base = new Int16Array(this.length * 2)
    for (const [index, block] of this.blocks) {
      const start = index * BLOCK_BUCKETS * 2
      for (let i = 0; i < Math.min(block.length, base.length - start); i += 2) {
        if (block[i] > block[i + 1]) continue // Unfilled buckets are silence, including stream gaps.
        base[start + i] = block[i]; base[start + i + 1] = block[i + 1]
      }
    }
    this.blocks.clear()
    const levels = [base]
    let previous = base
    while (previous.length > 2) {
      const next = new Int16Array(Math.ceil(previous.length / 4) * 2)
      for (let i = 0; i < next.length; i += 2) {
        const offset = i * 2
        next[i] = Math.min(previous[offset], previous[offset + 2] ?? previous[offset])
        next[i + 1] = Math.max(previous[offset + 1], previous[offset + 3] ?? previous[offset + 1])
      }
      levels.push(next); previous = next
    }
    return { rate: PEAKS_PER_SECOND, levels }
  }
}

export function waveformBytes(waveform: Waveform) {
  return waveform.levels.reduce((total, level) => total + level.byteLength, 0)
}

// Select a level once per paint, then visit only a few buckets per device pixel.
export function waveformLevel(waveform: Waveform, pixelsPerSecond: number) {
  const index = Math.min(waveform.levels.length - 1, Math.max(0, Math.floor(Math.log2(waveform.rate / pixelsPerSecond))))
  return { peaks: waveform.levels[index], rate: waveform.rate / 2 ** index }
}

export function peakRange(peaks: Int16Array, rate: number, from: number, to: number): [number, number] {
  const start = Math.max(0, Math.floor(from * rate))
  const end = Math.min(peaks.length / 2, Math.ceil(to * rate - 1e-7))
  if (start >= end) return [0, 0]
  let min = SCALE, max = -SCALE
  for (let i = start; i < end; i++) { min = Math.min(min, peaks[i * 2]); max = Math.max(max, peaks[i * 2 + 1]) }
  return [min / SCALE, max / SCALE]
}
