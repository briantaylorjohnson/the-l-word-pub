import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  css: {
    preprocessorOptions: {
      scss: {
        // Argon's SCSS imports plain `bootstrap/scss/...` (the `~` webpack
        // convention was stripped out) — this lets Sass resolve those
        // bare package imports the same way Node module resolution would.
        loadPaths: ['node_modules'],
      },
    },
  },
})
