import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, point the UI at a device with DEVICE_PORT=8102 npm run dev
const port = process.env.DEVICE_PORT || '8101'

// Writes sw.js with this build's app shell: the page, the code it loads up front, styles and fonts.
// The large offline-AI chunks are left out; the service worker caches them the first time they load.
function serviceWorker() {
  return {
    name: 'edgemind-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const chunks = Object.values(bundle).filter((f) => f.type === 'chunk')
      const eager = new Set()
      const visit = (name) => {
        if (eager.has(name)) return
        eager.add(name)
        bundle[name]?.imports?.forEach(visit)
      }
      chunks.filter((c) => c.isEntry).forEach((c) => visit(c.fileName))
      const files = Object.values(bundle)
        .filter((f) => (f.type === 'chunk' ? eager.has(f.fileName) : !f.fileName.endsWith('.wasm')))
        .map((f) => f.fileName)
        .filter((f) => f !== 'sw.js')
      const precache = ['./', ...files.filter((f) => f !== 'index.html')].sort()
      const version = createHash('sha1').update(precache.join('\n')).digest('hex').slice(0, 10)
      const src = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precache, null, 2))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src })
    },
  }
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  // Relative asset URLs, so the same build works at / (local) and under /laptop/ or /mobile/ (deployed).
  base: './',
  // The ONNX runtime inside transformers.js ships its own wasm loader; let it resolve at runtime.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { chunkSizeWarningLimit: 7000 },
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } },
  },
})
