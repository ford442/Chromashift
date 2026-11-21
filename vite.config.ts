import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  // Every `new Worker(...)` in the app is `{ type: 'module' }`, but Vite's
  // default worker output format is `iife` - so the built workers were classic
  // scripts being constructed as module ones. `es` builds them as the modules
  // they are declared to be, shares chunks with the main bundle instead of
  // duplicating them per worker, and is what makes the lazily loaded upscaler
  // workers' dynamic imports legal at all.
  worker: { format: 'es' },
  resolve: {
    conditions: [
      'onnxruntime-web-use-extern-wasm',
      'import',
      'module',
      'browser',
      'default',
    ],
  },
})
