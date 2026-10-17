import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: false },
      '/webhooks': { target: 'http://localhost:8790' },
      '/healthz': { target: 'http://localhost:8790' },
    },
  },
})
