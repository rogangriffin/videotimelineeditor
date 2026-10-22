import { waveformBytes, type Waveform } from './waveform'

const STORE = 'peaks'
const MAX_BYTES = 128 * 1024 * 1024
type Record = { key: string; used: number; bytes: number; waveform: Waveform }

// Persistence is optional: private browsing, quota failures, and eviction must not block editing.
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('framecut-waveforms', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('lru', ['used', 'bytes'])
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Waveform cache is unavailable.'))
  })
}

export async function readWaveform(key: string): Promise<Waveform | undefined> {
  let db: IDBDatabase | undefined
  try {
    db = await database()
    return await new Promise((resolve, reject) => {
      const transaction = db!.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const request = store.get(key)
      let record: Record | undefined
      request.onsuccess = () => {
        record = request.result
        if (record) { record.used = Date.now(); store.put(record) }
      }
      transaction.oncomplete = () => resolve(record?.waveform)
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  } catch { return undefined }
  finally { db?.close() }
}

export async function writeWaveform(key: string, waveform: Waveform) {
  let db: IDBDatabase | undefined
  try {
    const bytes = waveformBytes(waveform)
    if (bytes > MAX_BYTES) return
    db = await database()
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      // Walk metadata with a cursor instead of cloning every cached waveform.
      const records: { key: string; bytes: number; used: number }[] = []
      const cursor = store.index('lru').openKeyCursor()
      cursor.onsuccess = () => {
        const current = cursor.result
        if (current) {
          const [used, size] = current.key as number[]
          if (current.primaryKey !== key) records.push({ key: String(current.primaryKey), bytes: size, used })
          current.continue()
        } else {
          let total = bytes + records.reduce((sum, record) => sum + record.bytes, 0)
          for (const record of records.sort((a, b) => a.used - b.used)) {
            if (total <= MAX_BYTES) break
            store.delete(record.key); total -= record.bytes
          }
          store.put({ key, used: Date.now(), bytes, waveform } satisfies Record)
        }
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  } catch { /* The in-memory result is still usable. */ }
  finally { db?.close() }
}
