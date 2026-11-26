/**
 * `nod serve`'s HTTP side: one WebSocket at `/ws` for the user's own
 * browser (any number of its tabs), `/health`, and nothing else. Loopback
 * only, unless `--allow-host` names the TLS proxy in front of it (ADR 0005):
 * then that name is a second side, with its own token, its own origin and
 * the built web app. The protocol itself is in `session.ts`.
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
 *   `--allow-host` adds exactly one name: the TLS proxy's in front of this
 *   port (`tailscale serve`, finding 04). That host gets the built web app
 *   too (`webRoot`), so the page and the socket share its origin.
 * - **The side.** The Host header picks the side, and the side picks the
 *   rest: the named host lets in only its own origin with the remote token,
 *   loopback only the web app's and the dev server's origins with the
 *   loopback token (and, on either side, a client with no `Origin` at all,
 *   with that side's token). Neither token opens the other side, and each
 *   side has its own unlock window (`Client.side`).
 * - **A proxied request is never loopback.** `tailscale serve` forwards the
 *   client's own Host, so a tailnet client could ask for `127.0.0.1`. It
 *   also sets `X-Forwarded-For`, `-Host` and `-Proto` on every request and
 *   drops what the client sent under those names, so a request carrying any
 *   of them (or `Forwarded`) came through a proxy: it gets the named host
 *   or 421 (ADR 0005).
 * - **Private network access.** A page on a public origin (the hosted UI)
 *   reaching loopback makes Chrome send a preflight with
 *   `Access-Control-Request-Private-Network: true`; it is answered for
 *   allowed origins only. WebSockets have no preflight (Chrome's newer Local
 *   Network Access asks the user instead), so this matters for `/health`.
 */

import type { Server, ServerWebSocket } from "bun";

import { CLOSE_BAD_TOKEN, CLOSE_SHUTDOWN, PROTOCOL_VERSION, WS_PATH } from "../shared/protocol";
import type { Client, Session } from "./session";
import type { Side } from "./signer";
import { serveStatic } from "./static-files";
import { tokensEqual } from "./token";

/** The one named host besides loopback (`--allow-host`), as the server checks it. */
export interface NamedSide {
  /** Lowercase, no port: what the Host header must name. */
  readonly hostname: string;
  /** `https://<name[:port]>`: the only origin let in on this side. */
  readonly origin: string;
  /** The remote token: this side's, never loopback's. */
  readonly token: string;
  /** The built web app, served on this name only. */
  readonly webRoot: string;
}

export interface ServeOptions {
  readonly port: number;
  /** Loopback; `127.0.0.1` unless a test says otherwise. */
  readonly hostname?: string;
  /** The loopback token. */
  readonly token: string;
  /** The origins let in on loopback. */
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly namedHost?: NamedSide | null;
  readonly session: Session;
  readonly version: string | null;
}

/**
 * How long a socket may be silent before the server closes it, in seconds.
 * Bun pings a client shortly before the limit and counts its pong (a
 * browser answers on its own), so a live tab never hits it, while a phone
 * that vanished (a lost network, a suspended tab) is dropped and its
 * session goes with it. Both sides share the one server, so both get it.
 */
export const WS_IDLE_SECONDS = 60;

interface SocketData {
  readonly authorized: boolean;
  readonly side: Side;
  client: Client | null;
}

export interface Serving {
  readonly server: Server<SocketData>;
  readonly port: number;
  stop(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** What a proxy in front of this port adds; `tailscale serve` sets the first three always. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"];

/** `127.0.0.1:4518` → `127.0.0.1`; `[::1]:4518` → `[::1]`. */
function hostName(host: string | null): string | null {
  if (!host) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
  return match?.[1] ?? null;
}

export function serve(options: ServeOptions): Serving {
  const named = options.namedHost ?? null;
  const sides = {
    loopback: { allowed: new Set(options.allowedOrigins), token: options.token },
    "named-host": named && { allowed: new Set([named.origin]), token: named.token },
  };
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const server = Bun.serve<SocketData>({
    port: options.port,
    hostname: options.hostname ?? "127.0.0.1",
    // No development error page: it would show paths and source lines.
    development: false,
    error: () => new Response("nod serve: internal error", { status: 500 }),
    fetch(req, server) {
      const origin = req.headers.get("origin");
      const name = hostName(req.headers.get("host"));
      const proxied = PROXY_HEADERS.some((header) => req.headers.has(header));
      const side: Side | null = !name
        ? null
        : LOOPBACK_HOSTS.has(name) && !proxied
          ? "loopback"
          : named && name === named.hostname
            ? "named-host"
            : null;
      const rules = side && sides[side];
      if (!side || !rules) return new Response("wrong host", { status: 421 });
      // The Host is one of ours, so the URL parses; checked first all the same.
      const url = URL.parse(req.url);
      if (!url) return new Response("bad request", { status: 400 });
      const allowed = rules.allowed;
      const cors = (origin: string | null): Record<string, string> =>
        origin && allowed.has(origin)
          ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
          : { Vary: "Origin" };

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
        const authorized = tokensEqual(url.searchParams.get("token"), rules.token);
        return server.upgrade(req, { data: { authorized, side, client: null } })
          ? undefined
          : new Response("expected a WebSocket upgrade", { status: 426 });
      }

      if (side === "named-host" && named && (req.method === "GET" || req.method === "HEAD"))
        return serveStatic(named.webRoot, url.pathname);

      return new Response("nod serve: open the link printed in your terminal", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      idleTimeout: WS_IDLE_SECONDS,
      sendPings: true,
      open(ws) {
        if (!ws.data.authorized) return ws.close(CLOSE_BAD_TOKEN, "bad token");
        sockets.add(ws);
        const client: Client = { side: ws.data.side, send: (data) => void ws.send(data) };
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
