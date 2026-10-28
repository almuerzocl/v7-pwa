// @ts-nocheck
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist, StaleWhileRevalidate, CacheFirst, ExpirationPlugin } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// --- Offline POST Queue (Background Sync fallback) ---
const OFFLINE_QUEUE_KEY = "almuerzo-offline-queue";

async function getOfflineQueue(): Promise<any[]> {
  try {
    const cache = await caches.open(OFFLINE_QUEUE_KEY);
    const resp = await cache.match("queue");
    if (!resp) return [];
    return await resp.json();
  } catch { return []; }
}

async function saveOfflineQueue(queue: any[]) {
  const cache = await caches.open(OFFLINE_QUEUE_KEY);
  await cache.put("queue", new Response(JSON.stringify(queue)));
}

async function queueOfflineRequest(request: Request) {
  const body = await request.text();
  const queue = await getOfflineQueue();
  queue.push({
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body,
    timestamp: Date.now(),
  });
  await saveOfflineQueue(queue);
}

async function replayOfflineQueue() {
  const queue = await getOfflineQueue();
  if (queue.length === 0) return;

  const remaining: any[] = [];
  for (const entry of queue) {
    try {
      const resp = await fetch(entry.url, {
        method: entry.method,
        headers: entry.headers,
        body: entry.body,
      });
      if (!resp.ok) remaining.push(entry); // keep failed ones for next retry
    } catch {
      remaining.push(entry); // still offline
    }
  }
  await saveOfflineQueue(remaining);

  // Notify all clients about queue status
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({
      type: "OFFLINE_QUEUE_REPLAYED",
      remaining: remaining.length,
      replayed: queue.length - remaining.length,
    });
  });
}

// Replay queue when back online
self.addEventListener("message", (event) => {
  if (event.data?.type === "REPLAY_OFFLINE_QUEUE") {
    replayOfflineQueue();
  }
});

// --- Serwist Configuration ---
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      // Server actions, API routes, RSC fetches → network-only with offline queue fallback
      matcher: ({ request, url }) => {
        const isSameOrigin = url.origin === self.location.origin;
        return (
          (request.method === "POST" && isSameOrigin) ||
          url.pathname.startsWith("/api/") ||
          request.headers.get("Next-Action") !== null ||
          request.headers.get("Next-Router-State-Tree") !== null ||
          request.headers.get("RSC") !== null ||
          (request.headers.get("content-type")?.includes("text/x-component") ?? false)
        );
      },
      handler: new (class {
        async handle({ request }) {
          try {
            const response = await fetch(request.clone());
            return response;
          } catch (err) {
            // Network failed — queue POST requests for retry when online
            if (request.method === "POST") {
              await queueOfflineRequest(request.clone());
              return new Response(
                JSON.stringify({ success: false, error: "Sin conexión. Tu acción se guardó y se enviará cuando vuelvas a estar online.", queued: true }),
                { status: 503, headers: { "Content-Type": "application/json" } }
              );
            }
            throw err;
          }
        }
      })(),
    },
    {
      // Navigations: network-first — dynamic app needs fresh data, no stale HTML
      matcher: ({ request }) => request.mode === "navigate",
      handler: new (class {
        async handle({ request }) {
          try {
            return await fetch(request);
          } catch {
            // Offline fallback: try cache
            const cached = await caches.match(request);
            if (cached) return cached;
            return new Response("Sin conexión. Por favor, verifica tu internet.", {
              status: 503, headers: { "Content-Type": "text/html; charset=utf-8" }
            });
          }
        }
      })(),
    },
    ...defaultCache,
    {
      matcher: ({ request }) => request.destination === "image",
      handler: new CacheFirst({
        cacheName: "images",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 60,
            maxAgeSeconds: 30 * 24 * 60 * 60,
          }),
        ],
      }),
    },
  ],
});

serwist.addEventListeners();
