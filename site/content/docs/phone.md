---
title: On your phone
description: Reach nod serve from a phone on your tailnet, through tailscale serve and a named host.
section: Using nod
order: 4
---

> **Not released.** `--allow-host` is on `main` and not in a published package yet. Run it from a
> checkout (`bun src/cli.ts serve …`), after `bun run build`. The phone layout and opening a deep
> link from a GitHub notification on the phone are not built yet.

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
