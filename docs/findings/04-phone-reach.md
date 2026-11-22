# A phone reaches `nod serve`

> Spike for epic #30, run on 2026-11-21 on a development machine that is on a tailnet. `tailscale serve --bg --https=8445 http://127.0.0.1:<port>` in front of a probe server, then in front of `nod serve --fake` of the proof-of-concept branch, both on the same loopback port; the entry was removed afterwards and `tailscale serve status` was the same before and after. The browser was the nix-store Chromium 157 (headless) driven by `playwright-cli`, with the `Pixel 7` device descriptor. That is desktop Chromium on the same machine pretending to be a phone, so it is weaker evidence than a real phone on another device: what only a real phone can show is listed below. The machine's name is written `<machine>.<tailnet>.ts.net` here.

## Verdict

**B, same origin**: `nod serve --allow-host <machine>.<tailnet>.ts.net:<port>` also serves the built web app on that name, so the page and the socket share one origin. The hosted UI stays what it is today (desktop, loopback) and becomes the deep link's way in: a page that knows it is paired somewhere else forwards a deep link there with a top-level navigation, which needs no permission.

Why not A: in Chrome, a public https page that opens a socket to a tailnet address needs the user's Local Network Access permission. The prompt reads "Look for and connect to any device on your local network", it is not known whether Android Chrome asks or just blocks, and Safari's behaviour could not be checked. B needs no permission in any browser: same-origin requests are exempt by the spec, and private-to-private requests are not enforced by Chromium. B also gives the client a tighter rule than A: a link may only point the page at loopback or at the host that served it.

