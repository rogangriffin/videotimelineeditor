import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  AudioLines, Check, ChevronDown, Clapperboard, Copy, Download, Eye, EyeOff, Save, Film,
  FolderOpen, GripVertical, Info, Link2, Magnet, Maximize2, MoreHorizontal,
  Music2, Pause, Play, Plus, Redo2, Scissors, Search, Settings2, SkipBack,
  SkipForward, SlidersHorizontal, Trash2, Undo2, Upload, Volume2, VolumeX,
  X, ZoomIn, ZoomOut,
} from 'lucide-react'
import {
  type Asset, type Clip, type Project, type TrackId, TRACKS, activeClip, durationOf,
  emptyProject, endOf, exportRange, freeStart, matchingFile, projectEnd, serializeProject,
  shortTime, snapTime, timecode, uid, IMAGE_EXTENSIONS, fitRect, resizeImageClip,
} from './model'
import { ExportDialog } from './ExportDialog'
import { registerSource, uploadSource, readProject, writeProject } from './storage'
import { DiskBrowser, ProjectBrowser } from './StorageDialogs'
import { ClientMedia } from './clientMedia'
import { PlaybackTransport } from './playback'

type Tool = 'select' | 'razor'
type DragMode = 'move' | 'trim-start' | 'trim-end'
type DragState = { mode: DragMode; clip: Clip; linked?: Clip; x: number; current: Clip[]; moved: boolean }

function StillImage({ url, name, className }: { url: string; name: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    void import('./media').then(({ loadStillImage }) => loadStillImage(url)).then(image => {
      const canvas = ref.current
      if (!cancelled && canvas) {
        canvas.width = image.width
        canvas.height = image.height
        canvas.getContext('2d')!.drawImage(image, 0, 0)
      }
      image.close()
    }).catch(() => { /* Offline media is handled by the relink workflow. */ })
    return () => { cancelled = true }
  }, [url])
  return <canvas ref={ref} role="img" aria-label={name} className={className} />
}

