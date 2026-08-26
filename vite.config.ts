import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import dts from 'unplugin-dts/vite'

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
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // The published worker is consumed as a static asset by downstream Vite builds.
        // Keep it self-contained so consumers do not have to discover and copy sibling chunks.
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [dts({ bundleTypes: false, include: ['src'], exclude: ['src/test/**'] })],
})
