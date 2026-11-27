---
title: Security and limits
description: What nod guards against, what it does not, and the settings that make the difference.
section: Your repository
order: 4
---

> **nod is a prototype.** In its current form it guards against mistakes and unattended merges.
> It does not stop an agent that sets out to get around it. This page says exactly where the
> gaps are.

## The trust model

nod assumes this setting: coding agents run on your machine, as your user, with your `gh` login
and often your git credentials. They are not malicious, but they are fast, numerous, and
sometimes wrong, and nobody watches every step.

Against that, nod places three things:

1. **A signing key the agents don't have.** It is encrypted with a passphrase only you know, and
   a nod is a signature by that key. [Signing keys](/docs/keys)
2. **A trust root the agents cannot change alone.** The list of keys, the policy and the
   verifier live under `.nod/` in your repository, and every change there needs a peer nod. A
   GitHub approval is not enough there.
3. **A required check.** Once [enforced](/docs/verifier#enforced-or-not), GitHub refuses to merge
   until the verifier's `nod` check is green, and the ruleset has an empty bypass list. Before
   that, nod shows what each pull request needs and blocks nothing.

## What nod guards against

- **An unattended merge.** A pull request that the policy says needs a human does not merge
  until a human nodded it.
- **A replayed or forged nod.** A nod pasted from another pull request, a nod for another
  repository, a nod with an edited payload, a nod that claims another reviewer, a nod signed in
  another namespace: all are rejected. The signature covers the payload, and the payload names
  the repository, the pull request, its base and its content.
- **Content changing after the nod.** A nod is bound to the head commit or the patch-id. New
  content needs a new nod. Retargeting a pull request to another base drops the nod.
- **A pull request lowering its own bar.** The policy, the classifiers' trusted inputs and the
  allowed signers are read from the default branch, never from the pull request. A declared risk
  can only raise.
- **A self-registered key.** Keys are trusted from the repository file, not from the GitHub
  account, so the shared `gh` login cannot add one.
- **A hidden change in a huge pull request.** The file list comes from `git`, not from the files
  API with its 3,000-file cap.
- **A crashed verifier.** It fails closed: red, never green.
- **A neutral check where the check is required.** The verifier concludes `neutral` only when
  GitHub clearly says the base branch does not require `nod`; any doubt counts as enforced. When
  enforcement is switched on, `nod init --ruleset` re-runs the verifier on pull requests whose
  check is still neutral (not released).
- **A link that approves.** Deep links only open views.

## What nod does not guard against

### The forgeable check

In v1 the `nod` check is created by the workflow's own token, so it comes from the GitHub Actions
app, like every workflow's checks. **Anyone who can push a workflow file to any branch can create
a green check named `nod` from the same app.** GitHub cannot tell the two apart, and neither can
a ruleset pinned to that app. With auto-merge armed, the pull request then merges.

This was tested: a forged check merged a pull request under an active ruleset within seconds.

So in this mode nod is not a boundary against an agent that deliberately pushes a forging
workflow. The fix is planned and not built: a GitHub App registration that you own, with no
server behind it, whose key only the default branch's workflow can use. The ruleset then pins the
check to that app. See [Status](/docs/status#not-built).

### Approvals

> **Not released.** In a stable release, only nods count.

A GitHub [approval](/docs/policy#approvals) fills a slot like a nod. Approvals are made with a
`gh` login, and agents run with yours: **an agent holding your login can approve a teammate's
pull request as you.** That is what it can do on GitHub without nod, too, and it stays within
what nod promises in this mode: it guards against mistakes and unattended merges, not against an
agent that sets out to misuse your login. Approvals of your own pull requests are impossible on
GitHub, so an agent cannot approve its own work as you.

Where that is not good enough, ask for a nod only: `peer({ approvals: false })`. A nod needs your
signing key, which agents don't have. Changes to `.nod/**` and `.github/workflows/**` always ask
for a nod only.

### Owner and admin tokens

A token with admin rights on the repository can change or delete the ruleset, which is the same
as merging with `--admin`. If your agents use such a token, the gate is theirs to open.

### Other ways around it

- **Your SSH key.** A `gh` token without the `workflow` scope cannot add workflow files through
  the API, but a push over SSH with your key can.
- **A CI workflow with `checks: write`.** Any workflow that runs branch code with that
  permission can create a `nod` check.

### Passphrase mode

The signing key is unlocked with a passphrase, into the memory of `nod serve`, for a window of
15 minutes or for one signature.

- While signing is unlocked, an agent running as your user could drive your browser, or attach a
  debugger to `nod serve` and read the key. Whether the second works depends on the operating
  system.
- Any process of your user can copy the key file and guess passphrases offline. scrypt makes each
  guess cost 128 MiB and a fraction of a second. A weak passphrase does not survive that.
- An agent could replace the key file with a key of its own. That key is not enrolled; enrolling
  it is a pull request under `.nod/`, which a peer must nod.

So passphrase mode guards against mistakes more than against a determined agent. Signing methods
that confirm each signature outside the process, such as Touch ID or 1Password through an SSH
agent, close the first gap. They are planned and not built.

## Recommended agent settings

These close most of the gaps above without any change to nod.

- Give agents a token **without the `workflow` scope**. With fine-grained tokens: without the
  Administration and Workflows permissions.
- Give agents **no SSH key that can push**. Let them push over HTTPS with that token.
- In the agents' instructions, forbid `gh pr merge --admin`, changes to `.github/workflows/**`,
  and approving pull requests.
- Keep the repository's default workflow token permission at read, and give no workflow that
  runs branch code `checks: write`.
- Prefer **just this once** when you unlock, or lock from the chip when you are done.
- Keep the host link to yourself. While signing is unlocked, a page with that link can sign.
- Scan the device link from the terminal; do not send it through a chat.
- Remember an address on the hosted web app only right after you tapped **Open links from GitHub
  here** in your own nod, and check that it is your machine's.

## The local server

`nod serve` listens on `127.0.0.1` only. It has one WebSocket, guarded by a pairing token and an
origin check: of the pages in a browser, only the web app's and the local dev server's may connect.
A program that is not a browser page sends no origin; it is let in with the token. It answers only
requests that name `127.0.0.1`, `localhost` or `[::1]`, so a page that rebinds its own name to
your machine gets nothing. The token is in the link `nod serve` prints and is kept in
`$XDG_CONFIG_HOME/nod/serve-token`; `--new-token` replaces it. The passphrase is sent over that
socket once per unlock and is never logged.

### The app

Not released. `nod serve` also serves the [app](/docs/app), the built web app, at
`http://127.0.0.1:<port>/`, and lets that one address open the socket, with the same token. The
name check above comes before anything else, so a rebinding page gets no page either. A page asked
for on `localhost` or `[::1]` is sent to `127.0.0.1`, and only `http://127.0.0.1:<port>` counts as
the app: a page on `localhost` could come from another program listening there. The files are
served from the built app's folder only, never inside another page's frame. The service worker
keeps only the files of the app's version, never a response to a request that carries the token,
and the token itself is in the part of the address a browser never sends. On a page that is not
paired, the hosted web app offers to open a link in the app at `http://127.0.0.1:4518`: an address
it chose, not one a link names, and the link carries no token.

### Updates and the service

Not released. `nod serve` looks for a new release on GitHub about every 10 minutes, without a
token. It never installs one by itself: an [update](/docs/updates) is the code that will hold
your signing key, so it installs only when you click **Update** in Settings → Server and confirm,
with the command shown before it runs (an argument list, never a shell, and only a version
number). The release notes are shown as text: HTML in them stays text, and only `http` and
`https` links are links.

Installing an update, choosing the channel and setting up or removing the
[service](/docs/background) change what runs on your machine, so only this machine's own page may
ask for them: `nod serve` refuses them from the named host's side below, whatever that page
sends, and its page does not offer them. Neither does it get the other device's QR code, which
carries that device's token: only this machine's page shows it.

### Another device

With `--allow-host` (not released), `nod serve` also answers to one
[named host](/docs/phone), the name `tailscale serve` gives it on your tailnet, and serves the
dashboard there. It still listens on `127.0.0.1`; only the proxy, and programs on your machine,
reach it.

- The named host is a side of its own. Its socket takes the remote token, from a page on the
  named host or from a program that sends no origin; loopback takes the host link's token, from
  the web app's pages or from a program that sends no origin. Neither token opens the other side.
- A request that came through the proxy is never loopback's, whatever host it names: it gets
  the named host or nothing. `tailscale serve` marks every request it forwards, and a device on
  the tailnet cannot remove the mark.
- The dashboard on the named host pairs only with the named host, so a link cannot point it at
  the phone's own `127.0.0.1`.
- Each side has its own unlock: a window opened at your desk does not let the phone sign, and
  the other way round. Each side checks one passphrase at a time, and a wrong one waits a second,
  so wrong guesses on the phone do not hold up an unlock at your desk.
- Who can try to connect grows to every device and person your tailnet lets reach that port.
  The remote token is what keeps them out. Use `tailscale serve`, not Funnel, which would put the
  name on the internet.
- The passphrase crosses the network under TLS and inside Tailscale's tunnel; it is in plain text
  only on loopback, as before. There is no plain-http access from another device.
- The remote token is stored on the phone and does not expire. `--new-remote-token` unpairs the
  phone and leaves your machine paired.
- The dashboard on the named host cannot be framed by another page. The hosted web app's host
  sends no header that forbids framing, so the web app itself refuses to run inside another page.
- **Links from GitHub** (not released). The hosted web app forwards a deep link to the named
  host only after you confirmed that host, in that browser, on a page that shows it in full, and
  then one tap per link. Anyone can make a link that asks it to remember another address, and a
  page there could ask for your passphrase: the page says so, its default is not to remember, and
  it takes only an https host name (no IP address, no loopback, no path). Its remember button
  takes a tap only after the page has been visible for a second, and a page that names another
  address starts over, so a tap aimed at the page before lands on nothing. After a tap it shows
  the address it stored. The address is shown on every forward; forget it there if it is not yours. A forward carries no token, and a browser
  paired with your machine never forwards. [Links from GitHub](/docs/phone#links-from-github)
- `tailscale serve` adds headers naming the tailnet user. nod does not check them yet: any
  program on your machine could send them, and tagged devices have none.

Your GitHub token comes from `gh auth token` and is sent only to your GitHub host's API.

## Reporting a problem

Open an issue on [GitHub](https://github.com/FreshlyBrewedCode/nod/issues). nod is a prototype
without a security process; do not rely on it where a bypass would be costly.
