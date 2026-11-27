---
title: Updates
description: "How nod tells you about an update, shows its release notes and installs it on your click; the stable and next channels."
section: Using nod
order: 7
---

> **Not released.** Updates from the page are on `main`, so in the pre-release
> `@frebreco/nod@next`, not in a stable release yet. They have been tried against a fake release
> feed, a fake package manager and a fake service only (`nod serve --fake`), never as a real
> install. A checkout of nod never installs anything: it updates with `git pull`.

`nod serve` looks at the releases of nod on GitHub about every 10 minutes, and when you click
**Check now** in [Settings → Server](/docs/settings#server). When the [channel](#the-channel)
you follow has another version than the one running, the top bar shows a pill: **Update 0.3.0**,
with a dot. On a phone it says **Update**. It leads to Settings → Server.

![The update in the top bar](./screenshots/update-pill.webp)

## Installing takes a click

Nothing is installed by itself: the update is the code that will hold your
[signing key](/docs/keys), so it runs only when you ask.

1. Settings → Server shows the update's [release notes](#release-notes) and **Update to 0.3.0**.
2. A click asks once more, and shows the command nod will run, such as
   `npm install -g @frebreco/nod@0.3.0`. **Install 0.3.0** runs it.
3. While it runs, the pill and the page say **Updating to 0.3.0…**.
4. Then:
   - when `nod serve` runs as a [service](/docs/background), the service restarts it. The page
     reconnects by itself, now to 0.3.0, and loads the new version of the app once. The pill says
     **Updated to 0.3.0** until you open Settings → Server;
   - when you started `nod serve` in a terminal, it cannot restart itself. The pill says
     **Restart to finish**, and the page shows the command to start it again: stop it with Ctrl-C
     and run that command.

If the install fails, nothing changes: the page shows what the package manager said, and the
command to run by hand.

nod installs with the package manager it was installed with: npm, bun, pnpm or yarn, which it
reads from where it is installed. When it cannot tell (a `bunx` run, Windows), it installs
nothing and shows the commands for npm and bun to run yourself.

## The channel

- **Stable** follows the releases, npm's `latest` tag: tried for longer, fewer of them.
- **Next** follows every change merged to `main`, npm's `next` tag: sooner, less tried.

A stable release follows stable, a `-next` build follows next, until you choose in Settings →
Server. The choice is kept in `$XDG_CONFIG_HOME/nod/config.json`. Switching checks the other
channel at once and shows what it has; it installs nothing until you click. Going from next back
to stable can offer an older version, shown as **Switch to 0.3.0**: installing it goes back, and
your key and settings stay as they are.

## Release notes

The notes are the ones on the release's GitHub page, shown as text with headings, lists, links,
code, bold and italics. Nothing in them runs: HTML stays text, and only `http` and `https` links
are links, opened in a new tab.

## From another device

On the page of another device (a [named host](/docs/phone)) the pill and the notes show, but
installing an update, the channel and the service are changed only on the machine `nod serve`
runs on. The page says so.

## Try it

`nod serve --fake` plays a `0.2.0` with `0.3.0` on offer, a fake package manager that takes a few
seconds, and a fake service. The flags `--fake-update`, `--fake-service` and `--fake-install`
choose other states; see the [CLI reference](/docs/cli#nod-serve).
