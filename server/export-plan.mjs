const endOf = c => c.start + c.out - c.in
const near = (a, b, tolerance = 0.00001) => Math.abs(a - b) < tolerance
const number = value => Number(value.toFixed(9)).toString()

export function prepareTimeline(project, mutedTracks = []) {
  const end = Math.max(0, ...project.clips.map(endOf))
  const marked = project.exportStart !== undefined && project.exportEnd !== undefined
  const from = marked ? Math.min(end, project.exportStart) : 0
  const to = marked ? Math.min(end, project.exportEnd) : end
  if (to <= from) throw new Error('Add clips or move the export markers to a nonempty range.')
  const clips = project.clips.flatMap(c => {
    const start = Math.max(from, c.start), stop = Math.min(to, endOf(c))
    return !mutedTracks.includes(c.trackId) && stop > start
      ? [{ ...c, start: start - from, in: c.in + start - c.start, out: c.in + stop - c.start }] : []
  })
  return { ...project, clips, duration: to - from }
}

// Deliberately conservative: only whole, matching constant-frame-rate streams.
// Arbitrary cuts always render, so GOP boundaries cannot move an edit.
export function copyPlan(timeline, media) {
  const videos = timeline.clips.filter(c => c.trackId.startsWith('V'))
  const audios = timeline.clips.filter(c => c.trackId.startsWith('A'))
  if (videos.length !== 1 || audios.length > 1) return null
  const c = videos[0], source = media.get(c.assetId)
  const v = source.info.streams.find(s => s.codec_type === 'video')
  const a = source.info.streams.find(s => s.codec_type === 'audio')
  const rate = text => { const [n, d = 1] = String(text).split('/').map(Number); return n / d }
  if (source.asset.kind !== 'video' || !v || v.codec_name !== 'h264' || v.width !== timeline.width || v.height !== timeline.height ||
      !near(rate(v.avg_frame_rate), timeline.frameRate) || !near(rate(v.r_frame_rate), timeline.frameRate) ||
      v.sample_aspect_ratio && !['1:1', '0:1'].includes(v.sample_aspect_ratio) ||
      v.tags?.rotate && Number(v.tags.rotate) !== 0 || v.side_data_list?.some(s => s.rotation) ||
      !near(c.start, 0) || !near(c.in, 0) || !near(c.out, timeline.duration) || !near(c.out, source.asset.duration) ||
      !near(Number(v.duration), timeline.duration, 0.001) || Number(v.start_time || 0) !== 0) return null
  if (audios.length && (!a || a.codec_name !== 'aac' || audios[0].assetId !== c.assetId || !near(audios[0].start, 0) || !near(audios[0].in, 0) || !near(audios[0].out, c.out))) return null
  return ['-protocol_whitelist', 'file,pipe', '-i', source.path, '-map', '0:v:0', ...(audios.length ? ['-map', '0:a:0'] : ['-an']), '-c', 'copy', '-t', number(timeline.duration)]
}

