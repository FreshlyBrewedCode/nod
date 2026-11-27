import { describe, expect, test } from "bun:test";

import type { AppState } from "../../shared/protocol";
import {
  UPDATED_MS,
  UPDATING_KEY,
  forgetUpdated,
  indicatorOf,
  noteUpdating,
  serverNeedsLook,
  serviceLine,
  updateLine,
  updatedOf,
  type KeyValue,
} from "./update";

const NOW = Date.UTC(2026, 10, 27, 9, 0);
const MIN = 60_000;

const RELEASE = {
  version: "0.3.0",
  publishedAt: NOW - 2 * 24 * 60 * MIN,
  notes: "## 0.3.0",
  url: "https://github.com/FreshlyBrewedCode/nod/releases/tag/v0.3.0",
  prerelease: false,
};

type Patch = {
  [K in keyof AppState]?: AppState[K] extends object ? Partial<AppState[K]> : AppState[K];
};

function app(patch: Patch = {}): AppState {
  const base: AppState = {
    version: "0.2.0",
    development: false,
    channel: "stable",
    update: {
      status: "available",
      latest: RELEASE,
      kind: "upgrade",
      checkedAt: NOW - 3 * MIN,
      nextCheckAt: NOW + 7 * MIN,
      error: null,
      installation: {
        status: "idle",
        version: null,
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      },
      after: null,
    },
    install: { method: "npm", command: "npm install -g @frebreco/nod@0.3.0", commands: [] },
    service: {
      state: "not-installed",
      manager: "systemd",
      unitPath: null,
      command: null,
      thisNod: false,
      args: [],
      logs: null,
      busy: null,
      error: null,
      handOver: false,
    },
    mayChange: true,
    otherDevice: null,
  };
  return {
    ...base,
    ...patch,
    update: { ...base.update, ...patch.update } as AppState["update"],
    install: { ...base.install, ...patch.install } as AppState["install"],
    service: { ...base.service, ...patch.service } as AppState["service"],
  } as AppState;
}

const installing = { status: "installing", version: "0.3.0", startedAt: NOW } as const;
const installed = {
  status: "installed",
  version: "0.3.0",
  startedAt: NOW,
  finishedAt: NOW,
} as const;
const full = (i: Partial<AppState["update"]["installation"]>) => ({
  ...app().update.installation,
  ...i,
});

describe("the indicator", () => {
  test("an update on offer: the version, with a dot", () => {
    expect(indicatorOf(app(), null)).toMatchObject({
      label: "Update 0.3.0",
      short: "Update",
      tone: "need",
      dot: true,
    });
    expect(serverNeedsLook(app())).toBe(true);
  });

  test("nothing to say: up to date, a development build, no state yet", () => {
    expect(indicatorOf(null, null)).toBeNull();
    expect(
      indicatorOf(app({ version: "0.3.0", update: { status: "up-to-date", kind: null } }), null),
    ).toBeNull();
    expect(
      indicatorOf(app({ version: null, development: true, update: { kind: null } }), null),
    ).toBeNull();
    expect(serverNeedsLook(app({ update: { kind: null } }))).toBe(false);
  });

  test("a downgrade after a switch to stable", () => {
    expect(
      indicatorOf(app({ version: "0.4.0-next.2", update: { kind: "downgrade" } }), null),
    ).toMatchObject({ label: "Switch to 0.3.0", tone: "need", dot: true });
  });

  test("while installing, and after it", () => {
    expect(indicatorOf(app({ update: { installation: full(installing) } }), null)).toMatchObject({
      label: "Updating to 0.3.0…",
      tone: "quiet",
      dot: false,
    });
    expect(
      indicatorOf(
        app({ update: { installation: full(installed), after: { state: "restarting" } } }),
        null,
      ),
    ).toMatchObject({ label: "Restarting…", tone: "quiet" });
    expect(
      indicatorOf(
        app({
          update: {
            installation: full(installed),
            after: { state: "restart-by-hand", command: "nod serve" },
          },
        }),
        null,
      ),
    ).toMatchObject({ label: "Restart to finish", tone: "need", dot: true });
    expect(
      indicatorOf(
        app({
          update: {
            installation: full(installed),
            after: { state: "restart-failed", error: "no" },
          },
        }),
        null,
      ),
    ).toMatchObject({ label: "Restart failed", tone: "bad" });
    expect(
      indicatorOf(
        app({ update: { installation: full({ status: "failed", error: "The install failed." }) } }),
        null,
      ),
    ).toMatchObject({ label: "Update failed", tone: "bad", title: "The install failed." });
  });

  test("updated: shown once the server runs the new version", () => {
    const now = app({ version: "0.3.0", update: { status: "up-to-date", kind: null } });
    expect(indicatorOf(now, { from: "0.2.0", to: "0.3.0" })).toMatchObject({
      label: "Updated to 0.3.0",
      tone: "ok",
      dot: false,
    });
    // An update on offer wins: there is something to do again.
    expect(indicatorOf(app(), { from: "0.1.0", to: "0.2.0" })).toMatchObject({
      label: "Update 0.3.0",
    });
  });
});

