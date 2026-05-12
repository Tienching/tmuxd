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
import { setLocalHostEnabled } from './hosts.js'
import { AgentRegistry } from './agentRegistry.js'
import { TmuxActionStore } from './actions.js'

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

/**
 * Parse the test-only TMUXD_JWT_TTL_SECONDS_FOR_TEST env var. Empty/
 * absent → undefined (issueToken's 12h default applies). Any positive
 * integer → use that. Garbage → undefined + warn so a typo isn't
 * silently shipped to a production deploy that somehow set the var.
 */
function parseTestTtl(raw: string | undefined): number | undefined {
    if (!raw) return undefined
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n) || n <= 0) {
        console.warn(`[tmuxd] ignoring invalid TMUXD_JWT_TTL_SECONDS_FOR_TEST=${raw}`)
        return undefined
    }
    console.warn(
        `[tmuxd] WARNING: TMUXD_JWT_TTL_SECONDS_FOR_TEST=${n} is set — JWTs will expire in ${n}s. ` +
            'This is a TEST-ONLY knob; do not use in production.'
    )
    return n
}

async function main() {
    const config = loadConfig()
    setLocalHostEnabled(!config.hubOnly)
    if (config.hubOnly) {
        console.log('[tmuxd] Hub-only mode: local tmux routes are disabled.')
        if (config.agentTokens.length === 0) {
            // A hub with no registered agents can't serve any tmux sessions
            // (local is disabled, no remote bindings). Warn so that the
            // operator notices before users do.
            console.warn(
                '[tmuxd] WARN: hub-only mode with no agent bindings configured. ' +
                'Set TMUXD_AGENT_TOKENS=<ns>/<hostId>=<token>,... so agents can ' +
                'register, otherwise /api/hosts will be empty for every user.'
            )
        }
    }
    // Confirmation log for operators: who's pre-bound? Lists the count and
    // the unique namespaces. No tokens or hostIds are printed; the number
    // of bindings + namespace names is enough to verify "the hub loaded
    // what I thought it loaded" without exposing any secret material.
    if (config.agentTokens.length > 0) {
        const namespaces = [...new Set(config.agentTokens.map((b) => b.namespace))].sort()
        console.log(
            `[tmuxd] Loaded ${config.agentTokens.length} agent binding(s) across ` +
            `${namespaces.length} namespace(s): ${namespaces.join(', ')}`
        )
    }
    const agentRegistry = new AgentRegistry(config.agentTokens)
    const actionStore = TmuxActionStore.inDataDir(config.dataDir)

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
    app.route(
        '/api',
        createAuthRoutes({
            token: config.token,
            jwtSecret: config.jwtSecret,
            // Test-only knob to force a short JWT TTL for the expired-JWT
            // path. Never document this; never set it in production.
            // The CLI's e2e suite uses `1` (one second) to verify whoami
            // and authenticated requests behave correctly post-expiry.
            jwtTtlSeconds: parseTestTtl(process.env.TMUXD_JWT_TTL_SECONDS_FOR_TEST)
        })
    )
    app.route('/api', createSessionsRoutes(config.jwtSecret, agentRegistry, actionStore))

    const webDist = resolveWebDist()
    if (webDist) {
        // Serve static web assets with SPA fallback.
        app.use('/*', serveStatic({ root: webDist, rewriteRequestPath: (p) => p }))
        app.notFound(async (c) => {
            if (c.req.path.startsWith('/api/')) {
                return c.json({ error: 'not_found' }, 404)
            }
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

    const wss = createWsServer({ jwtSecret: config.jwtSecret, agentRegistry })
    server.on('upgrade', async (request, socket, head) => {
        try {
            const handledAgent = await agentRegistry.tryHandleUpgrade(request, socket, head)
            if (handledAgent) return
            const handled = await tryHandleUpgrade(wss, config.jwtSecret, request, socket, head, { agentRegistry })
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
        agentRegistry.close()
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
