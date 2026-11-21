# 0005: Another device reaches `nod serve` through one named host, same origin

Status: accepted (2026-11-21). Replaces the concept's "It talks to `nod serve` over loopback" (Architecture, Web app) and extends canvas ADR 0001's host-link guards as `src/server/server.ts` applies them. Evidence: [finding 04](../findings/04-phone-reach.md). Epic #30.

## Context

A phone cannot reach `nod serve`: it binds `127.0.0.1`, its Host check allows loopback names only, and the web client refuses any socket that is not loopback. The epic wants a phone on a private network, first a tailnet with `tailscale serve` in front (TLS, so `wss`), to read a brief and sign.

Finding 04 compared two shapes. **A**, the hosted UI opening `wss://<machine>.<tailnet>.ts.net` from `ui.nod.frebreco.de`, is blocked by Chrome's Local Network Access unless the user grants a permission whose prompt reads "connect to any device on your local network", and nobody knows what Android Chrome or Safari do. **B**, `nod serve` serving the web app itself on the tailnet name, is same-origin and needs no permission anywhere. B also lets the client keep a tight rule: a page may pair with loopback, or with the very https host that served it.

This changes the threat model: the pairing token and the passphrase now cross a network, and the server answers to a name that is not loopback.

## Decision

1. **Same origin, one named host.** `nod serve --allow-host <name[:port]>` (`src/server/named-host.ts`) names the TLS proxy in front of the loopback port, e.g. `tailscale serve --bg --https=8445 http://127.0.0.1:4518` and `--allow-host <machine>.<tailnet>.ts.net:8445`.
   - Exactly one name. It is a DNS name with a domain: no IP literal (a certificate names a host), no loopback name, no wildcard, no scheme or path.
   - The server keeps binding `127.0.0.1`. Only the proxy, and local processes, reach it.
   - On that name, and only there, it serves the built web app (`src/server/static-files.ts`): no path out of the root, `index.html` for every other path, and no framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), no sniffing, no referrer. Loopback still serves no page.
   - The Host check allows loopback and that name, nothing else. The origin allow-list is per side: a request whose Host is the named host may come only from `https://<name[:port]>`; a loopback request only from the hosted UI and the dev server, as before. So with the flag, the named side's allow-list is exactly the named origin.
   - Without the flag, nothing changes; a test proves it.
   - **Not now: a `Tailscale-User-Login` check.** `tailscale serve` adds it for tailnet users, and comparing it with the `gh` login's owner would keep other people on the tailnet out. But any local process can send the header straight to the loopback port, tagged devices have none, and Funnel requests have none. It guards against other tailnet users only, who also need the token. It is the first candidate for a later addition, behind the same flag.
   - **Not now: several names.** One phone on one tailnet is the epic's case. A list would multiply the origins a token opens for no user who has asked for it.

2. **A token per side.** The named host has its own pairing token, separate from the loopback one and stored next to it: `$XDG_CONFIG_HOME/nod/serve-token-remote`, or `<--token-file>-remote` when `--token-file` is given, so tests and experiments never touch the real one. A socket is let in only with its side's token: the loopback token does not open the named host, and the remote token does not open loopback (`CLOSE_BAD_TOKEN` either way). The side is the Host header's, and Host, origin and token must all agree.
   - Why: a lost phone is unpaired by renewing its token, without unpairing the desktop. `--new-remote-token` renews only the named host's token; `--new-token` renews both, as it always meant "every paired browser pairs again".
   - The remote token lives as long as the loopback one does. A shorter life (a phone re-pairs every week) is left out: it adds a clock to pairing and nobody has asked for it; renewing is one flag and one QR scan.
   - Not per device: one token per side is enough to unpair "the phone". Per-device tokens would need a registry of devices, and a UI to list and revoke them, for a case (two phones) the epic does not have.

3. **The unlock window is per side.** Unlocking on a loopback connection does not let a named-host connection sign, and the other way round; locking ends only that side's window. Each client is told its own side's lock state (`signer` in `welcome` and every `signer` push), so the phone shows "locked" while the desktop is unlocked. The key itself is one: the decrypted key stays in memory while either side is unlocked and is dropped when both are locked; a second unlock checks the passphrase again and keeps the key it has. `UnlockWindow` (`src/server/signer.ts`) holds one window per side, not per socket: two tabs on the desktop share a window, as today.
   - Why: once two devices are paired, a window opened at the desk must not also arm the phone in a pocket, and a phone left unlocked on a table must not arm a page on the desktop. Per side is the smallest rule that gives that, and it matches the token classes, so it is the same boundary twice.
   - Not per socket: a reload, or a second tab, would lock the user out; and the signer would have to know about sockets.

