import { fileURLToPath, URL } from 'node:url'

import dts from 'unplugin-dts/vite'
import { defineConfig } from 'vite'

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
        // Опубликованный worker используется последующими Vite-сборками как статический ресурс.
        // Он остаётся самодостаточным, чтобы consumers не искали и не копировали соседние chunks.
        inlineDynamicImports: true,
      },
    },
  },
  plugins: [dts({ bundleTypes: false, include: ['src'], exclude: ['src/test/**'] })],
})
