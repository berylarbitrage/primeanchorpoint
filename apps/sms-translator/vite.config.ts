import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer is loaded from disk (file://) in production, so every asset
// reference has to be relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome128',
  },
})
