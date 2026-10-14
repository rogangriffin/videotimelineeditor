import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createStorage } from './server/storage.mjs'

const storagePlugin = {
  name: 'framecut-storage',
  async configureServer(server) { server.middlewares.use(await createStorage()) },
  async configurePreviewServer(server) { server.middlewares.use(await createStorage()) },
}

export default defineConfig({ plugins: [react(), storagePlugin], server: { host: '127.0.0.1' }, preview: { host: '127.0.0.1' } })
