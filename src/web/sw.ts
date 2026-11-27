/**
 * The service worker of the app `nod serve` serves (ADR 0008 §7), built to
 * `/sw.js` by the plugin in `vite.config.ts`, which replaces `__NOD_BUILD__`
 * with the build id and `__NOD_PRECACHE__` with the build's files. Every
 * decision is in `lib/sw-rules.ts`; this file only wires the events.
 *
 * Install: cache the build's files (`cache: "reload"`, past the HTTP cache)
 * and take over at once (`skipWaiting`). Activate: drop the other builds'
 * caches, claim the open pages and tell them this build, so a page of
 * another build reloads (`lib/sw-register.ts`). Fetch: `strategyFor`.
 * Nothing is written to the cache at run time.
 */

import {
  SHELL,
  activatedMessage,
  cacheName,
  precacheList,
  shellInstead,
  staleCaches,
  strategyFor,
} from "./lib/sw-rules";

declare const __NOD_BUILD__: string;
declare const __NOD_PRECACHE__: string[];

/** The part of `ServiceWorkerGlobalScope` this worker uses (the DOM lib has no worker types). */
interface WorkerScope {
  readonly registration: { readonly scope: string };
  readonly location: { readonly origin: string };
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: {
      type: "window";
      includeUncontrolled?: boolean;
    }): Promise<ReadonlyArray<{ postMessage(message: unknown): void }>>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: string, listener: (event: never) => void): void;
}

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

const worker = self as unknown as WorkerScope;
const BUILD = __NOD_BUILD__;
const CACHE = cacheName(BUILD);
const scoped = (path: string) => new URL(path, worker.registration.scope).href;

worker.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(
        precacheList(__NOD_PRECACHE__).map(
          (path) => new Request(scoped(path), { cache: "reload" }),
        ),
      );
      await worker.skipWaiting();
    })(),
  );
});

worker.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      for (const name of staleCaches(await caches.keys(), CACHE)) await caches.delete(name);
      await worker.clients.claim();
      for (const client of await worker.clients.matchAll({ type: "window" }))
        client.postMessage(activatedMessage(BUILD));
    })(),
  );
});

async function fromCache(request: Request | string): Promise<Response | undefined> {
  const cache = await caches.open(CACHE);
  return cache.match(request, { ignoreSearch: true });
}

worker.addEventListener("fetch", (event: FetchEvent) => {
  const { request } = event;
  const strategy = strategyFor(request, worker.location.origin);
  if (strategy === "pass") return;
  if (strategy === "shell")
    return event.respondWith(
      (async () => {
        let response: Response | null = null;
        try {
          response = await fetch(request);
        } catch {
          response = null;
        }
        if (!shellInstead(response)) return response!;
        return (await fromCache(scoped(SHELL))) ?? response ?? Response.error();
      })(),
    );
  if (strategy === "cache-first")
    return event.respondWith((async () => (await fromCache(request)) ?? fetch(request))());
  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const cached = await fromCache(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
