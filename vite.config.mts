import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    // 显式绑定 IPv4 回环，避免 Node 只监听 ::1 导致探测/加载失败
    host: '127.0.0.1',
    port: 5180,
    strictPort: false,
  },
})
