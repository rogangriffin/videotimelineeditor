import { AudioSampleSink, BlobSource, Input } from 'mediabunny'
import { MEDIA_FORMATS } from './mediaFormats'
import { PeakBuilder } from './waveform'
import { readWaveform, writeWaveform } from './waveformStore'

// A structural type keeps the app's DOM and worker TypeScript libraries separate.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ key: string; file: File }>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = async ({ data: { key, file } }) => {
  let input: Input | undefined
  try {
    let waveform = await readWaveform(key)
    if (!waveform) {
      input = new Input({ source: new BlobSource(file), formats: MEDIA_FORMATS })
      const track = await input.getPrimaryAudioTrack()
      if (!track || !await track.canDecode()) throw new Error('This browser cannot decode the audio waveform.')
      const builder = new PeakBuilder()
      let scratch = new Float32Array(0)
      for await (const sample of new AudioSampleSink(track).samples()) {
        try {
          if (scratch.length < sample.numberOfFrames) scratch = new Float32Array(sample.numberOfFrames)
          const channel = scratch.subarray(0, sample.numberOfFrames)
          // Union channel envelopes rather than mixing samples: opposite phases cannot cancel peaks.
          for (let planeIndex = 0; planeIndex < sample.numberOfChannels; planeIndex++) {
            sample.copyTo(channel, { planeIndex, format: 'f32-planar' })
            builder.add(channel, sample.sampleRate, sample.timestamp)
          }
        } finally { sample.close() }
      }
      waveform = builder.finish()
      await writeWaveform(key, waveform)
    }
    scope.postMessage({ key, waveform }, waveform.levels.map(level => level.buffer as ArrayBuffer))
  } catch (error) {
    scope.postMessage({ key, error: error instanceof Error ? error.message : 'Waveform analysis failed.' })
  } finally { input?.dispose() }
}
