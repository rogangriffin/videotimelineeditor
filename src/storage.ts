import { parseProject, serializeProject, type Project } from './model'

export interface SourceRecord {
  sourceId: string
  name: string
  size: number
  lastModified: number
  sourcePath: string
  url?: string
  offlineReason?: string
}
export interface SavedProject { id: string; revision: number; updatedAt: string; project: Project }
export interface ProjectEntry { id: string; name: string; updatedAt: string }
export interface Directory { path: string; parent: string; entries: { name: string; path: string; directory: boolean }[] }

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response
  try { response = await fetch(url, { ...options, headers: { 'X-Framecut': '1', ...options?.headers } }) }
  catch { throw new Error('Cannot reach the Framecut server. Check that it is running and try again.') }
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error ?? `Server request failed (${response.status}).`)
  }
  return response.json()
}

export const browse = (path = '') => request<Directory>(`/api/browse?path=${encodeURIComponent(path)}`)
export const registerSource = (path: string) => request<SourceRecord>('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
export const uploadSource = (file: File) => request<SourceRecord>(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
export const listProjects = () => request<ProjectEntry[]>('/api/projects')
export async function readProject(id: string) {
  const saved = await request<SavedProject>(`/api/projects/${encodeURIComponent(id)}`)
  return { ...saved, project: parseProject(JSON.stringify(saved.project)) }
}
export const writeProject = (id: string, revision: number, project: Project) => request<SavedProject>(`/api/projects/${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, project: JSON.parse(serializeProject(project)) }),
})
