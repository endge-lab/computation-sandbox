import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  base: './',
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      name: 'computation-sandbox',
      formats: ['es'],
      fileName: () => 'computation-sandbox.js',
    },
    rollupOptions: { external: ['@endge/core'] },
  },
  worker: { format: 'es' },
  plugins: [dts({ rollupTypes: false, include: ['src'], exclude: ['src/test/**'] })],
})
