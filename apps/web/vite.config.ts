import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: fileURLToPath(new URL('../../assets/', import.meta.url)),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 65536,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        ...(mode === 'pages'
          ? {}
          : { check: fileURLToPath(new URL('runtime-check.html', import.meta.url)) }),
      },
    },
  },
  worker: { format: 'iife' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
