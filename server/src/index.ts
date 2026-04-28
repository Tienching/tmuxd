import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { loadConfig } from './config.js'
import { createAuthRoutes } from './routes/auth.js'
import { createSessionsRoutes } from './routes/sessions.js'
import { createHealthRoutes } from './routes/health.js'
import { createWsServer, tryHandleUpgrade } from './ws.js'

function resolveWebDist(): string | null {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const candidates = [
        resolve(__dirname, '..', '..', 'web', 'dist'),
        resolve(__dirname, '..', 'web-dist'),
        resolve(process.cwd(), 'web', 'dist')
    ]
    for (const c of candidates) {
        if (existsSync(c) && statSync(c).isDirectory()) return c
    }
    return null
}

async function main() {
    const config = loadConfig()

    const app = new Hono()

    // CORS + common headers for localhost use
    app.use('*', async (c, next) => {
        c.header('X-Content-Type-Options', 'nosniff')
        if (c.req.path.startsWith('/api/')) {
            c.header('Cache-Control', 'no-store')
        }
        await next()
    })

    app.route('/', createHealthRoutes())
    app.route('/api', createAuthRoutes(config.password, config.jwtSecret))
    app.route('/api', createSessionsRoutes(config.jwtSecret))

    const webDist = resolveWebDist()
    if (webDist) {
        // Serve static web assets with SPA fallback.
        app.use('/*', serveStatic({ root: webDist, rewriteRequestPath: (p) => p }))
        app.notFound(async (c) => {
            const indexPath = join(webDist, 'index.html')
            if (existsSync(indexPath)) {
                const { readFile } = await import('node:fs/promises')
                const html = await readFile(indexPath, 'utf8')
                return c.html(html)
            }
            return c.text('Not found', 404)
        })
    } else {
        app.get('/', (c) =>
            c.text(
                'tmuxd server running. Web assets not built — run `npm run build:web` or `npm run dev:web`.\n',
                200
            )
        )
    }

    const server = serve(
        {
            fetch: app.fetch,
            hostname: config.host,
            port: config.port
        },
        (info) => {
            console.log(`tmuxd listening on http://${info.address}:${info.port}`)
            if (!webDist) {
                console.log('(no web/dist found — serving API only)')
            }
        }
    )

    const wss = createWsServer({ jwtSecret: config.jwtSecret })
    server.on('upgrade', async (request, socket, head) => {
        try {
            const handled = await tryHandleUpgrade(wss, config.jwtSecret, request, socket, head)
            if (!handled) {
                socket.destroy()
            }
        } catch (err) {
            console.error('upgrade error', err)
            socket.destroy()
        }
    })

    const shutdown = () => {
        console.log('shutting down …')
        for (const client of wss.clients) {
            try {
                client.close(1001, 'server_shutdown')
            } catch {
                /* ignore */
            }
        }
        wss.close()
        server.close(() => process.exit(0))
        // Safety net: if sockets linger, force-exit after 3s.
        setTimeout(() => process.exit(0), 3000).unref()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

main().catch((err) => {
    console.error('fatal:', err instanceof Error ? err.message : err)
    process.exit(1)
})
