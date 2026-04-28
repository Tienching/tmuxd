import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
            '@tmuxd/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url))
        }
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://127.0.0.1:7681',
            '/ws': { target: 'ws://127.0.0.1:7681', ws: true }
        }
    },
    build: {
        outDir: 'dist',
        sourcemap: false
    }
})
