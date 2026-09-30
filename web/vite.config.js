import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, point the UI at a device with DEVICE_PORT=8102 npm run dev
const port = process.env.DEVICE_PORT || '8101'

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs, so the same build works at / (local) and under /laptop/ or /mobile/ (deployed).
  base: './',
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } },
  },
})