export function renderPlan(timeline, media) {
  const { width, height, frameRate: fps, duration } = timeline
  const args = [], filters = [], audio = []
  let input = 0, layer = 'base'
  const videoClips = timeline.clips.filter(c => c.trackId.startsWith('V')).sort((a, b) => a.trackId.localeCompare(b.trackId) || a.start - b.start)
  const chronological = [...videoClips].sort((a, b) => a.start - b.start)
  const cutsOnly = chronological.length > 0 && chronological.every((c, index) => media.get(c.assetId).asset.kind === 'video' && (!index || c.start >= endOf(chronological[index - 1])))
  const segments = [], frame = time => Math.ceil(time * fps - 0.0001)
  const pixelFormat = width % 2 || height % 2 ? 'yuv444p' : 'yuv420p'
  let cursor = 0
  function gap(frames) {
    if (frames <= 0) return
    const label = `gap${segments.length}`
    filters.push(`color=c=black:s=${width}x${height}:r=${fps},format=${pixelFormat},trim=end_frame=${frames},setpts=PTS-STARTPTS[${label}]`)
    segments.push(`[${label}]`)
  }
  // Cuts use concatenated segments instead of compositing every layer on every
  // frame. Keep frames in YUV; reserve RGBA for timelines needing transparency.
  if (!cutsOnly) filters.push(`color=c=black:s=${width}x${height}:r=${fps},trim=end_frame=${frame(duration)},format=rgba[base]`)
  for (const c of [...(cutsOnly ? chronological : videoClips), ...timeline.clips.filter(c => c.trackId.startsWith('A'))]) {
    const source = media.get(c.assetId), image = source.asset.kind === 'image', video = c.trackId.startsWith('V')
    if (video && frame(endOf(c)) <= frame(c.start)) continue
    const stream = source.info.streams.find(s => s.codec_type === (video ? 'video' : 'audio'))
    if (!stream) throw new Error(`${source.asset.name} has no ${video ? 'video' : 'audio'} stream for ${c.trackId}.`)
    const length = c.out - c.in, index = input++
    args.push('-threads', '2', '-protocol_whitelist', 'file,pipe')
    if (!image) args.push('-ss', number(c.in), '-t', number(length))
    args.push('-i', source.path)
    if (video) {
      // Stills freeze the first decoded frame, including animated images.
      const timing = image ? `trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${number(length)},trim=duration=${number(length)}` : `setpts=PTS-STARTPTS,trim=duration=${number(length)}`
      // Fit display aspect (including anamorphic video), keeping transparent margins.
      const fit = `scale=w='max(1,round(if(gt(dar,${width}/${height}),${width},${height}*dar)))':h='max(1,round(if(gt(dar,${width}/${height}),${width}/dar,${height})))',setsar=1`
      if (cutsOnly) {
        const first = frame(c.start), last = frame(endOf(c))
        gap(first - cursor)
        const label = `cut${index}`
        filters.push(`[${index}:v:0]${timing},${fit},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=${pixelFormat},fps=${fps}:start_time=0,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${last - first},setpts=PTS-STARTPTS[${label}]`)
        segments.push(`[${label}]`); cursor = last
        continue
      }
      const first = frame(c.start), last = frame(endOf(c))
      // Put every layer on the sequence's frame grid. Keep one extra cloned
      // frame past its visible window so framesync cannot expose the background
      // early at EOF when source and sequence frame rates differ.
      filters.push(`[${index}:v:0]${timing},${fit},format=rgba,tpad=stop_mode=clone:stop_duration=1,fps=${fps}:start_time=0,trim=end_frame=${last - first + 1},settb=1/${fps},setpts=PTS-STARTPTS+${first}[v${index}]`)
      const next = `layer${index}`
      filters.push(`[${layer}][v${index}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:repeatlast=0:format=auto:enable='gte(t*${fps},${first}-0.0001)*lt(t*${fps},${last}-0.0001)'[${next}]`)
      layer = next
    } else {
      filters.push(`[${index}:a:0]atrim=duration=${number(length)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${Math.round(c.start * 48000)}S:all=1[a${index}]`)
      audio.push(`[a${index}]`)
    }
  }
  if (cutsOnly) {
    gap(frame(duration) - cursor)
    filters.push(`${segments.join('')}concat=n=${segments.length}:v=1:a=0,trim=duration=${number(duration)},setsar=1[vout]`)
  } else filters.push(`[${layer}]trim=duration=${number(duration)},setsar=1[vout]`)
  if (audio.length) {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${number(duration)}[silence]`)
    filters.push(`[silence]${audio.join('')}amix=inputs=${audio.length + 1}:duration=first:normalize=0,atrim=duration=${number(duration)}[aout]`)
  }
  return { args, graph: filters.join(';\n'), output: ['-map', '[vout]', ...(audio.length ? ['-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : ['-an']), '-r', String(fps), '-t', number(duration)] }
}
