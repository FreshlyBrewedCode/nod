---
title: In the background
description: Run nod serve without a terminal, as a systemd user unit or a macOS LaunchAgent.
section: Using nod
order: 5
---

> **Not released.** `nod service` is on `main`, so in the pre-release `@frebreco/nod@next`, not in
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
wherever it started, and a `nod repo add` is picked up while it runs. It gets the `PATH` you installed with, so it finds `gh`
and `git`, and `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `GH_CONFIG_DIR` and `NOD_WEB_URL` if you set
them. A token in your environment is never copied into the unit: `gh` keeps its own login.

## Pair a browser

The service prints the host link like `nod serve` does, into the journal
(`journalctl --user -u nod.service`) or the log file on macOS. The link is the same one every time,
since the pairing token is kept in `$XDG_CONFIG_HOME/nod/serve-token`.

## Look, change, remove

```sh
nod service status      # not installed, installed but not running, or running; unit and command
nod service install …   # again, with other options: replaces the unit and restarts
nod service uninstall   # stop it and remove the unit
```

`--open` cannot be given to the service: it would open a browser at every start. Do not also run
`nod serve` on the same port while the service runs.

See the [CLI reference](/docs/cli#nod-service) for the commands.
