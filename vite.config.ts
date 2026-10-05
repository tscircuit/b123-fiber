import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    // Snapshot runs need stable canvas nodes while review artifacts are written.
    hmr: process.env.B123_VISUAL_TEST === '1' ? false : undefined,
    watch: { ignored: ['**/artifacts/**', '**/sandbox/dist/**', '**/.playwright/**'] },
  },
})
