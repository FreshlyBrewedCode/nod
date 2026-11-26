---
title: On your phone
description: Reach nod serve from a phone on your tailnet, through tailscale serve and a named host.
section: Using nod
order: 4
---

> **Not released.** `--allow-host` is on `main`, so in the pre-release `@frebreco/nod@next`, not in
> a stable release yet. Run it with `bunx @frebreco/nod@next serve …`, or from a checkout
> (`bun src/cli.ts serve …`, after `bun run build`). The phone layout and
> [link forwarding](#links-from-github) are not released either.

`nod serve` stays on your machine and keeps the signing key there. A phone reaches it over your
[tailnet](https://tailscale.com/kb/1136/tailnet), with `tailscale serve` in front: Tailscale
gives the machine an https name and a certificate, and passes the requests on to `nod serve` on
`127.0.0.1`. `nod serve --allow-host` names that **named host**, and serves the dashboard there
itself, so the page and its socket come from the same address.

## Set it up

Both devices need Tailscale, logged in to the same tailnet, with
[HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) turned on for it.

1. Put `tailscale serve` in front of the port, on an https port of your choice. It runs in the
   background until you turn it off:

   ```sh
   tailscale serve --bg --https=8445 http://127.0.0.1:4518
   ```

   `tailscale serve status` shows the name it serves, `https://<machine>.<tailnet>.ts.net:8445`.

2. Start `nod serve` with that name and port. In a checkout, build the dashboard first:

   ```sh
   bun run build
   bun src/cli.ts serve --allow-host <machine>.<tailnet>.ts.net:8445
   ```

3. `nod serve` prints the usual host link for this machine, then a second one,
   the **device link**, and the same link as a QR code. Scan the code with the phone's camera and
   open the link. The dashboard loads from the named host, pairs, and drops the token from the
   address bar.

4. When you are done: `tailscale serve --https=8445 off`.

Without `--allow-host`, nothing of this exists: `nod serve` answers on loopback only and serves
no page.

The flag is not kept anywhere; give it every time you start `nod serve`.

## What the other device gets

The named host is a side of its own:

- **Its own token**, the **remote token**. It is not the one in the host link, and neither opens
  the other side. It is kept next to the host link's, in `$XDG_CONFIG_HOME/nod/serve-token-remote`.
- **Its own unlock.** Unlocking on your machine does not let the phone sign, and unlocking on the
  phone does not let your machine sign. Each side shows its own lock: the phone says "locked"
  while your machine is unlocked.
- **The dashboard of this very `nod serve`**: the same version, always. It pairs only with the
  named host, never with the phone's own `127.0.0.1`.

## On the home screen

The dashboard can be added to the phone's home screen (in the browser's menu: "Add to Home
screen", or Share, then "Add to Home Screen" on an iPhone). It then opens as a **home-screen app**,
without the browser's bars, with nod's icon. It is the same page on the same named host; there is
no offline mode, and it needs `nod serve` running as before.

- **Android (Chrome):** the app shares the browser's storage, so the pairing you made in the
  browser carries over.
- **iPhone (Safari):** a home-screen app keeps its own storage, apart from Safari's, so it starts
  unpaired, and a scanned QR code opens in Safari, not in the app. The app's page has a field to
  paste the device link instead: copy the link `nod serve` prints (from the terminal, or with a
  scanner that copies rather than opens) and paste it there. Do not send it through a chat.
  Links from GitHub open in Safari, so pair Safari as well if you want them to work.

## Links from GitHub

Links in pull request comments and GitHub notifications point at the
[hosted web app](/docs/status), `ui.nod.frebreco.de`. On your phone that page is not paired, and
cannot be: your nod on the phone is the named host's page. So the hosted web app hands a link over
to the named host, once you have told that browser where your nod is.

1. On the phone, in your nod on the named host, open the menu behind your avatar and tap
   **Open links from GitHub here**. Do it in the browser your links open in (on an iPhone,
   Safari).
2. The hosted web app opens a page that shows the address in large type,
   `https://<machine>.<tailnet>.ts.net:8445`. If it is your machine's, tap
   **Remember this address**; it takes a tap after the page has been in front of you for a
   second. "Don't remember" is the default, and leaving the page remembers nothing.
3. From then on, a link opened in that browser shows the pull request and
   **Open on `<machine>.<tailnet>.ts.net:8445`**. Tap it to open the pull request in your nod.

- **One tap per link**, never on its own, so the address is in front of you every time. If it is
  not your machine's, tap **Forget this address**.
- The link carries only the pull request's address in nod, never a token. If the named host's
  page is not paired yet, it remembers the link and says how to pair; the device link then
  lands on the pull request.
- A browser that is paired with `nod serve` on your machine, such as your desktop's, keeps opening
  links there and never forwards.
- Link forwarding is not released: it is on `ui.nod.frebreco.de/next`, but links in comments
  open the root, `ui.nod.frebreco.de`, which forwards from the next stable release on. A
  pre-release's **Open links from GitHub here** confirms the address on `/next`; both share one
  origin, so the address it remembers is the one the root uses then. Until then, open the named
  host directly: bookmark it on the phone.

## A locked phone

When the phone wakes the tab, or its network comes back, the page checks the connection, and
reconnects on its own within a few seconds if it is dead; the dashboard stays as it was
meanwhile. A signing that was cut off says that it may have gone through: look for the nod on
the PRs before you sign again.

## A lost phone

Start `nod serve` with `--new-remote-token`. The phone's pairing stops working; your machine's
browser stays paired. Pair the phone again by scanning the new code. `--new-token` replaces both
tokens. Removing the phone from the tailnet cuts it off as well.

## What changes for security

- **Who can try to connect.** Before, only programs on your machine. Now also every device and
  person your tailnet's access rules let reach that port, shared machines included. They still
  need the remote token. Use `tailscale serve`, never Funnel: Funnel puts the name on the
  internet.
- **The passphrase crosses the network.** It travels under TLS from the phone to Tailscale on
  your machine, inside Tailscale's encrypted tunnel, and in plain text only on your machine's
  loopback, as before. It is never stored on the phone.
- **The token is stored on the phone**, in the named host's browser storage, and does not
  expire. Lock the phone's screen as you would for a password manager.
- **Scan, do not send.** A device link sent through a chat or to yourself stays in that
  service's history, and in any synced clipboard, with a token that does not expire. A QR code
  never leaves the two screens.
- **The name is public.** Tailscale's certificates put the machine and tailnet names in a public
  certificate log.
- **No plain http.** The named host is https only, and a page served over plain http can pair
  with loopback only. A LAN address over `http://` would send the passphrase in clear.

[Security and limits](/docs/security#another-device) has the rest.