4. **The served web app is the CLI's own build.** The npm package ships it (`scripts/build-release.ts` builds it with base `/` into the package's `web/`, and the smoke test checks it is there and loadable). The default `--web-dir` is the package's `web/`, and in a checkout `dist/web`; when it is missing, `nod serve --allow-host` stops with "run `bun run build`". So the page on the named host always speaks the CLI's protocol, whatever channel the hosted UI is on. The hosted UI is unchanged: it stays the desktop's, paired over loopback, following the CLI's release channel (`src/server/web-url.ts`).

5. **The device link, as a QR code.** With `--allow-host`, and only then, `nod serve` prints a second link for the other device and the same link as a QR code in the terminal, with one line: scan it, do not send it through a chat. A link sent to yourself stays in that service's history, and in any synced clipboard, with a token that does not expire; a QR code never leaves the two screens. The encoder is [`uqr`](https://github.com/unjs/uqr), a dependency of `nod serve` only: zero dependencies of its own, one small ES module, maintained by the unjs project, and it renders to Unicode half blocks. Writing an encoder (Reed–Solomon, masks, version tables) would be several hundred lines of code nobody reviews for a feature whose failure mode is a code that does not scan. The kit stays dependency-free; `uqr` is imported only by `src/server/qr.ts`, and only when the flag is given.

6. **No plain-http access from another device, ever.** TLS comes from the proxy. The named origin is `https://` only, the client accepts `wss://` only to the https host that served it, and `ws://` stays loopback-only. A LAN address over `http://` would send the token and the passphrase in clear over Wi-Fi.

7. **Deep links on the phone: the design, built later.** A GitHub notification opens the hosted UI's `#/pr/<owner>/<repo>/<n>`, which is not paired on the phone. The hosted page cannot read the named host's storage, and it cannot even reach it (Local Network Access, above). So the hosted origin has to be told where this browser's nod is, and that is the risk: whoever can set that remembered host can forward the user to a page that asks for the passphrase. The design:
   - **How the hosted origin learns the host.** Only from a top-level navigation to `https://ui.nod.frebreco.de/#/forward?to=https://<name[:port]>`, which the named host's page starts from a button the user taps there ("Open nod links on this phone here"). The value is checked as `--allow-host` checks it: https, a DNS name, an optional port, no path, no IP literal.
   - **What the user confirms, and when.** Nothing is stored on arrival. The hosted page shows a full page with the name in large type: "Open nod links in this browser at `<machine>.<tailnet>.ts.net:8445`? Only do this if you tapped the button on your own nod a moment ago." Yes stores `{ to, since }` in the hosted origin's localStorage; No, or leaving, stores nothing. Anyone can craft such a link, so this confirmation is the guard, the same way the host link's pairing is.
   - **What the hosted page shows before it forwards.** A deep link on a hosted page that is not paired and has a remembered host shows a calm landing: the PR it is for ("#7 in tallyho/fieldbook"), "Open in your nod at `<name>`", a button, and "Forget this host". It forwards on the tap, by a top-level navigation to `https://<name>/#/pr/<owner>/<repo>/<n>`, rebuilt from the parsed route (`lib/deep-link.ts`), never from the raw fragment, and never carrying a token. No silent forward: one tap per link keeps the remembered name in front of the user every time, which is what makes a wrongly remembered host noticeable. A paired hosted page (the desktop) never forwards.
   - **Rejected:** remembering on pairing without a confirmation (any page can navigate to the hosted UI with a crafted value); allowing only `*.ts.net` (Funnel makes such names public, so it proves nothing); `registerProtocolHandler` (not on Android Chrome or iOS Safari); a silent forward (a planted host would never be seen again).
   - The follow-up PR builds this together with the reconnect on wake (finding 04, "A tab the phone suspended").

8. **No config file.** `nod serve` has no config mechanism today; the flag is repeated. A config entry for it waits for the first config file.

## Consequences

- Who can try to connect grows from the machine's processes to every device and user the tailnet's ACLs let reach that port, shared nodes included. The token is still what lets a client in; the tailnet only narrows who can try. `tailscale serve`, not Funnel: Funnel would put the name on the internet, and nothing here guards against that beyond the token.
- The passphrase travels under TLS from the phone to `tailscaled`, inside WireGuard, and in plain HTTP only on the machine's loopback, as before. It is never stored on the phone.
- The remote token sits in the named origin's localStorage on the phone. A lost phone that is still on the tailnet can open the socket until `--new-remote-token`, or until the phone leaves the tailnet; with a per-side window it cannot sign in a window opened at the desk.
- `tailscale serve`'s HTTPS certificate puts the machine and tailnet names in a public certificate log. The docs say so.
- The package grows by the built web app (about 860 KB in 15 files) and one dependency.
- The deep-link forward and the reconnect on wake are not built: until then, the phone opens nod from the device link or a bookmark of the named host.
- What only a real phone can confirm (Android "secure DNS" and MagicDNS, iOS Safari's local network rules, a frozen tab) is listed in finding 04.
