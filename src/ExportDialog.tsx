import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { serializeProject, type Project, type TrackId } from './model'
import { request } from './storage'

interface ExportJob {
  id: string; name: string; filename: string; status: 'queued' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  phase: string; progress: number; createdAt: string; duration: number; encoder?: string; speed?: string; note?: string; error?: string; path?: string; url?: string
}
const active = (job: ExportJob) => ['queued', 'running', 'cancelling'].includes(job.status)

export function ExportDialog({ project, mutedTracks, onClose }: { project: Project; mutedTracks: TrackId[]; onClose: () => void }) {
  const [jobs, setJobs] = useState<ExportJob[]>([])
  const [directory, setDirectory] = useState('')
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const result = await request<{ directory: string; jobs: ExportJob[] }>('/api/exports')
        if (!disposed) { setJobs(result.jobs); setDirectory(result.directory); setConnectionError('') }
      } catch (e) { if (!disposed) setConnectionError((e as Error).message) }
      finally { if (!disposed) { setLoading(false); timer = setTimeout(() => void refresh(), 750) } }
    }
    void refresh()
    return () => { disposed = true; clearTimeout(timer) }
  }, [])
  async function start() {
    setSubmitting(true); setError('')
    try {
      const job = await request<ExportJob>('/api/exports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: JSON.parse(serializeProject(project)), mutedTracks }) })
      setJobs(current => [job, ...current.filter(j => j.id !== job.id)])
    } catch (e) { setError((e as Error).message) }
    finally { setSubmitting(false) }
  }
  async function cancel(id: string) {
    setCancelling(current => [...current, id])
    try {
      const result = await request<ExportJob>(`/api/exports/${id}`, { method: 'DELETE' })
      setJobs(current => current.map(j => j.id === id ? result : j))
    } catch (e) { setError((e as Error).message) }
    finally { setCancelling(current => current.filter(value => value !== id)) }
  }
  return <div className="modal-backdrop"><section className="modal storage-modal exports-dialog" role="dialog" aria-modal="true" aria-label="MP4 exports">
    <div className="modal-top"><div><Download size={20} /><h2>MP4 exports</h2></div><button aria-label="Close exports" onClick={onClose}><X size={18} /></button></div>
    <p>Render the current sequence and export range. Hidden video and muted audio tracks are excluded. Exports continue when you close this dialog or tab; keep the server running.</p>
    <button className="modal-primary" disabled={loading || submitting || !project.clips.length || jobs.filter(active).length >= 4} onClick={() => void start()}>{submitting ? 'Starting export…' : `Render ${project.name}`}</button>
    {error && <p className="storage-error" role="alert">{error}</p>}
    {connectionError && <p className="storage-error" role="alert">{connectionError}</p>}
    <p className="export-directory">Saved exports: {directory || 'Loading…'}</p>
    <div className="export-jobs" aria-busy={loading}>{!loading && !jobs.length && <p>No exports yet.</p>}{jobs.map(job => <article className="export-job" key={job.id}>
      <div className="export-job-heading"><strong>{job.name}</strong><small>{new Date(job.createdAt).toLocaleString()}</small></div>
      <p>{job.phase}{active(job) ? ` · ${Math.round(job.progress * 100)}%` : ''}{job.speed && job.status === 'running' ? ` · ${job.speed}` : ''}</p>
      {active(job) && <div className="progress-track" role="progressbar" aria-label={`Export ${job.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}><div style={{ width: `${job.progress * 100}%` }} /></div>}
      {job.note && <p>{job.note}</p>}
      {job.error && <p className="storage-error">{job.error}</p>}
      {job.path && <small className="export-file-path">{job.path}</small>}
      <div className="export-job-actions">{job.url && <a href={job.url} download={job.filename}><Download size={14} /> Download MP4</a>}{active(job) && <button disabled={job.status === 'cancelling' || cancelling.includes(job.id)} onClick={() => void cancel(job.id)}>Cancel export</button>}</div>
    </article>)}</div>
  </section></div>
}
