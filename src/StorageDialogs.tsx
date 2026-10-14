import { useEffect, useState } from 'react'
import { ArrowUp, FileImage, FileVideo, Folder, FolderOpen, X } from 'lucide-react'
import { IMAGE_EXTENSIONS } from './model'
import { browse, listProjects, type Directory, type ProjectEntry } from './storage'

export function DiskBrowser({ onClose, onImport, title = 'Import from disk', progress }: { onClose: () => void; onImport: (paths: string[]) => Promise<void>; title?: string; progress?: string | null }) {
  const [directory, setDirectory] = useState<Directory>()
  const [path, setPath] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  async function navigate(next = '') {
    setLoading(true); setError('')
    try { const result = await browse(next); setDirectory(result); setPath(result.path); setSelected([]) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void navigate() }, [])
  return <div className="modal-backdrop"><section className="modal storage-modal" role="dialog" aria-modal="true" aria-label={title}>
    <div className="modal-top"><div><FolderOpen size={20} /><h2>{title}</h2></div><button aria-label="Close disk browser" disabled={importing} onClick={onClose}><X size={18} /></button></div>
    <p>Select media on the server’s disk. Framecut remembers its location for future sessions.</p>
    <form className="disk-path" onSubmit={e => { e.preventDefault(); void navigate(path) }}>
      <button type="button" aria-label="Parent folder" disabled={loading || importing || !directory || directory.parent === directory.path} onClick={() => void navigate(directory?.parent)}><ArrowUp size={18} /></button>
      <input aria-label="Folder path" value={path} onChange={e => setPath(e.target.value)} placeholder="Absolute folder path" /><button disabled={loading || importing}>Go</button>
    </form>
    {error && <p className="storage-error" role="alert">{error}</p>}
    {importing && progress && <p role="status">{progress}</p>}
    <div className="disk-entries" aria-busy={loading}>
      {loading ? <p>Loading folder…</p> : directory?.entries.length ? directory.entries.map(entry => <button key={entry.path} disabled={importing} className={`disk-entry ${selected.includes(entry.path) ? 'selected' : ''}`} onClick={() => entry.directory ? void navigate(entry.path) : setSelected(current => current.includes(entry.path) ? current.filter(p => p !== entry.path) : [...current, entry.path])}>
        {entry.directory ? <Folder size={17} /> : IMAGE_EXTENSIONS.test(entry.name) ? <FileImage size={17} /> : <FileVideo size={17} />}<span>{entry.name}</span>{!entry.directory && <input aria-label={`Select ${entry.name}`} type="checkbox" checked={selected.includes(entry.path)} readOnly tabIndex={-1} />}
      </button>) : <p>No media files or folders here.</p>}
    </div>
    <button className="modal-primary" disabled={!selected.length || loading || importing} onClick={async () => { setImporting(true); try { await onImport(selected); onClose() } catch (e) { setError((e as Error).message) } finally { setImporting(false) } }}>{importing ? 'Importing…' : `Import ${selected.length || ''} selected file${selected.length === 1 ? '' : 's'}`}</button>
  </section></div>
}

export function ProjectBrowser({ onClose, onOpen, onNew }: { onClose: () => void; onOpen: (id: string) => Promise<boolean>; onNew: () => void }) {
  const [projects, setProjects] = useState<ProjectEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => { listProjects().then(setProjects).catch(e => setError(e.message)).finally(() => setLoading(false)) }, [])
  return <div className="modal-backdrop"><section className="modal storage-modal" role="dialog" aria-modal="true" aria-label="Open project">
    <div className="modal-top"><div><FolderOpen size={20} /><h2>Open project</h2></div><button aria-label="Close projects" onClick={onClose}><X size={18} /></button></div>
    <p>Your projects are saved on the Framecut server.</p>
    {error && <p className="storage-error" role="alert">{error}</p>}
    <div className="disk-entries">{loading ? <p>Loading projects…</p> : projects.length ? projects.map(p => <button className="disk-entry" key={p.id} onClick={async () => { setLoading(true); try { if (await onOpen(p.id)) onClose() } finally { setLoading(false) } }}><FolderOpen size={18} /><span>{p.name}<small>{new Date(p.updatedAt).toLocaleString()}</small></span></button>) : <p>No saved projects yet. Use Save to create one.</p>}</div>
    <button className="modal-primary" disabled={loading} onClick={onNew}>New project</button>
  </section></div>
}