| # | What | Result |
|---|---|---|
| 1 | A: a public https page (`https://example.com`) opens `wss://<machine>.<tailnet>.ts.net:8445/ws` | **Blocked** without the permission: `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` for the socket, "Permission was denied for this request to access the `local` address space" for a `fetch` to `/health`. Nothing reached the server. |
| 2 | The same, after `grantPermissions(['local-network-access'])` for that origin | **Works**: the socket opened and echoed, and the `fetch` was answered. No preflight: the server saw no `OPTIONS`. |
| 3 | Today's path: `https://example.com` opens `ws://127.0.0.1:<port>/ws` | **Blocked the same way** (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`): loopback is gated as well. The hosted UI on desktop Chrome already depends on this permission, so A would add no new kind of prompt on desktop. Headless Chromium denies where a headed one asks. |
| 4 | B: the "on another device" link of `nod serve --fake --allow-host …` in the emulated Pixel | **Works, no permission**: the dashboard loaded from the tailnet origin, paired, and dropped the token from the address bar. The unlock dialog took the passphrase and signed one PR ("1 pull request signed"); a raw socket from the page did `unlock` and `lock`. |
| 5 | A public page navigates its top-level window to `https://<machine>.<tailnet>.ts.net:8445/#/pr/tallyho/fieldbook/7` | **Works, no permission**: the link landing of the tailnet origin opened ("Opened from a link · #7"). So the hosted page can forward a deep link to a paired tailnet origin. |
| 6 | What `tailscale serve` passes to the backend | WebSocket upgrades pass. `Host` is the public name with its port (`<machine>.<tailnet>.ts.net:8445`), plus `X-Forwarded-Host`, `X-Forwarded-Proto: https` and `X-Forwarded-For`. So the server's Host check works unchanged with one more allowed name. |
| 8 | What a tailnet client controls through `tailscale serve` (1.98, after the PR #32 review; `curl` and a raw TLS client with SNI = the tailnet name) | **`Host` is the client's**: `Host: 127.0.0.1:<port>` reaches the backend as sent, so before the fix such a client landed on the loopback side and the loopback token opened the socket (`101` and a `welcome`). **The `X-Forwarded-*` headers are not**: `X-Forwarded-For`, `-Host` and `-Proto` are set on every request, over HTTP/1.1 and HTTP/2, whatever the client sent under those names; `Forwarded` and `Tailscale-User-Login` sent by the client are dropped; listing them in `Connection` (hop-by-hop) does not remove them. With the fix, that request gets 421. |
| 7 | The socket drops (nod serve restarted) | **Comes back**: closed with 4001, retries at 0.5 s and 1 s, open again 3.6 s after the drop. A frozen tab could not be reproduced: CDP's `Page.setWebLifecycleState: frozen` did not stop the page's timers in headless Chromium. |

## The browser rules (sources)

- **Chrome, Local Network Access** ([spec](https://wicg.github.io/local-network-access/), [Chrome blog](https://developer.chrome.com/blog/local-network-access)). It replaces Private Network Access: a permission instead of preflights ("there are no preflights"). The address space comes from the IP the connection resolves to, not the name. The spec's table puts `100.64.0.0/10` ("Carrier-Grade NAT") and `fc00::/7` in **local**, so both Tailscale ranges are local, and `127.0.0.0/8` and `::1` in **loopback**. Only secure contexts may ask. Same-origin requests are exempt, and "Chromium only implements Local Network Access restrictions for public to local or loopback requests". The prompt launched in Chrome 142 (blog, 2025-09). The blog said WebSockets were "not yet gated" and would follow; result 1 shows they are gated in Chromium 157. `fetch` can declare `targetAddressSpace`; a WebSocket cannot.
- **Not confirmed from an official source**: the Chrome version that gated WebSockets; whether Chrome on Android shows the prompt or blocks (the blog points at Android's own local network permission and gives no version); whether the decision is remembered per origin ("may persist", says the spec); how a denied socket fails, beyond the error seen in result 1.
- **Safari / WebKit**: no position on Private or Local Network Access was found on WebKit's standards-positions tracker (first page), and no Safari prompt for this case is documented. iOS's own "Local Network" privacy permission (TN3179) could not be read, so whether it applies to Safari or to traffic through Tailscale's tunnel is open. Headless WebKit would not launch here (its build did not match this Playwright), and Linux WebKit is not iOS Safari anyway. B does not depend on any of it.
- **Tailscale**: `tailscale serve` adds `Tailscale-User-Login`, `-Name` and `-Profile-Pic` to tailnet requests (not to Funnel requests, and not from tagged devices), and strips them from incoming requests ([KB 1312](https://tailscale.com/kb/1312/serve)). The HTTPS certificates put the machine and tailnet names in a public log ([KB 1153](https://tailscale.com/kb/1153/enabling-https)). Not found: whether Chrome on Android with "secure DNS" on still resolves MagicDNS names.

## The threat model, when the token and the passphrase cross the tailnet

- **Who can connect.** Before: processes on the machine. Now also every device and user the tailnet's ACLs let reach the machine on that port, including shared nodes. `tailscale serve` (not Funnel) keeps it off the internet. The token is still what lets a client in; the tailnet only narrows who can try.
- **What the guards still give.**
  - *The token*: unchanged, and now the main gate across the network.
  - *The Origin check*: keeps every other web page out, the phone's included: the allow-list gets exactly `https://<machine>.<tailnet>.ts.net:<port>`.
  - *The Host check*: still stops DNS rebinding; it allows one more name and nothing else.
  - *Loopback binding*: the server still binds `127.0.0.1`; only the proxy reaches it. But the proxy forwards the client's own `Host` (row 8), so loopback is decided by the forwarding headers too (ADR 0005). A process on the machine can send any `Host` and any `Tailscale-User-*` header straight to the loopback port. Those headers would add a check against other tailnet users, but not against the machine itself, which the threat model already covers (ADR 0004's limits).
- **The passphrase in transit.** It travels under TLS from the phone to `tailscaled`, inside WireGuard, and in plain HTTP only on the machine's loopback, as today. It is never stored on the phone (`unlock.tsx` keeps it in its input only).
- **The token at rest on the phone.** It sits in the tailnet origin's localStorage, and it is stable. A lost phone that is still on the tailnet can open the socket. Unlocking is server-wide: **a window opened on the desktop also lets the phone sign, and the other way round.** `--new-token` unpairs every device; removing the phone from the tailnet cuts it off.
- **The pairing link on another device.** The fragment is still never sent to any server, `tailscale serve` included, and the page still replaces it in its history entry. What is new is the way the link travels to the phone. A QR code shown in the terminal never leaves the two screens. A link sent to yourself stays in that service's history (and in any synced clipboard) with a token that does not expire. A QR scanner app may keep a history too.
- **Clickjacking.** A page served by nod itself could be framed by another page on the phone. The proof of concept sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`.

## A tab the phone suspended

- `NodClient` reconnects only on a `close` event, with backoff (0.5 s doubling to 10 s, reset by every `welcome`). It does not listen to `visibilitychange`, `pageshow` or `online`, and it has no heartbeat of its own.
- If the phone's OS closed the connection while the tab slept, the `close` event arrives when the tab wakes, and result 7 says what follows: open again within a few seconds. If the connection is dead without a `close` (a half-open TCP connection after a network change), the page shows "open" on a dead socket until a request times out (60 s) or TCP gives up.
- So: it reconnects, though not on purpose and not always quickly. The feature needs a wake check: on becoming visible, or `online`, send a cheap request with a short timeout (a few seconds); if it does not answer, drop the socket and connect at once with the backoff reset. Also a server-side idle timeout with pings, so dead sockets go away.

## What the real implementation needs

- **CLI**: `--allow-host <name[:port]>` (one name, https only, no IP literals, no loopback names: `named-host.ts`), and the web app served on that name only (`static-files.ts`: no path out of the root, the SPA fallback, no framing, no referrer). A second printed link for the other device, and a **QR code** of it in the terminal. A config file entry, so the flag does not have to be repeated.
- **Package**: `scripts/build-release.ts` stages the built web app (built with base `/`, about 860 KB in 15 files, about 150 KB of gzipped JS) as `web/`, and the default `--web-dir` points at it. The smoke test checks it is there, and the "the web app was staged" guard is changed to keep `src/web/` out while letting the build in. The web app served this way is the CLI's own version, so it always speaks the CLI's protocol.
- **Client**: `isAllowedHost(host, page)` replaces `isLoopbackHost` in the pairing (done in the proof of concept). Plain `ws://` stays loopback-only; `wss://` is allowed only to the page's own https host.
- **Deep links**: a page paired with a named host remembers it on the hosted origin too (the hosted page's localStorage: "this browser's nod is at `https://<machine>.<tailnet>.ts.net:<port>`"). The hosted page then forwards a deep link to it with a top-level navigation, and the link landing offers that when it cannot pair. Without this, a GitHub notification opens the hosted UI, which is not paired on the phone.
- **Reconnect**: the wake check above, with tests in `connection.test.ts`.
- **Guards**: unchanged for the default. With the flag, the allow-list gets exactly the named origin and the Host check exactly the name (proved in `server.test.ts`).
- **Docs**: a page in `site/content/docs/` for "on your phone" (tailscale serve, the flag, the QR code, what it changes for security), `security.md`, glossary terms (tailnet, named host), `docs/concept.md`'s "talks to `nod serve` over loopback" line, and the epic's ADR.

## What the ADR must decide

1. The named host as a security boundary: one name or several; whether to check `Tailscale-User-Login` against the `gh` login's owner (useful against other tailnet users, worthless against local processes, absent for tagged devices).
2. Per-device tokens instead of one stable token: unpair a lost phone without unpairing the desktop, and maybe a shorter life for a phone's token.
3. Unlock scope: server-wide as today, or per client (the phone signs only in a window opened on the phone). Per client is safer once more than one device is paired.
4. The UI version: the served web app is the CLI's (B), while the hosted one follows the release channel; both speak the CLI's protocol.
5. How the link reaches the phone: a QR code in the terminal (a dependency for `nod serve`, not for the kit), with a warning against sending it through a chat.
6. Whether plain-http LAN access is ever allowed: the proposal is no. TLS comes from the proxy, `ws://` stays loopback.

## Decided in this spike

- `--allow-host` takes one name; an IP literal is refused (a certificate names a host), and so is a loopback name.
- The web app is served only on the named host, not on loopback: with no flag, nothing changes (a test proves it).
- The proof of concept serves a checkout's `dist/web`; packaging it is left to the implementation.
- The reconnect, the QR code, the deep-link forwarding and the phone layout are not in the proof of concept.

## To confirm on a real phone

Android Chrome and iOS Safari, Tailscale on, the phone on the same tailnet:

1. On the machine: `bun run build`, `tailscale serve --bg --https=8445 http://127.0.0.1:4561`, `bun src/cli.ts serve --fake --port 4561 --token-file /tmp/nod-phone-token --allow-host <machine>.<tailnet>.ts.net:8445`.
2. Get the "on another device" link onto the phone without a chat (show it as a QR code with any local tool, or type it). Open it, and check that the dashboard loads with no prompt (with Android "secure DNS" on and off).
3. Sign one PR (any passphrase but `wrong`), then lock the phone for 2 minutes, unlock it and see whether the tab is connected again within a few seconds.
4. From the hosted UI's address (`https://ui.nod.frebreco.de/next/`), tap a link to `https://<machine>.<tailnet>.ts.net:8445/#/pr/tallyho/fieldbook/7`: it opens without a prompt.
5. Afterwards: `tailscale serve --https=8445 off`.
