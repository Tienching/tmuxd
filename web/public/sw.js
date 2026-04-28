self.addEventListener('install', () => {
    self.skipWaiting()
})

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', () => {
    // Keep network behavior unchanged. The terminal/API should stay live-only.
})
