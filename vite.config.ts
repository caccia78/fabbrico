import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { padRelay } from './server/padRelay.ts'
import { localActions } from './server/localActions.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), padRelay(), localActions()],
  // Listen on the local network too, so a tablet can open pad.html (see server/padRelay.ts).
  server: { host: true },
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), pad: resolve(import.meta.dirname, 'pad.html') },
    },
  },
  // The geometry worker imports modules (kernel, mathjs…), so it must be an ES module worker.
  worker: { format: 'es' },
})
