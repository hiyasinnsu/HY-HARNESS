// HY-HARNESS service worker: shows Web Push notifications on a paired phone
// (an approval or a question is waiting, a turn finished) and opens the chat
// when one is tapped. It does not cache anything; the app is always live.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'HY-HARNESS', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'HY-HARNESS', {
      body: data.body || '',
      tag: data.tag || undefined,
      // A newer notification for the same chat replaces the older one but still alerts.
      renotify: Boolean(data.tag),
      icon: '/HY_icon-192.png',
      badge: '/HY_icon-192.png',
      data: { url: data.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin)
  if (target.origin !== self.location.origin) return
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue
        await client.focus()
        client.postMessage({ type: 'open', url: target.href })
        return
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})
