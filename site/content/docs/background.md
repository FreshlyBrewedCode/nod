---
title: In the background
description: Run nod serve without a terminal, as a systemd user unit or a macOS LaunchAgent.
section: Using nod
order: 5
---

> **Not released.** `nod service` and its part of Settings → Server are on `main`, so in the pre-release `@frebreco/nod@next`, not in
> a stable release yet. It has been tested against fake `systemctl` and `launchctl` only, never on
> a real one. Run it with `bunx @frebreco/nod@next service …`, or from a checkout
> (`bun src/cli.ts service …`).

`nod serve` is a program in a terminal: close the terminal and the dashboard has nothing to talk
to. `nod service` makes it a **service** instead, run by your system: started at login, restarted
when it fails, with no terminal.

## Set it up

Run it where you would run `nod serve`, with the options you would give `nod serve`:

```sh
nod service install --poll 30
```

- **Linux** gets a systemd user unit, `~/.config/systemd/user/nod.service`, enabled and started
  with `systemctl --user`. To keep it running when you are logged out, once:
  `loginctl enable-linger`.
- **macOS** gets a LaunchAgent, `~/Library/LaunchAgents/de.frebreco.nod.plist`, loaded into your
  login session with `launchctl`. Its output goes to `~/Library/Logs/nod/nod.log`.
- **Windows** is not supported yet.

The service runs the nod that installed it: the same Bun and the same files, by their absolute
paths, so install it from a checkout or a global install, not from a `bunx` run, whose cache is
cleaned up (nod warns if it looks like one). It starts in the folder you installed from, which
matters only while the [repo list](/docs/cli#nod-repo) is empty: then that folder, if it is a
clone, is the one repository it reads, as with `nod serve`. With a repo list it reads the list,
wherever it started, and a `nod repo add` is picked up while it runs.

## What the service gets

A service does not start from your terminal, so it does not get your shell's environment. It
gets what you installed it with, written into the unit:

- the `PATH`, and `NOD_GH`, the absolute path of the `gh` that `PATH` finds: the service runs
  that `gh`, and finds `git` on the same `PATH`;
- `HOME`, and `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `GH_CONFIG_DIR` and `NOD_WEB_URL` if you set
  them;
- a proxy (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) and extra CA certificates (`SSL_CERT_FILE`,
  `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`) if you set them, but not a proxy address with a password
  in it;
- `NOD_SERVICE=1`, so its pages know they talk to the service.

A token in your environment (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`) is never copied
into the unit: it would sit in a file on disk. The service reads GitHub with the login `gh` keeps
itself (`gh auth login`), in its config or the system's keyring.

Before it installs anything, `nod service install` runs `gh auth token` the way the service will,
for each host of the repo list (github.com with an empty list), and warns when the service would
not be signed in: no `gh` on that `PATH`, no `git`, or a `gh` that is logged in only through
`GH_TOKEN` in your shell. **Run nod in the background** checks the same and, rather than hand the
port to a service that could not read GitHub, does not set it up and says why.

## From the page

When `nod serve` runs in a terminal, [Settings → Server](/docs/settings#server) offers
**Run nod in the background**. It sets the service up as `nod service install` would, with the
options that `nod serve` was started with (not `--open`, `--new-token` or `--new-remote-token`,
which would repeat at every start), and shows them before you click.

Then that `nod serve` hands over: it stops by itself, so the service can take its port, and the
terminal says so. The service, which could not start while the port was taken, starts on its next
try a few seconds later. The page stays paired (the same token file) and reconnects to it by itself.

From then on an [update](/docs/updates) restarts nod through the service: no terminal needed. The
section also shows the service's unit file, the command it runs and where its output goes, what it
sees of GitHub (the `gh` it runs and its login), and **Remove the service…** stops and removes it.
These buttons are only on this machine's page, never on another device's.

## When the page says "Sign in"

The service's `nod serve` reads GitHub with what its own environment finds, which can differ from
your terminal. Its page says which of three it is, names the host, and says what to do:

- **nod can't find gh**: no `gh` on the service's `PATH`. Run `nod service install` again in a
  terminal where `gh auth status` works.
- **Sign in to GitHub** (or to your host): `gh` is there, but not logged in for the service. If
  `gh auth status` in your terminal works through `GH_TOKEN`, the service does not get it: run
  `gh auth login`, then `nod service install` again. On Linux, `gh` may keep its login in the
  keyring, which a service reaches only while your login session has unlocked it.
- **Can't reach GitHub yet**: `gh` has a login, GitHub did not answer, for example right after
  login before the network is up, or behind a proxy the service was not given.

In each case `nod serve` looks again every 15 seconds and the page moves on by itself once it is
signed in; **Try again** looks at once. No restart is needed. `nod service status` and
Settings → Server show what the service sees, and its log (below) has a line for each change.

## Pair a browser

The service prints the host link like `nod serve` does, into the journal
(`journalctl --user -u nod.service`) or the log file on macOS. The link is the same one every time,
since the pairing token is kept in `$XDG_CONFIG_HOME/nod/serve-token`.

## Look, change, remove

```sh
nod service status      # not installed, installed but not running, or running; unit, command,
                        # the gh it runs and, while it runs, what it sees of GitHub
nod service install …   # again, with other options: replaces the unit and restarts
nod service uninstall   # stop it and remove the unit
```

`--open` cannot be given to the service: it would open a browser at every start. Do not also run
`nod serve` on the same port while the service runs.

See the [CLI reference](/docs/cli#nod-service) for the commands.