function SequenceFrame({ width, height, children }: { width: number; height: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  const rect = fitRect(width, height, size.width, size.height)
  return <div ref={ref} className="sequence-frame-container"><div className="sequence-frame" style={{ width: rect.w, height: rect.h }}>{children}</div></div>
}

function MediaPlayer({ id, asset, time, playing, muted, className, audioOnly = false, onElement, onError }: {
  id: string; asset: Asset; time: number; playing: boolean; muted: boolean; className?: string; audioOnly?: boolean
  onElement: (id: string, element: HTMLMediaElement | null) => void
  onError: (message: string) => void
}) {
  const ref = useRef<HTMLMediaElement>(null)
  const targetTime = useRef(time)
  targetTime.current = Math.max(0, Math.min(asset.duration - 0.01, time))
  useEffect(() => {
    const el = ref.current
    if (!el) return
    onElement(id, el)
    const seekOnLoad = () => { if (Math.abs(el.currentTime - targetTime.current) > 0.025) el.currentTime = targetTime.current }
    const failed = () => onError(`Cannot play ${asset.name}. ${el.error?.message || 'The browser could not decode this media.'}`)
    el.addEventListener('loadedmetadata', seekOnLoad)
    el.addEventListener('error', failed)
    return () => {
      el.pause()
      el.removeEventListener('loadedmetadata', seekOnLoad)
      el.removeEventListener('error', failed)
      onElement(id, null)
    }
  }, [id, asset.url, asset.name, onElement, onError])
  const pausedTime = playing ? undefined : time
  useEffect(() => {
    const el = ref.current
    if (!el || !asset.url || pausedTime === undefined) return
    const target = targetTime.current
    if (el.readyState >= 1 && Number.isFinite(target) && Math.abs(el.currentTime - target) > 0.025) {
      try { el.currentTime = target } catch { /* Seek waits for metadata. */ }
    }
    if (!el.paused) el.pause()
  }, [asset.url, asset.duration, pausedTime])
  if (!asset.url) return null
  if (asset.kind === 'image') return <StillImage url={asset.url} name={asset.name} className={className} />
  return asset.kind === 'video' && !audioOnly
    ? <video ref={ref as React.RefObject<HTMLVideoElement>} src={asset.url} muted={muted} playsInline preload="auto" className={className} />
    : <audio ref={ref as React.RefObject<HTMLAudioElement>} src={asset.url} muted={muted} preload="auto" className={className} />
}

function HeaderButton({ children, onClick, title, active = false, disabled = false, className = '' }: {
  children: React.ReactNode; onClick?: () => void; title?: string; active?: boolean; disabled?: boolean; className?: string
}) {
  return <button className={`header-button ${active ? 'active' : ''} ${className}`} onClick={onClick} title={title} disabled={disabled}>{children}</button>
}

export default function App() {
  const [project, setProject] = useState<Project>(emptyProject)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [tool, setTool] = useState<Tool>('select')
  const [snapping, setSnapping] = useState(true)
  const [zoom, setZoom] = useState(80)
  const [mediaSearch, setMediaSearch] = useState('')
  const [sidebarTab, setSidebarTab] = useState<'project' | 'effects'>('project')
  const [sourceTime, setSourceTime] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [dragDraft, setDragDraft] = useState<Clip[] | null>(null)
  const [dropHover, setDropHover] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [exportsOpen, setExportsOpen] = useState(false)
  const [relinkOpen, setRelinkOpen] = useState(false)
  const [diskOpen, setDiskOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [savedSnapshot, setSavedSnapshot] = useState(() => serializeProject(emptyProject()))
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(true)
  const [loadingProject, setLoadingProject] = useState(false)
  const [initialMedia] = useState(() => new ClientMedia())
  const clientMedia = useRef(initialMedia)
  const retiredMedia = useRef<ClientMedia[]>([])
  const disposeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const operation = useRef(false)
  const dirty = useMemo(() => serializeProject(project) !== savedSnapshot, [project, savedSnapshot])
  const [mutedTracks, setMutedTracks] = useState<TrackId[]>([])
  const [lockedTracks, setLockedTracks] = useState<TrackId[]>([])
  const [showProperties, setShowProperties] = useState(false)
  const [timelineMenu, setTimelineMenu] = useState<{ x: number; y: number; time: number } | null>(null)
  const timelineMenuRef = useRef<HTMLDivElement>(null)
  const relinkInput = useRef<HTMLInputElement>(null)
  const relinkTarget = useRef<string | null>(null)
  const internalDrag = useRef(false)
  const sequenceTouched = useRef(false)
  const dragRef = useRef<DragState | null>(null)
  const timelineScroll = useRef<HTMLDivElement>(null)
  const undoStack = useRef<Project[]>([])
  const redoStack = useRef<Project[]>([])
  const playheadRef = useRef(0)
  const players = useRef(new Map<string, HTMLMediaElement>())
  const transport = useRef<PlaybackTransport | null>(null)
  const timelinePlayhead = useRef<HTMLDivElement>(null)
  const playbackZoom = useRef(zoom)
  playbackZoom.current = zoom
  const [waitingForPlayback, setWaitingForPlayback] = useState(false)
  const registerPlayer = useCallback((id: string, element: HTMLMediaElement | null) => {
    if (element) players.current.set(id, element)
    else players.current.delete(id)
  }, [])

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(current => current === message ? null : current), 4000)
  }, [])
  const playbackError = useCallback((message: string) => { setPlaying(false); notify(message) }, [notify])

  const commit = useCallback((change: (previous: Project) => Project) => {
    setProject(previous => {
      const next = change(previous)
      if (next !== previous) {
        undoStack.current.push(previous)
        if (undoStack.current.length > 80) undoStack.current.shift()
        redoStack.current = []
      }
      return next
    })
  }, [])

  const undo = useCallback(() => {
    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(project)
    setProject(previous)
    setSelectedClipId(null)
  }, [project])
  const redo = useCallback(() => {
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(project)
    setProject(next)
    setSelectedClipId(null)
  }, [project])

  const duration = useMemo(() => projectEnd(project), [project])
  const assetById = useMemo(() => new Map(project.assets.map(asset => [asset.id, asset])), [project.assets])
  const boundaries = useMemo(() => [...new Set(project.clips.flatMap(c => [c.start, endOf(c)]))].sort((a, b) => a - b), [project.clips])
  const { start: exportStart, end: exportEnd } = exportRange(project)
  const rangeStyle = exportStart !== undefined && exportEnd !== undefined && exportEnd > exportStart
    ? { left: exportStart * zoom, width: (exportEnd - exportStart) * zoom } : undefined
  const selectedAsset = project.assets.find(a => a.id === selectedAssetId)
  const selectedClip = project.clips.find(c => c.id === selectedClipId)
  const unresolved = project.assets.filter(a => !a.url)
  const shownClips = dragDraft ?? project.clips
  const timelineWidth = Math.max(1200, (Math.max(duration, 30) + 12) * zoom)
  const tickStep = zoom >= 100 ? 2 : zoom >= 55 ? 5 : 10
  const ticks = Array.from({ length: Math.ceil(timelineWidth / (zoom * tickStep)) + 1 }, (_, i) => i * tickStep)

  useEffect(() => { if (!playing) playheadRef.current = playhead }, [playhead, playing])
  useEffect(() => {
    if (!timelineMenu) return
    timelineMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const dismiss = () => setTimelineMenu(null)
    const outside = (event: PointerEvent) => {
      if (!timelineMenuRef.current?.contains(event.target as Node)) dismiss()
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [timelineMenu])
  useEffect(() => {
    if (!playing) return
    const clock = new PlaybackTransport(playbackError)
    transport.current = clock
    let frame = 0
    let lastPaint = -Infinity
    let lastWaiting = false
    const advance = (now: number) => {
      const current = playheadRef.current
      const active = TRACKS.filter(track => !mutedTracks.includes(track)).map(track => activeClip(project.clips, track, current)).filter((clip): clip is Clip => !!clip)
      if (active.some(clip => !assetById.get(clip.assetId)?.file)) {
        playbackError('Load or reconnect the missing media before playing.'); return
      }
      const boundary = boundaries.find(t => t > current + 0.000001) ?? duration
      const result = clock.step(now, current, boundary, active.filter(clip => assetById.get(clip.assetId)?.kind !== 'image').map(clip => ({
        id: clip.id, start: clip.start, in: clip.in, audio: clip.trackId.startsWith('A'), element: players.current.get(clip.id),
      })))
      playheadRef.current = result.time
      if (timelinePlayhead.current) timelinePlayhead.current.style.left = String(result.time * playbackZoom.current) + 'px'
      if (result.waiting !== lastWaiting) { setWaitingForPlayback(result.waiting); lastWaiting = result.waiting }
      if (result.time >= duration) { setPlayhead(duration); setPlaying(false); return }
      // Keep decoder playback independent of the editor's React render rate.
      // Cuts update immediately; ordinary time labels and UI update at 20 Hz.
      if (now - lastPaint >= 50 || (result.time === boundary && result.time !== current)) {
        setPlayhead(result.time); lastPaint = now
      }
      frame = requestAnimationFrame(advance)
    }
    frame = requestAnimationFrame(advance)
    return () => {
      cancelAnimationFrame(frame); clock.dispose(); transport.current = null; setWaitingForPlayback(false)
    }
  }, [playing, duration, project.clips, assetById, boundaries, mutedTracks, playbackError])

  const seek = (time: number) => {
    const next = Math.max(0, Math.min(Math.max(duration, 0), time))
    setPlayhead(next)
    playheadRef.current = next
    transport.current?.seek()
  }

  const importFiles = async (files: FileList | File[]) => {
    if (operation.current || starting) return
    operation.current = true
    const list = Array.from(files).filter(file => IMAGE_EXTENSIONS.test(file.name) || file.type.startsWith('video/') || file.type.startsWith('audio/') || /\.(mp4|mov|webm|mkv|m4v|mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name))
    if (!list.length) { operation.current = false; notify('Choose video, audio, or image files to import.'); return }
    setBusy(`Importing 0 of ${list.length}`)
    const additions: Asset[] = []
    const errors: string[] = []
    for (let i = 0; i < list.length; i++) {
      setBusy(`Importing ${i + 1} of ${list.length}`)
      try {
        if (project.assets.some(a => matchingFile(a, list[i])) || additions.some(a => matchingFile(a, list[i]))) continue
        const { inspectSource } = await import('./media')
        additions.push(await inspectSource(await uploadSource(list[i]), clientMedia.current, setBusy, list[i]))
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
    }
    if (additions.length) {
      commit(previous => ({ ...previous, assets: [...previous.assets, ...additions] }))
      setSelectedAssetId(additions[0].id)
      setSourceTime(0)
    }
    setBusy(null)
    operation.current = false
    notify(errors.length ? `${additions.length} imported. ${errors[0]}` : `${additions.length} media file${additions.length === 1 ? '' : 's'} imported.`)
  }

  const importPaths = async (paths: string[]) => {
    if (operation.current || starting) return
    operation.current = true
    setBusy('Reading media from disk')
    const additions: Asset[] = []
    const errors: string[] = []
    try {
      const { inspectSource } = await import('./media')
      if (relinkTarget.current) {
        const original = project.assets.find(a => a.id === relinkTarget.current)
        if (!original || paths.length !== 1) throw new Error('Select one original source file.')
        const source = await registerSource(paths[0])
        if (source.size !== original.size || source.name !== original.name) throw new Error('Choose the original file with the same name and size.')
        const scanned = await inspectSource(source, clientMedia.current, setBusy)
        if (Math.abs(scanned.duration - original.duration) > 0.01) throw new Error('This file has a different duration from the original.')
        commit(p => ({ ...p, assets: p.assets.map(a => a.id === original.id ? { ...scanned, id: a.id } : a) }))
        relinkTarget.current = null
        if (unresolved.length === 1) setRelinkOpen(false)
        notify('Source reconnected. Save to remember its new location.')
        return
      }
      for (const path of paths) {
        try {
          const source = await registerSource(path)
          if (!project.assets.some(a => a.sourcePath === source.sourcePath && a.url)) additions.push(await inspectSource(source, clientMedia.current, setBusy))
        } catch (e) { errors.push((e as Error).message) }
      }
      if (additions.length) {
        commit(p => ({ ...p, assets: [...p.assets, ...additions] }))
        setSelectedAssetId(additions[0].id); setSourceTime(0)
      }
      notify(`${additions.length} media files imported.${errors.length ? ` ${errors[0]}` : ''}`)
    } finally { setBusy(null); operation.current = false }
    if (errors.length) throw new Error(errors[0])
  }

  const addAssetToTimeline = (assetId: string, targetTrack?: TrackId, desiredTime?: number) => {
    const asset = project.assets.find(a => a.id === assetId)
    if (!asset) return
    const primaryTrack: TrackId = asset.kind === 'audio' ? (targetTrack?.startsWith('A') ? targetTrack : 'A1') : (targetTrack?.startsWith('A') && asset.hasAudio ? targetTrack : targetTrack?.startsWith('V') ? targetTrack : 'V1')
    if (lockedTracks.includes(primaryTrack)) { notify(`${primaryTrack} is locked.`); return }
    const placement = desiredTime ?? freeStart(project.clips, primaryTrack, duration, asset.duration)
    const audioTrack: TrackId | undefined = asset.kind === 'video' && asset.hasAudio && primaryTrack.startsWith('V') ? !lockedTracks.includes('A1') ? 'A1' : !lockedTracks.includes('A2') ? 'A2' : undefined : undefined
    let start = placement
    for (let i = 0; i < 10; i++) {
      const next = Math.max(freeStart(project.clips, primaryTrack, start, asset.duration), audioTrack ? freeStart(project.clips, audioTrack, start, asset.duration) : start)
      if (Math.abs(next - start) < 0.001) break
      start = next
    }
    const main: Clip = { id: uid(), assetId, trackId: primaryTrack, start, in: 0, out: asset.duration }
    const additions = [main]
    if (audioTrack) {
      const partner: Clip = { id: uid(), assetId, trackId: audioTrack, start, in: 0, out: asset.duration, linkedId: main.id }
      main.linkedId = partner.id
      additions.push(partner)
    }
    commit(previous => {
      const firstVideo = !sequenceTouched.current && previous.clips.length === 0 && asset.kind === 'video' && asset.width >= 16 && asset.width <= 3840 && asset.height >= 16 && asset.height <= 2160
      const nearestRate = [24, 25, 30, 60].reduce((best, rate) => Math.abs(rate - (asset.frameRate ?? 30)) < Math.abs(best - (asset.frameRate ?? 30)) ? rate : best, 30)
      return {
        ...previous,
        ...(firstVideo ? { width: Math.round(asset.width / 2) * 2, height: Math.round(asset.height / 2) * 2, frameRate: Math.abs(nearestRate - (asset.frameRate ?? 30)) < 0.1 ? nearestRate : 30 } : {}),
        clips: [...previous.clips, ...additions],
      }
    })
    setSelectedClipId(main.id)
    seek(start)
  }

  const deleteSelected = () => {
    if (!selectedClip) return
    if (lockedTracks.includes(selectedClip.trackId)) return
    const ids = [selectedClip.id, selectedClip.linkedId].filter(Boolean)
    commit(previous => ({ ...previous, clips: previous.clips.filter(c => !ids.includes(c.id)) }))
    setSelectedClipId(null)
  }

  const splitAt = (id: string, at: number) => {
    const clip = project.clips.find(c => c.id === id)
    if (!clip || lockedTracks.includes(clip.trackId)) return
    const frame = 1 / project.frameRate
    if (at <= clip.start + frame || at >= endOf(clip) - frame) return
    const linked = project.clips.find(c => c.id === clip.linkedId && !lockedTracks.includes(c.trackId))
    const split = (original: Clip): [Clip, Clip] => {
      const cut = original.in + at - original.start
      return [{ ...original, out: cut }, { ...original, id: uid(), start: at, in: cut }]
    }
    const [left, right] = split(clip)
    const replacements = [left, right]
    if (linked && !lockedTracks.includes(linked.trackId) && at > linked.start + frame && at < endOf(linked) - frame) {
      const [leftLinked, rightLinked] = split(linked)
      left.linkedId = leftLinked.id
      leftLinked.linkedId = left.id
      right.linkedId = rightLinked.id
      rightLinked.linkedId = right.id
      replacements.push(leftLinked, rightLinked)
    }
    commit(previous => ({ ...previous, clips: [...previous.clips.filter(c => c.id !== clip.id && c.id !== linked?.id), ...replacements] }))
    setSelectedClipId(right.id)
  }

  const snapTargets = (excluded: string[] = []) => [0, playhead, ...project.clips.filter(c => !excluded.includes(c.id)).flatMap(c => [c.start, endOf(c)])]
  const applyDrag = (state: DragState, clientX: number, clientY: number, noSnap: boolean): Clip[] => {
    const delta = (clientX - state.x) / zoom
    const frame = 1 / project.frameRate
    const ids = [state.clip.id, state.linked?.id].filter((x): x is string => !!x)
    const targets = snapTargets(ids)
    let changed = { ...state.clip }
    let linked = state.linked ? { ...state.linked } : undefined
    const asset = project.assets.find(a => a.id === state.clip.assetId)
    if (state.mode === 'move') {
      let targetTrack = state.clip.trackId
      const row = document.elementFromPoint(clientX, clientY)?.closest('[data-track]') as HTMLElement | null
      const hovered = row?.dataset.track as TrackId | undefined
      if (hovered && hovered[0] === state.clip.trackId[0] && !lockedTracks.includes(hovered)) targetTrack = hovered
      let start = Math.max(0, state.clip.start + delta)
      if (snapping && !noSnap) start = snapTime(start, targets, 8 / zoom)
      for (let i = 0; i < 10; i++) {
        const primary = freeStart(project.clips, targetTrack, start, durationOf(state.clip), ids)
        const partner = linked ? freeStart(project.clips, linked.trackId, start + linked.start - state.clip.start, durationOf(linked), ids) - (linked.start - state.clip.start) : start
        const next = Math.max(primary, partner)
        if (Math.abs(next - start) < 0.001) break
        start = next
      }
      changed.start = start
      changed.trackId = targetTrack
      if (linked) linked.start = Math.max(0, linked.start + start - state.clip.start)
    } else if (state.mode === 'trim-start') {
      const previousEnd = Math.max(0, ...project.clips.filter(c => c.trackId === state.clip.trackId && !ids.includes(c.id) && c.start < state.clip.start).map(endOf))
      const earliest = asset?.kind === 'image' ? 0 : state.clip.start - state.clip.in
      let start = Math.max(previousEnd, earliest, Math.min(endOf(state.clip) - frame, state.clip.start + delta))
      if (snapping && !noSnap) start = snapTime(start, targets, 8 / zoom)
      start = Math.max(previousEnd, earliest, Math.min(endOf(state.clip) - frame, start))
      changed.start = start
      changed.in = state.clip.in + start - state.clip.start
      if (asset?.kind === 'image') changed = resizeImageClip(state.clip, 'start', start)
      if (linked) { linked.start = start; linked.in = changed.in }
    } else {
      const nextStart = Math.min(Infinity, ...project.clips.filter(c => c.trackId === state.clip.trackId && !ids.includes(c.id) && c.start >= endOf(state.clip) - 0.001).map(c => c.start))
      const latest = asset?.kind === 'image' ? Infinity : state.clip.start + (asset?.duration ?? state.clip.out) - state.clip.in
      let end = Math.max(state.clip.start + frame, Math.min(nextStart, latest, endOf(state.clip) + delta))
      if (snapping && !noSnap) end = snapTime(end, targets, 8 / zoom)
      end = Math.max(state.clip.start + frame, Math.min(nextStart, latest, end))
      changed.out = state.clip.in + end - state.clip.start
      if (asset?.kind === 'image') changed = resizeImageClip(state.clip, 'end', end)
      if (linked) linked.out = changed.out
    }
    return project.clips.map(c => c.id === changed.id ? changed : linked && c.id === linked.id ? linked : c)
  }

  const beginClipPointer = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip, mode: DragMode) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (lockedTracks.includes(clip.trackId)) return
    if (tool === 'razor' && mode === 'move') {
      const bounds = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
      splitAt(clip.id, (event.clientX - bounds.left) / zoom)
      return
    }
    setSelectedClipId(clip.id)
    const linked = project.clips.find(c => c.id === clip.linkedId)
    dragRef.current = { mode, clip, linked, x: event.clientX, current: project.clips, moved: false }
    const move = (e: PointerEvent) => {
      if (!dragRef.current) return
      if (Math.abs(e.clientX - dragRef.current.x) > 2) dragRef.current.moved = true
      const next = applyDrag(dragRef.current, e.clientX, e.clientY, e.shiftKey)
      dragRef.current.current = next
      setDragDraft(next)
    }
    const up = () => {
      const state = dragRef.current
      dragRef.current = null
      setDragDraft(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (state?.moved) commit(previous => ({ ...previous, clips: state.current }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  function rememberProject(id: string | null) {
    try { if (id) localStorage.setItem('framecut-project', id); else localStorage.removeItem('framecut-project') } catch { /* Server persistence does not depend on browser storage. */ }
  }

  const saveProject = async (asNew = false) => {
    if (operation.current || starting) return
    operation.current = true; setSaving(true)
    const snapshot = serializeProject(project)
    try {
      const saved = await writeProject(asNew ? uid() : projectId ?? uid(), asNew ? 0 : revision, project)
      setProjectId(saved.id); setRevision(saved.revision); setSavedSnapshot(snapshot)
      rememberProject(saved.id)
      notify(`Saved ${saved.project.name} to the server.`)
    } catch (error) { notify((error as Error).message) }
    finally { operation.current = false; setSaving(false) }
  }

  function applyLoaded(loaded: Project, id: string | null, nextRevision: number, media = new ClientMedia()) {
    retiredMedia.current.push(clientMedia.current)
    clientMedia.current = media
    setProject(loaded); setProjectId(id); setRevision(nextRevision); setSavedSnapshot(serializeProject(loaded))
    undoStack.current = []; redoStack.current = []; sequenceTouched.current = !!id
    setSelectedAssetId(null); setSelectedClipId(null); setPlayhead(0); setPlaying(false); setSourceTime(0)
    setMutedTracks([]); setLockedTracks([]); setDragDraft(null); setTimelineMenu(null)
    rememberProject(id)
    setRelinkOpen(loaded.assets.some(a => !a.url))
  }

  // Release the previous project's URLs only after its players have unmounted.
  useEffect(() => { retiredMedia.current.splice(0).forEach(media => media.dispose()) }, [project])
  useEffect(() => {
    clearTimeout(disposeTimer.current)
    // Deferral keeps React's development effect replay from disposing a live session.
    return () => { disposeTimer.current = setTimeout(() => {
      clientMedia.current.dispose()
      retiredMedia.current.splice(0).forEach(media => media.dispose())
    }, 0) }
  }, [])

  const loadProject = async (id: string) => {
    if (operation.current || starting) return false
    if (dirty && !window.confirm('Discard unsaved changes and open another project?')) return false
    operation.current = true; setBusy('Opening project'); setLoadingProject(true); setPlaying(false)
    const media = new ClientMedia()
    try {
      const saved = await readProject(id)
      const loaded = await media.loadProject(saved.project, setBusy)
      applyLoaded(loaded, saved.id, saved.revision, media)
      notify(`Opened ${saved.project.name}.`)
      return true
    } catch (error) { media.dispose(); notify((error as Error).message); return false }
    finally { operation.current = false; setBusy(null); setLoadingProject(false) }
  }

  useEffect(() => {
    let cancelled = false
    let adopted = false
    const media = new ClientMedia()
    let lastId: string | null = null
    try { lastId = localStorage.getItem('framecut-project') } catch { /* Optional recent-project hint. */ }
    if (!lastId) { media.dispose(); setStarting(false); return }
    readProject(lastId).then(async saved => {
      const loaded = await media.loadProject(saved.project, message => { if (!cancelled) setBusy(message) })
      if (!cancelled) { applyLoaded(loaded, saved.id, saved.revision, media); adopted = true }
    }).catch(error => { if (!cancelled) notify(`Could not reopen the last project. ${error.message}`) })
      .finally(() => { if (!adopted) media.dispose(); if (!cancelled) { setStarting(false); setBusy(null) } })
    return () => { cancelled = true; if (!adopted) media.dispose() }
  }, [])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const relinkFiles = async (files: FileList | File[]) => {
    if (operation.current || starting) return
    operation.current = true; setBusy('Reconnecting media')
    const list = Array.from(files)
    let count = 0
    const replacements = new Map<string, Asset>()
    for (const asset of project.assets.filter(a => !a.url)) {
      const file = list.find(f => matchingFile(asset, f) && (!relinkTarget.current || relinkTarget.current === asset.id))
      if (!file) continue
      try {
        const { inspectSource } = await import('./media')
        const scanned = await inspectSource(await uploadSource(file), clientMedia.current, setBusy, file)
        if (Math.abs(scanned.duration - asset.duration) > 0.01) continue
        replacements.set(asset.id, { ...scanned, id: asset.id })
        count++
      } catch { /* Leave it unresolved so the user can choose another file. */ }
    }
    relinkTarget.current = null
    operation.current = false; setBusy(null)
    if (count) commit(previous => ({ ...previous, assets: previous.assets.map(a => replacements.get(a.id) ?? a) }))
    if (count === unresolved.length) setRelinkOpen(false)
    notify(count ? `Relinked ${count} media file${count === 1 ? '' : 's'}.` : 'No files matched by name and size.')
  }

  const retryMedia = async () => {
    if (operation.current) return
    operation.current = true; setLoadingProject(true); setPlaying(false)
    try {
      const loaded = await clientMedia.current.loadProject({ ...project, assets: project.assets.map(a => ({
        ...a, url: a.url || (a.sourceId ? `/api/media/${a.sourceId}` : undefined),
      })) }, setBusy)
      commit(() => loaded)
      setRelinkOpen(loaded.assets.some(a => !a.url))
      notify(loaded.assets.some(a => !a.url) ? 'Some media could not be loaded. Check the source details.' : 'Media loaded into the browser.')
    } catch (error) { notify((error as Error).message) }
    finally { operation.current = false; setLoadingProject(false); setBusy(null) }
  }

  const exportProject = () => { setPlaying(false); setExportsOpen(true) }

  const updateSequence = (settings: Partial<Pick<Project, 'width' | 'height' | 'frameRate'>>) => {
    sequenceTouched.current = true
    setProject(previous => ({ ...previous, ...settings }))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (timelineMenu) return
      const target = event.target as HTMLElement
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!projectsOpen && !diskOpen) void saveProject(); return }
      if (starting || projectsOpen || diskOpen || relinkOpen || showProperties || busy || exportsOpen || target.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo() }
        return
      }
      if (event.code === 'Space') { event.preventDefault(); setPlaying(v => !v) }
      if (event.key.toLowerCase() === 'c') setTool('razor')
      if (event.key.toLowerCase() === 'v') setTool('select')
      if (event.key.toLowerCase() === 's' && !event.altKey && !event.repeat && selectedClip) {
        event.preventDefault()
        splitAt(selectedClip.id, playhead)
      }
      if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected()
      if (event.key === 'ArrowLeft') seek(playhead - 1 / project.frameRate)
      if (event.key === 'ArrowRight') seek(playhead + 1 / project.frameRate)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onGlobalDrop = (event: DragEvent) => {
    event.preventDefault()
    internalDrag.current = false
    setDropHover(false)
    if (!event.dataTransfer.types.includes('application/x-framecut-asset') && event.dataTransfer.files.length) void importFiles(event.dataTransfer.files)
  }
  const onTrackDrop = (event: DragEvent, trackId: TrackId) => {
    event.preventDefault()
    event.stopPropagation()
    internalDrag.current = false
    setDropHover(false)
    const assetId = event.dataTransfer.getData('application/x-framecut-asset')
    if (assetId) {
      const rect = event.currentTarget.getBoundingClientRect()
      addAssetToTimeline(assetId, trackId, Math.max(0, (event.clientX - rect.left) / zoom))
    } else if (event.dataTransfer.files.length) void importFiles(event.dataTransfer.files)
  }

  const previewClips = TRACKS.filter(track => !mutedTracks.includes(track)).flatMap(track => {
    const current = activeClip(project.clips, track, playhead)
    const upcoming = project.clips.filter(c => c.trackId === track && c.start > playhead && c.start <= playhead + 2).sort((a, b) => a.start - b.start)[0]
    return [current, upcoming].filter((clip): clip is Clip => !!clip).map(clip => ({ clip, active: clip.id === current?.id }))
  })
  const activeVideos = previewClips.filter(({ clip, active }) => active && clip.trackId.startsWith('V'))
  const filteredAssets = project.assets.filter(a => a.name.toLowerCase().includes(mediaSearch.toLowerCase()))

  return <div className="app-shell" onDragOver={event => {
    const externalFiles = event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes('application/x-framecut-asset') && !internalDrag.current
    if (externalFiles) event.preventDefault()
    setDropHover(externalFiles)
  }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropHover(false) }} onDrop={onGlobalDrop}>
    <input ref={relinkInput} type="file" accept="video/*,audio/*,.mkv,.mov,.flac,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif" multiple hidden onChange={e => { if (e.target.files) void relinkFiles(e.target.files); e.target.value = '' }} />

    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Clapperboard size={19} strokeWidth={2.5} /></div><span>FRAMECUT</span><span className="brand-sub">STUDIO</span></div>
      <div className="top-divider" />
      <div className="project-title"><input aria-label="Project name" value={project.name} onChange={e => setProject(p => ({ ...p, name: e.target.value }))} /><ChevronDown size={14} /></div>
      <span className="autosave-note"><span className="local-dot" /> {starting ? 'Opening…' : saving ? 'Saving…' : dirty ? 'Unsaved changes' : projectId ? 'Saved on server' : 'New project'}</span>
      <div className="top-spacer" />
      <HeaderButton title="Import media from disk" disabled={!!busy || saving || starting} onClick={() => { relinkTarget.current = null; setDiskOpen(true) }}><Plus size={16} /> Import</HeaderButton>
      <HeaderButton title="Open saved project" disabled={!!busy || saving || starting || !!exportsOpen} onClick={() => setProjectsOpen(true)}><FolderOpen size={16} /> Open</HeaderButton>
      <HeaderButton title="Save project (Ctrl+S)" disabled={!!busy || saving || starting} onClick={() => void saveProject()}><Save size={16} /> Save</HeaderButton>
      <HeaderButton title="Save as a new project" disabled={!!busy || saving || starting} onClick={() => void saveProject(true)}><Copy size={16} /> Save as new</HeaderButton>
      <button className="export-button" onClick={exportProject}><Download size={16} /> Export MP4</button>
    </header>

    <main className="workspace">
      <section className="upper-workspace">
        <aside className="media-panel panel">
          <div className="panel-tabs"><button className={sidebarTab === 'project' ? 'selected' : ''} onClick={() => setSidebarTab('project')}>Project</button><button className={sidebarTab === 'effects' ? 'selected' : ''} onClick={() => setSidebarTab('effects')}>Effects</button><MoreHorizontal size={16} /></div>
          {sidebarTab === 'project' ? <>
            <div className="panel-subhead"><span>MEDIA BIN <span className="count-pill">{project.assets.length}</span></span><button title="Import media" onClick={() => setDiskOpen(true)}><Plus size={17} /></button></div>
            <div className="searchbox"><Search size={15} /><input placeholder="Search media..." value={mediaSearch} onChange={e => setMediaSearch(e.target.value)} /></div>
            <div className="media-list">
              {filteredAssets.length ? filteredAssets.map(asset => <div key={asset.id} className={`media-item ${selectedAssetId === asset.id ? 'selected' : ''} ${!asset.url ? 'offline' : ''}`} draggable={!!asset.url} onDragStart={e => { internalDrag.current = true; setDropHover(false); e.dataTransfer.setData('application/x-framecut-asset', asset.id); e.dataTransfer.effectAllowed = 'copy' }} onDragEnd={() => { internalDrag.current = false; setDropHover(false) }} onClick={() => { setSelectedAssetId(asset.id); setSourceTime(0) }} onDoubleClick={() => asset.url ? addAssetToTimeline(asset.id) : setRelinkOpen(true)}>
                <div className="media-thumb">{asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : asset.kind === 'audio' ? <AudioLines size={25} /> : <Film size={23} />}<span className="media-duration">{asset.kind === 'image' ? 'IMAGE' : shortTime(asset.duration)}</span></div>
                <div className="media-meta"><strong title={asset.name}>{asset.name}</strong><small>{asset.url ? asset.kind !== 'audio' ? `${asset.width} × ${asset.height} · ${asset.kind === 'image' ? 'Image' : 'Video'}` : 'Audio' : 'Media offline'}</small></div>
                {!asset.url ? <button className="media-add" title="Locate source on disk" onClick={e => { e.stopPropagation(); relinkTarget.current = asset.id; setDiskOpen(true) }}><Link2 size={15} /></button> : <button className="media-add" title="Add to timeline" onClick={e => { e.stopPropagation(); addAssetToTimeline(asset.id) }}><Plus size={16} /></button>}
              </div>) : <div className="bin-empty"><div className="bin-empty-icon"><Upload size={28} /></div><strong>{project.assets.length ? 'No matching media' : 'Your story starts here'}</strong><p>{project.assets.length ? 'Try a different search.' : 'Drag video, audio, and image files here, or import from your computer.'}</p>{!project.assets.length && <button onClick={() => setDiskOpen(true)}><Plus size={15} /> Import media</button>}</div>}
            </div>
            <div className="panel-footer"><span><span className="local-dot" /> Media loaded in browser</span><button title="Import media" onClick={() => setDiskOpen(true)}><Plus size={16} /></button></div>
          </> : <div className="effects-empty"><SlidersHorizontal size={27} /><strong>Clip controls</strong><p>Select a clip to inspect its timing and source details.</p><button onClick={() => setShowProperties(true)}>Open properties</button></div>}
        </aside>

        <section className="monitor-panel panel source-panel">
          <div className="monitor-heading"><div><span className="heading-accent source" /> SOURCE <span className="heading-filename">{selectedAsset?.name ?? 'No clip selected'}</span></div><HeaderButton title="Add selected source to timeline" disabled={!selectedAsset?.url} onClick={() => selectedAsset && addAssetToTimeline(selectedAsset.id)}><Plus size={15} /></HeaderButton></div>
          <div className="monitor-screen source-screen">{selectedAsset?.url ? selectedAsset.kind === 'image' ? <StillImage key={selectedAsset.url} url={selectedAsset.url} name={selectedAsset.name} className="source-image" /> : selectedAsset.kind === 'video' ? <video key={selectedAsset.url} src={selectedAsset.url} controls playsInline preload="metadata" onTimeUpdate={e => setSourceTime(e.currentTarget.currentTime)} /> : <div className="audio-source"><AudioLines size={65} /><strong>{selectedAsset.name}</strong><audio src={selectedAsset.url} controls onTimeUpdate={e => setSourceTime(e.currentTarget.currentTime)} /></div> : <div className="monitor-empty"><div className="empty-monitor-icon"><Film size={29} /></div><span>Source monitor</span><p>Select a clip from your project bin to preview it here</p></div>}</div>
          <div className="monitor-controls"><span className="timecode source-code">{timecode(sourceTime, project.frameRate)}</span><div className="monitor-center">{selectedAsset && <span className="monitor-hint">Double-click media to add to sequence</span>}</div><span className="monitor-end">{selectedAsset ? timecode(selectedAsset.duration, project.frameRate) : '00:00:00:00'}</span></div>
        </section>

        <section className="monitor-panel panel program-panel">
          <div className="monitor-heading"><div><span className="heading-accent program" /> PROGRAM <span className="heading-filename">{project.name}</span></div><HeaderButton title="Sequence settings" onClick={() => setShowProperties(true)}><Settings2 size={15} /></HeaderButton></div>
          <div className="monitor-screen program-screen">
            {playing && waitingForPlayback && <div className="playback-wait" role="status">Preparing playback…</div>}
            <SequenceFrame width={project.width} height={project.height}>
            {!activeVideos.length && <div className="monitor-empty"><div className="empty-monitor-icon purple"><Play size={30} fill="currentColor" /></div><span>Program monitor</span><p>Drop a clip onto the timeline to start editing</p></div>}
            {previewClips.map(({ clip, active }) => {
              const asset = assetById.get(clip.assetId)
              const audioOnly = clip.trackId.startsWith('A')
              return asset?.url ? <MediaPlayer key={clip.id} id={clip.id} onElement={registerPlayer} onError={playbackError} asset={asset}
                time={active ? clip.in + playhead - clip.start : clip.in} playing={playing && active} audioOnly={audioOnly} muted={!audioOnly}
                className={active ? audioOnly ? undefined : `program-video ${clip.trackId.toLowerCase()}` : 'preload-media'} /> : null
            })}
            </SequenceFrame>
          </div>
          <div className="monitor-controls"><span className="timecode">{timecode(playhead, project.frameRate)}</span><div className="monitor-center transport"><button title="Previous frame" onClick={() => seek(playhead - 1 / project.frameRate)}><SkipBack size={16} /></button><button className="play-control" title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => { if (playhead >= duration && duration > 0) seek(0); setPlaying(p => !p) }}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><button title="Next frame" onClick={() => seek(playhead + 1 / project.frameRate)}><SkipForward size={16} /></button></div><span className="monitor-end">{timecode(duration, project.frameRate)} <Maximize2 size={14} /></span></div>
        </section>
      </section>

      <section className="timeline-panel panel">
        <div className="timeline-top"><div className="sequence-tab"><span className="sequence-dot" /><span>{project.name}</span><span className="sequence-dirty" /></div><span className="sequence-details">{project.width} × {project.height} · {project.frameRate} fps</span><div className="top-spacer" /><HeaderButton title="Sequence settings" onClick={() => setShowProperties(true)}><Settings2 size={15} /></HeaderButton></div>
        <div className="timeline-toolbar">
          <div className="tools-group"><HeaderButton title="Selection tool (V)" active={tool === 'select'} onClick={() => setTool('select')}><span className="selection-icon">↖</span></HeaderButton><HeaderButton title="Razor tool (C)" active={tool === 'razor'} onClick={() => setTool('razor')}><Scissors size={17} /></HeaderButton><span className="toolbar-separator" /><HeaderButton title="Undo (Ctrl+Z)" onClick={undo} disabled={!undoStack.current.length}><Undo2 size={16} /></HeaderButton><HeaderButton title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!redoStack.current.length}><Redo2 size={16} /></HeaderButton><HeaderButton title="Delete selected clip" onClick={deleteSelected} disabled={!selectedClip}><Trash2 size={16} /></HeaderButton><span className="toolbar-separator" /><HeaderButton title="Toggle snapping" active={snapping} onClick={() => setSnapping(s => !s)}><Magnet size={16} /></HeaderButton></div>
          <div className="toolbar-center"><span className="timeline-current">{timecode(playhead, project.frameRate)}</span><span className="timeline-slash">/</span><span>{timecode(duration, project.frameRate)}</span></div>
          <div className="zoom-controls"><button title="Zoom out" onClick={() => setZoom(z => Math.max(18, z / 1.25))}><ZoomOut size={16} /></button><input aria-label="Timeline zoom" type="range" min="18" max="220" value={zoom} onChange={e => setZoom(Number(e.target.value))} /><button title="Zoom in" onClick={() => setZoom(z => Math.min(220, z * 1.25))}><ZoomIn size={16} /></button><span>{Math.round(zoom)}px/s</span></div>
        </div>
        <div className="timeline-body">
          <div className="track-sidebar"><div className="sidebar-ruler"><span>TRACKS</span><GripVertical size={14} /></div>{TRACKS.map(track => <div key={track} className={`track-header ${track.startsWith('A') ? 'audio' : ''}`}><div className="track-id">{track.startsWith('V') ? <Film size={14} /> : <Music2 size={14} />}<strong>{track}</strong></div><div className="track-actions"><button title={mutedTracks.includes(track) ? track.startsWith('V') ? 'Show track' : 'Unmute track' : track.startsWith('V') ? 'Hide track' : 'Mute track'} className={mutedTracks.includes(track) ? 'active' : ''} onClick={() => setMutedTracks(current => current.includes(track) ? current.filter(x => x !== track) : [...current, track])}>{track.startsWith('V') ? mutedTracks.includes(track) ? <EyeOff size={14} /> : <Eye size={14} /> : mutedTracks.includes(track) ? <VolumeX size={14} /> : <Volume2 size={14} />}</button><button title={lockedTracks.includes(track) ? 'Unlock track' : 'Lock track'} className={lockedTracks.includes(track) ? 'active' : ''} onClick={() => setLockedTracks(current => current.includes(track) ? current.filter(x => x !== track) : [...current, track])}>{lockedTracks.includes(track) ? '●' : '○'}</button></div></div>)}</div>
          <div className="timeline-scroll" ref={timelineScroll} tabIndex={-1}>
            <div className="timeline-content" style={{ width: timelineWidth }} onContextMenu={event => {
              event.preventDefault()
              const time = Math.max(0, Math.min(duration, Math.round((event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom * project.frameRate) / project.frameRate))
              setTimelineMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 124)), time })
            }}>
              <div className="ruler" onPointerDown={event => {
                if (event.button !== 0) return
                const rect = event.currentTarget.getBoundingClientRect()
                seek((event.clientX - rect.left) / zoom)
                const move = (e: PointerEvent) => seek((e.clientX - rect.left) / zoom)
                const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up, { once: true })
              }}>{rangeStyle && <div className="export-range" style={rangeStyle} />}{ticks.map(tick => <div key={tick} className="ruler-tick" style={{ left: tick * zoom }}><span>{shortTime(tick)}</span></div>)}</div>
              {TRACKS.map(track => <div key={track} data-track={track} className={`track-row ${track.startsWith('A') ? 'audio' : ''} ${lockedTracks.includes(track) ? 'locked' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => onTrackDrop(e, track)} onPointerDown={e => { if (e.button === 0 && e.target === e.currentTarget) { setSelectedClipId(null); seek((e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom) } }}>
                {rangeStyle && <div className="export-range" style={rangeStyle} />}
                {shownClips.filter(c => c.trackId === track).map(clip => {
                  const asset = project.assets.find(a => a.id === clip.assetId)
                  const clipWidth = Math.max(3, durationOf(clip) * zoom)
                  return <div key={clip.id} className={`timeline-clip ${track.startsWith('A') ? 'audio-clip' : 'video-clip'} ${selectedClipId === clip.id ? 'selected' : ''} ${!asset?.url ? 'missing' : ''}`} style={{ left: clip.start * zoom, width: clipWidth, backgroundImage: track.startsWith('V') && asset?.thumbnail ? `linear-gradient(90deg, rgba(26,20,39,.4), rgba(35,25,51,.22)), url(${asset.thumbnail})` : undefined }} onPointerDown={e => beginClipPointer(e, clip, 'move')} title={`${asset?.name ?? 'Missing media'}\n${timecode(clip.in)} – ${timecode(clip.out)}`}>
                    <div className="clip-handle left" onPointerDown={e => beginClipPointer(e, clip, 'trim-start')} />
                    <div className="clip-inner">{track.startsWith('V') ? <Film size={13} /> : <AudioLines size={14} />}<span>{asset?.name ?? 'Missing media'}</span>{clip.linkedId && <Link2 size={11} />}</div>
                    {track.startsWith('A') && <div className="waveform" aria-hidden="true" />}
                    <div className="clip-handle right" onPointerDown={e => beginClipPointer(e, clip, 'trim-end')} />
                  </div>
                })}
              </div>)}
              {exportStart !== undefined && <div className="export-marker start" style={{ left: exportStart * zoom }} aria-label={`Export start ${timecode(exportStart, project.frameRate)}`}><span>IN</span></div>}
              {exportEnd !== undefined && <div className="export-marker end" style={{ left: exportEnd * zoom }} aria-label={`Export end ${timecode(exportEnd, project.frameRate)}`}><span>OUT</span></div>}
              <div ref={timelinePlayhead} className="playhead" style={{ left: playhead * zoom }}><div className="playhead-head" /></div>
            </div>
          </div>
        </div>
        <div className="timeline-footer"><span><span className="footer-indicator" /> {project.clips.length} clips · {project.assets.length} media files</span><span>V Selection&nbsp;&nbsp; C Razor&nbsp;&nbsp; S Split&nbsp;&nbsp; Space Play/Pause&nbsp;&nbsp; Shift Disable snap</span></div>
      </section>
    </main>

    {timelineMenu && <div ref={timelineMenuRef} className="timeline-context-menu" role="menu" aria-label="Timeline export markers" style={{ left: timelineMenu.x, top: timelineMenu.y }} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); setTimelineMenu(null); timelineScroll.current?.focus(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
      }
    }}>
      <button role="menuitem" disabled={!duration || timelineMenu.time >= (exportEnd ?? duration)} onClick={() => { commit(previous => ({ ...previous, exportStart: timelineMenu.time })); setTimelineMenu(null) }}>Mark Export Start</button>
      <button role="menuitem" disabled={!duration || timelineMenu.time <= (exportStart ?? 0)} onClick={() => { commit(previous => ({ ...previous, exportEnd: timelineMenu.time })); setTimelineMenu(null) }}>Mark Export End</button>
      <button role="menuitem" disabled={exportStart === undefined && exportEnd === undefined} onClick={() => { commit(previous => ({ ...previous, exportStart: undefined, exportEnd: undefined })); setTimelineMenu(null) }}>Clear Export Markers</button>
    </div>}

    {selectedClip && <div className="selection-status"><Info size={14} /><span><strong>{project.assets.find(a => a.id === selectedClip.assetId)?.name}</strong> · {selectedClip.trackId} · {timecode(selectedClip.start, project.frameRate)} → {timecode(endOf(selectedClip), project.frameRate)}</span><button onClick={() => setShowProperties(true)}>Properties</button><button onClick={() => setSelectedClipId(null)}><X size={14} /></button></div>}
    {toast && <div className="toast"><Check size={16} />{toast}<button onClick={() => setToast(null)}><X size={14} /></button></div>}
    {busy && <div className="busy-pill"><span className="spinner" />{busy}</div>}
    {dropHover && <div className="global-drop"><Upload size={40} /><strong>Drop media to import</strong><span>Files will be copied to the server’s media folder</span></div>}

    {relinkOpen && <div className="modal-backdrop" onClick={() => setRelinkOpen(false)}><div className="modal relink-modal" onClick={e => e.stopPropagation()}><div className="modal-top"><div><Link2 size={20} /><h2>Media unavailable</h2></div><button onClick={() => setRelinkOpen(false)}><X size={18} /></button></div><p>These files could not be loaded into the browser. Retry loading, or locate the original files if they have moved. Save after reconnecting a source.</p><button className="modal-primary" onClick={() => void retryMedia()}>Retry loading media</button><div className="missing-list">{unresolved.length ? unresolved.map(asset => <div key={asset.id}><Film size={18} /><span><strong>{asset.name}</strong><small title={asset.sourcePath}>{asset.sourcePath || asset.name}</small><small>{asset.offlineReason}</small></span><button onClick={() => { relinkTarget.current = asset.id; setDiskOpen(true) }}>Find file</button></div>) : <div className="all-linked"><Check size={18} /> All media is linked.</div>}</div><button className="modal-primary" onClick={() => { relinkTarget.current = null; relinkInput.current?.click() }}><FolderOpen size={16} /> Upload replacement files</button></div></div>}
    {diskOpen && <DiskBrowser progress={busy} title={relinkTarget.current ? 'Locate original source' : 'Import from disk'} onClose={() => { setDiskOpen(false); relinkTarget.current = null }} onImport={importPaths} />}
    {projectsOpen && <ProjectBrowser onClose={() => setProjectsOpen(false)} onOpen={loadProject} onNew={() => { if (dirty && !window.confirm('Discard unsaved changes and create a new project?')) return; applyLoaded(emptyProject(), null, 0); setProjectsOpen(false) }} />}
    {(starting || loadingProject) && <div className="modal-backdrop"><div className="modal" role="status"><h2>Loading project media</h2><p>{busy || 'Opening project from the server…'}</p><small>Media is loaded into the browser before playback.</small></div></div>}
    {showProperties && <div className="modal-backdrop" onClick={() => setShowProperties(false)}><div className="modal properties-modal" onClick={e => e.stopPropagation()}><div className="modal-top"><div><Settings2 size={20} /><h2>Sequence settings</h2></div><button onClick={() => setShowProperties(false)}><X size={18} /></button></div><div className="property-grid"><label>Frame width<input type="number" min="16" max="3840" step="2" value={project.width} onChange={e => updateSequence({ width: Number(e.target.value) })} /></label><label>Frame height<input type="number" min="16" max="2160" step="2" value={project.height} onChange={e => updateSequence({ height: Number(e.target.value) })} /></label><label>Frame rate<select value={project.frameRate} onChange={e => updateSequence({ frameRate: Number(e.target.value) })}><option value="24">24 fps</option><option value="25">25 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></label></div>{selectedClip && <div className="clip-properties"><h3>Selected clip</h3><div><span>Track</span><strong>{selectedClip.trackId}</strong></div><div><span>Timeline start</span><strong>{timecode(selectedClip.start, project.frameRate)}</strong></div><div><span>Source in / out</span><strong>{timecode(selectedClip.in, project.frameRate)} / {timecode(selectedClip.out, project.frameRate)}</strong></div><div><span>Duration</span><strong>{timecode(durationOf(selectedClip), project.frameRate)}</strong></div><button onClick={() => { splitAt(selectedClip.id, playhead); setShowProperties(false) }}><Scissors size={15} /> Split at playhead</button></div>}<button className="modal-primary" onClick={() => setShowProperties(false)}>Done</button></div></div>}
    {exportsOpen && <ExportDialog project={project} mutedTracks={mutedTracks} onClose={() => setExportsOpen(false)} />}
  </div>
}
