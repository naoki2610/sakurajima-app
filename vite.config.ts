import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/sakurajima-app/', // ←【超重要】この1行が絶対に必要です
})
