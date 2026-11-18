/**
 * `nod serve`'s HTTP side: one WebSocket at `/ws` for the user's own
 * browser (any number of its tabs), `/health`, and nothing else. Loopback
 * only. The protocol itself is in `session.ts`.
 *
 * Who gets in (canvas ADR 0001, the host-link part):
 * - **The token.** A WebSocket is not subject to CORS, so any page could open
 *   one to 127.0.0.1. The token from the host link's fragment is what tells
 *   our page apart; it is compared in constant time. A wrong or missing one
 *   closes the socket with `CLOSE_BAD_TOKEN` right after the upgrade and
 *   nothing is sent or read, so the page can say "pair again" instead of
 *   "not running".
 * - **The origin.** A browser always sends `Origin` on a WebSocket; only the
 *   web app's origin and the local dev server's are let through (403
 *   otherwise, before the upgrade). No `Origin` at all is not a browser page
 *   (a script, a test) and still needs the token.
 * - **The host name.** Only `127.0.0.1`, `localhost` and `[::1]`, so a DNS
 *   rebinding page (whose requests name its own host) gets nothing either.
 * - **Private network access.** A page on a public origin (the hosted UI)
 *   reaching loopback makes Chrome send a preflight with
 *   `Access-Control-Request-Private-Network: true`; it is answered for
 *   allowed origins only. WebSockets have no preflight (Chrome's newer Local
 *   Network Access asks the user instead), so this matters for `/health`.
 */

import type { Server, ServerWebSocket } from "bun";

import { CLOSE_BAD_TOKEN, CLOSE_SHUTDOWN, PROTOCOL_VERSION, WS_PATH } from "../shared/protocol";
import type { Client, Session } from "./session";
import { tokensEqual } from "./token";

export interface ServeOptions {
  readonly port: number;
  /** Loopback; `127.0.0.1` unless a test says otherwise. */
  readonly hostname?: string;
  readonly token: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly session: Session;
  readonly version: string | null;
}

interface SocketData {
  readonly authorized: boolean;
  client: Client | null;
}

export interface Serving {
  readonly server: Server<SocketData>;
  readonly port: number;
  stop(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `127.0.0.1:4518` → `127.0.0.1`; `[::1]:4518` → `[::1]`. */
function hostName(host: string | null): string | null {
  if (!host) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
  return match?.[1] ?? null;
}

export function serve(options: ServeOptions): Serving {
  const allowed = new Set(options.allowedOrigins);
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const cors = (origin: string | null): Record<string, string> =>
    origin && allowed.has(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
      : { Vary: "Origin" };

  const server = Bun.serve<SocketData>({
    port: options.port,
    hostname: options.hostname ?? "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const name = hostName(req.headers.get("host"));
      if (!name || !LOOPBACK_HOSTS.has(name)) return new Response("wrong host", { status: 421 });

      if (req.method === "OPTIONS") {
        if (!origin || !allowed.has(origin)) return new Response(null, { status: 403 });
        return new Response(null, {
          status: 204,
          headers: {
            ...cors(origin),
            "Access-Control-Allow-Methods": "GET",
            "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "",
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Max-Age": "600",
          },
        });
      }

      if (url.pathname === "/health")
        return Response.json(
          { ok: true, name: "nod", protocol: PROTOCOL_VERSION, version: options.version },
          { headers: cors(origin) },
        );

      if (url.pathname === WS_PATH) {
        if (origin !== null && !allowed.has(origin))
          return new Response("origin not allowed", { status: 403 });
        const authorized = tokensEqual(url.searchParams.get("token"), options.token);
        return server.upgrade(req, { data: { authorized, client: null } })
          ? undefined
          : new Response("expected a WebSocket upgrade", { status: 426 });
      }

      return new Response("nod serve: open the link printed in your terminal", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        if (!ws.data.authorized) return ws.close(CLOSE_BAD_TOKEN, "bad token");
        sockets.add(ws);
        const client: Client = { send: (data) => void ws.send(data) };
        ws.data.client = client;
        void options.session.attach(client);
      },
      message(ws, data) {
        const client = ws.data.client;
        if (!client) return;
        void options.session.handle(client, typeof data === "string" ? data : data.toString());
      },
      close(ws) {
        sockets.delete(ws);
        if (ws.data.client) options.session.detach(ws.data.client);
      },
    },
  });

  return {
    server,
    port: server.port ?? options.port,
    async stop() {
      for (const ws of sockets) ws.close(CLOSE_SHUTDOWN, "nod serve stopped");
      options.session.stop();
      await server.stop(true);
    },
  };
}