function memory(): KeyValue & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("remembered across the restart", () => {
  test("installed → noted; the new version → updated; then forgotten on request", () => {
    const storage = memory();
    noteUpdating(storage, app({ update: { installation: full(installing) } }), NOW);
    expect(storage.map.size).toBe(0);
    noteUpdating(
      storage,
      app({ update: { installation: full(installed), after: { state: "restarting" } } }),
      NOW,
    );
    expect(JSON.parse(storage.map.get(UPDATING_KEY)!)).toEqual({
      from: "0.2.0",
      to: "0.3.0",
      at: NOW,
    });
    // Still the old server (restarting): wait, keep the note.
    expect(updatedOf(storage, app(), NOW + MIN)).toBeNull();
    expect(storage.map.size).toBe(1);
    const after = app({ version: "0.3.0", update: { kind: null, status: "up-to-date" } });
    expect(updatedOf(storage, after, NOW + 2 * MIN)).toEqual({ from: "0.2.0", to: "0.3.0" });
    forgetUpdated(storage);
    expect(updatedOf(storage, after, NOW + 3 * MIN)).toBeNull();
  });

  test("an old note, or another version, is forgotten", () => {
    const storage = memory();
    storage.setItem(UPDATING_KEY, JSON.stringify({ from: "0.2.0", to: "0.3.0", at: NOW }));
    expect(updatedOf(storage, app({ version: "0.3.0" }), NOW + UPDATED_MS + 1)).toBeNull();
    expect(storage.map.size).toBe(0);
    storage.setItem(UPDATING_KEY, JSON.stringify({ from: "0.2.0", to: "0.3.0", at: NOW }));
    expect(updatedOf(storage, app({ version: "0.1.0" }), NOW)).toBeNull();
    expect(storage.map.size).toBe(0);
    storage.setItem(UPDATING_KEY, "{not json");
    expect(updatedOf(storage, app(), NOW)).toBeNull();
  });

  test("storage that throws loses only the note", () => {
    const broken: KeyValue = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() =>
      noteUpdating(broken, app({ update: { installation: full(installed) } }), NOW),
    ).not.toThrow();
    expect(updatedOf(broken, app(), NOW)).toBeNull();
    expect(() => forgetUpdated(broken)).not.toThrow();
  });
});

describe("Settings → Server's words", () => {
  test("the update check's line", () => {
    expect(updateLine(app(), NOW)).toBe("0.3.0 is out · checked 3 minutes ago");
    expect(updateLine(app({ update: { status: "up-to-date", kind: null } }), NOW)).toBe(
      "Up to date · checked 3 minutes ago",
    );
    expect(updateLine(app({ update: { status: "checking" } }), NOW)).toBe(
      "Checking GitHub for a release…",
    );
    expect(
      updateLine(
        app({ update: { status: "error", error: "GitHub did not answer: fake outage." } }),
        NOW,
      ),
    ).toBe("The last check failed: GitHub did not answer: fake outage.");
    expect(
      updateLine(
        app({
          version: null,
          development: true,
          update: { kind: null, latest: null, checkedAt: null },
        }),
        NOW,
      ),
    ).toBe("A checkout checks only when asked · not checked yet");
    expect(updateLine(app({ update: { kind: "downgrade", checkedAt: NOW - 1000 } }), NOW)).toBe(
      "The stable channel is on 0.3.0, older than this one · checked just now",
    );
  });

  test("the service's line", () => {
    const s = app().service;
    expect(serviceLine(s)).toMatch(/^Not set up/);
    expect(serviceLine({ ...s, state: "running", thisNod: true })).toBe(
      "Running as a systemd user unit: this nod serve is the service.",
    );
    expect(serviceLine({ ...s, state: "running", manager: "launchd" })).toMatch(
      /^Running as a LaunchAgent, but this nod serve is another one/,
    );
    expect(serviceLine({ ...s, state: "unsupported" })).toMatch(/Linux and macOS only/);
  });
});
