import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import './index.css'
import { router } from './router'
import '@xterm/xterm/css/xterm.css'

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { refetchOnWindowFocus: false, retry: false }
    }
})

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
        </QueryClientProvider>
    </StrictMode>
)

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            /* PWA install support is optional. */
        })
    })
}
