// Minimal service worker so phones can install the dashboard as an app.
// Data is always live, so nothing is cached: every request goes to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
