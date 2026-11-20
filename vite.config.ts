import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => path.resolve(import.meta.dirname, p)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@domain': r('src/domain'),
      '@platform': r('src/platform'),
      '@agent': r('src/agent'),
      '@minecraft': r('src/minecraft'),
      '@host': r('src/host'),
    },
  },
  root: '.',
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/minecraft-viewer': {
        target: 'http://localhost:8787',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: false,
  },
})
