/**
 * The epic's hard bar "no horizontal overflow at 360 px" (#30), as a browser
 * check: `bun run check:phone`. Not part of `bun run check` because it needs a
 * browser (CLAUDE.md, "browser checks": the nix-store Chromium, found by
 * itself; `NOD_CHROMIUM=<path>` overrides).
 *
 * It starts the Vite dev server and `nod serve --fake --frozen` for each
 * scenario, on free ports with a token file in a temp dir (never 4517, 4518,
 * 4519 or `~/.config/nod`), opens each route with a touch device at 360×780
 * and 390×844, and fails with the route and the offending element when the
 * page scrolls sideways (`scrollWidth > innerWidth`).
 *
 * `STATES` are the routes' states that need a tap first (two rows selected, a
 * cluster open, the menus): checked the same way and, with `--shots`, written
 * under the name the design docs use.
 *
 * `KNOWN_OPEN` lists routes that are expected to fail today, with the reason:
 * they are run and printed, and do not fail the check. A route on the list
 * that passes is reported too, so the list shrinks as the pages are done.
 *
 * `bun scripts/check-phone.ts --shots <dir>` writes a 390×844 screenshot
 * (device scale factor 2) of every route and state instead, for the design
 * docs; the list is shot in its full height.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright-core";

export const SCENARIOS = ["team", "clear", "first-run", "fresh", "join"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** The fake team's repo and two of its PRs (`src/server/fake-data.ts`). */
const REPO = "tallyho/fieldbook";
const PRS = [482, 485];

const VIEWPORTS = [
  { name: "360x780", width: 360, height: 780 },
  { name: "390x844", width: 390, height: 844 },
];

const ROUTES = [
  "#/",
  "#/chrono",
  "#/board",
  "#/setup",
  `#/pr/${REPO}/${PRS[0]}`,
  `#/pr/${REPO}/9999`,
  `#/pr/other/repo/1`,
  `#/batch/${REPO}/${PRS.join(",")}`,
  `#/batch/${REPO}/9998,9999`,
];

/** Routes expected to fail today, run and printed but not failing the check. */
const KNOWN_OPEN: ReadonlyArray<{
  routes: ReadonlyArray<string>;
  scenarios: ReadonlyArray<Scenario>;
  reason: string;
  /**
   * Only what is inside this selector is open: anything that overflows outside
   * it still fails.
   */
  inside?: string;
}> = [
  {
    routes: ["details open"],
    scenarios: ["team"],
    reason: "the detail panel has no phone layout yet (#30, the detail page)",
  },
];

/** A state of a route that needs a tap first. */
interface State {
  /** The route's label in the printout, and the key of `KNOWN_OPEN`. */
  name: string;
  route: string;
  scenarios: ReadonlyArray<Scenario>;
  act: (page: Page) => Promise<void>;
  /** Puts back what the state changed in `nod serve` (the fake's signer is shared by every page). */
  after?: (page: Page) => Promise<void>;
  /** The file name under `--shots` (`docs/design/m1/impl/`), without `.png`. */
  shot?: string;
  /** Shot in its whole height, not the screen's. */
  full?: boolean;
}

const STATES: ReadonlyArray<State> = [
  {
    name: "two selected",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      const boxes = page.getByRole("checkbox");
      await boxes.nth(0).check();
      await boxes.nth(1).check();
    },
    shot: "06-selection-bar",
  },
  {
    name: "cluster open",
    route: "#/chrono",
    scenarios: ["team"],
    act: async (page) => {
      await page.locator("[data-key^='cluster:']").first().click();
    },
    shot: "05-chrono-cluster-open",
    full: true,
  },
  {
    name: "cluster open (by attention)",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await page.locator("[data-key^='cluster:']").first().click();
    },
    shot: "01b-list-cluster-open",
    full: true,
  },
  {
    name: "avatar menu",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await page.getByRole("button", { name: /: menu$/ }).click();
    },
    shot: "07-avatar-menu",
  },
  {
    name: "lock chip popover",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await page.getByRole("button", { name: /Locked/ }).click();
    },
    shot: "11g-lock-chip-popover",
  },
  {
    name: "unlocked",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await page.getByRole("button", { name: /Locked/ }).click();
      // The fake signer takes any passphrase but "wrong".
      await page.locator("#chip-passphrase").fill("correct horse battery");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: /Signing unlocked/ }).waitFor();
    },
    after: async (page) => {
      await page.getByRole("button", { name: /Signing unlocked/ }).click();
      await page.getByRole("button", { name: /Locked/ }).waitFor();
    },
    shot: "07b-top-bar-unlocked",
  },
  {
    name: "legend from the menu",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await page.getByRole("button", { name: /: menu$/ }).click();
      await page.getByRole("button", { name: /How this list works/ }).click();
    },
    shot: "08-how-this-list-works",
  },
  {
    name: "details open",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await page.locator("[data-key^='pr:']").first().click();
    },
    shot: "02-details-over-the-list",
  },
];

// ---------------------------------------------------------------------------
// processes and ports

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Env for children: the parent's, minus anything a nested nix shell would leak. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  return { ...(process.env as Record<string, string>), ...extra };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined>, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export class Child {
  readonly process: ChildProcess;
  output = "";
  constructor(command: string, args: string[], env: Record<string, string>) {
    this.process = spawn(command, args, { env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    const take = (chunk: Buffer) => (this.output += chunk.toString());
    this.process.stdout?.on("data", take);
    this.process.stderr?.on("data", take);
  }
  stop() {
    this.process.kill();
  }
}

export async function startVite(): Promise<{ url: string; child: Child }> {
  const port = await freePort();
  const child = new Child("bun", ["run", "vite", "--host", "127.0.0.1"], { PORT: String(port) });
  const url = `http://127.0.0.1:${port}`;
  await waitFor("the Vite dev server", async () => (await fetch(url)).ok);
  return { url, child };
}

export interface Serve {
  port: number;
  token: string;
  child: Child;
}

export async function startServe(scenario: Scenario, webUrl: string, dir: string): Promise<Serve> {
  const port = await freePort();
  const child = new Child(
    "bun",
    [
      "src/cli.ts",
      "serve",
      "--fake",
      "--scenario",
      scenario,
      "--frozen",
      "--port",
      String(port),
      "--token-file",
      join(dir, `token-${scenario}`),
      "--web-url",
      webUrl,
      "--no-open",
    ],
    { XDG_CONFIG_HOME: dir },
  );
  const token = await waitFor(
    `nod serve (${scenario})`,
    async () => /token=([\w-]+)/.exec(child.output)?.[1],
  );
  return { port, token, child };
}

// ---------------------------------------------------------------------------
// the browser

/** The nix-store Chromium (CLAUDE.md), or whatever `NOD_CHROMIUM` or PATH names. */
function chromiumPath(): string | undefined {
  if (process.env.NOD_CHROMIUM) return process.env.NOD_CHROMIUM;
  const onPath = Bun.which("chromium") ?? Bun.which("chromium-browser");
  if (onPath) return onPath;
  try {
    const found = readdirSync("/nix/store")
      .filter((name) => /^[a-z0-9]{32}-chromium-\d[\d.]*$/.test(name))
      .sort();
    const last = found.at(-1);
    return last ? `/nix/store/${last}/bin/chromium` : undefined;
  } catch {
    return undefined;
  }
}

export async function launch(): Promise<Browser> {
  const executablePath = chromiumPath();
  // A nix Chromium brings its own libraries: the dev shell's would clash.
  const env = { ...(process.env as Record<string, string>) };
  if (executablePath?.startsWith("/nix/store/")) delete env.LD_LIBRARY_PATH;
  return chromium.launch({ executablePath, env, args: ["--no-sandbox"] });
}

export function phone(viewport: { width: number; height: number }, scale = 3) {
  const { defaultBrowserType: _, ...descriptor } = devices["iPhone 13"];
  return { ...descriptor, viewport, deviceScaleFactor: scale };
}

interface Overflow {
  scrollWidth: number;
  innerWidth: number;
  elements: string[];
}

/**
 * What scrolls sideways, and which elements reach past the right edge. The
 * width is the device's, not `innerWidth`: a mobile browser widens its layout
 * viewport to fit overflowing content, so `innerWidth` would grow with it.
 */
async function overflowOf(page: Page, width: number, inside?: string): Promise<Overflow | null> {
  return page.evaluate(
    ([vw, inside]) => {
      const sw = document.documentElement.scrollWidth;
      if (sw <= vw) return null;
      const clipped = (el: Element) => {
        for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o !== "visible" && p.getBoundingClientRect().right <= vw + 1) return true;
        }
        return false;
      };
      const offenders: { el: Element; right: number }[] = [];
      for (const el of document.body.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 1 || clipped(el)) continue;
        if (inside && el.closest(inside)) continue;
        offenders.push({ el, right: r.right });
      }
      offenders.sort((a, b) => b.right - a.right);
      const describe = ({ el, right }: { el: Element; right: number }) => {
        const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}> right edge ${Math.round(right)} px "${text}"`;
      };
      return {
        scrollWidth: sw,
        innerWidth: vw,
        elements: offenders.slice(0, 3).map(describe),
      };
    },
    [width, inside] as const,
  );
}

export async function settle(page: Page, ms = 600) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

// ---------------------------------------------------------------------------
// the pages to open

interface Target {
  /** What is printed: `team #/pr/…`, `unpaired #/`. */
  label: string;
  /** The route, for the known-open list. */
  route: string;
  scenario: Scenario | null;
  /** The address to open, and how long the page needs to settle. */
  url: string;
  wait?: number;
  /** A tap or two before it is checked or shot. */
  state?: State;
}

function targets(web: string, serves: Map<Scenario, Serve>, deadPort: number): Target[] {
  const out: Target[] = [];
  for (const [scenario, serve] of serves) {
    const pairing = `host=${encodeURIComponent(`ws://127.0.0.1:${serve.port}`)}&token=${serve.token}`;
    for (const route of ROUTES)
      out.push({
        label: `${scenario} ${route}`,
        route,
        scenario,
        url: `${web}/${route}?${pairing}`,
      });
    for (const state of STATES.filter((st) => st.scenarios.includes(scenario)))
      out.push({
        label: `${scenario} ${state.route} ${state.name}`,
        route: state.name,
        scenario,
        url: `${web}/${state.route}?${pairing}`,
        state,
      });
  }
  const any = [...serves.values()][0]!;
  // The pages before there is a dashboard: not paired, refused, nod serve gone.
  for (const route of ["#/", `#/pr/${REPO}/${PRS[0]}`, `#/batch/${REPO}/${PRS.join(",")}`])
    out.push({
      label: `unpaired ${route}`,
      route: `unpaired ${route}`,
      scenario: null,
      url: `${web}/${route}`,
    });
  out.push({
    label: "refused",
    route: "refused",
    scenario: null,
    url: `${web}/#host=${encodeURIComponent(`ws://127.0.0.1:${any.port}`)}&token=not-the-token`,
  });
  out.push({
    label: "closed",
    route: "closed",
    scenario: null,
    url: `${web}/#host=${encodeURIComponent(`ws://127.0.0.1:${deadPort}`)}&token=x`,
    wait: 2600,
  });
  return out;
}

function knownOpen(target: Target) {
  return KNOWN_OPEN.find(
    (k) =>
      target.scenario && k.scenarios.includes(target.scenario) && k.routes.includes(target.route),
  );
}

async function open(context: BrowserContext, target: Target): Promise<Page> {
  const page = await context.newPage();
  await page.goto(target.url);
  await settle(page, target.wait);
  if (target.state) {
    await target.state.act(page);
    await settle(page, 400);
  }
  return page;
}

// ---------------------------------------------------------------------------

const argAfter = (flag: string) =>
  process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null;

/** The docs' names for the list shots (`docs/design/m1/impl/`), by target label. */
const SHOT_NAMES: Record<string, string> = {
  "team #/": "01-list-by-attention",
  "team #/chrono": "04-chrono-time-buckets",
  "first-run #/": "17-first-run-dashboard",
  "clear #/": "18-nothing-needs-you",
};

/** Grows the screen to the whole list (the list scrolls inside the page, so `fullPage` is not enough). */
async function growToList(page: Page, width: number) {
  const height = await page.evaluate(() => {
    const list = document.getElementById("list-scroll");
    const top = list?.getBoundingClientRect().top ?? 0;
    return list ? Math.ceil(top + list.scrollHeight) : 0;
  });
  if (height > 0) {
    await page.setViewportSize({ width, height });
    await settle(page, 300);
  }
}

async function main() {
  const shotsAt = argAfter("--shots");
  const dir = mkdtempSync(join(tmpdir(), "nod-check-phone-"));
  const children: Child[] = [];
  let browser: Browser | null = null;
  try {
    const vite = await startVite();
    children.push(vite.child);
    const serves = new Map<Scenario, Serve>();
    for (const scenario of SCENARIOS) {
      const serve = await startServe(scenario, vite.url, dir);
      children.push(serve.child);
      serves.set(scenario, serve);
    }
    const deadPort = await freePort();
    const all = targets(vite.url, serves, deadPort);
    browser = await launch();

    if (shotsAt) {
      mkdirSync(shotsAt, { recursive: true });
      const width = Number(argAfter("--width") ?? 390);
      for (const target of all) {
        // A fresh context per page, as in the check: its own storage.
        const context = await browser.newContext(phone({ width, height: 844 }, 2));
        const page = await open(context, target);
        const name =
          SHOT_NAMES[target.label] ??
          target.state?.shot ??
          target.label.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
        // The list scrolls inside the page: a full shot makes the screen as tall as the list.
        if (target.state?.full || SHOT_NAMES[target.label]) await growToList(page, width);
        await page.screenshot({ path: join(shotsAt, `${name}.png`) });
        await target.state?.after?.(page);
        await context.close();
      }
      return;
    }

    let failed = 0;
    const open_: string[] = [];
    for (const viewport of VIEWPORTS) {
      console.log(`\n${viewport.name}`);
      for (const target of all) {
        // A fresh context per page: its own storage, so no pairing leaks across.
        const context = await browser.newContext(phone(viewport));
        const page = await open(context, target);
        const known = knownOpen(target);
        const overflow = await overflowOf(page, viewport.width);
        await target.state?.after?.(page);
        // A known-open route that is open only inside a part still fails outside it.
        const outside =
          overflow && known?.inside ? await overflowOf(page, viewport.width, known.inside) : null;
        await context.close();
        if (!overflow) {
          console.log(
            `  ok    ${target.label}${known ? "   (known-open, but fits now: remove it from KNOWN_OPEN)" : ""}`,
          );
          continue;
        }
        const culprit = outside?.elements.length ? outside : known ? null : overflow;
        if (!culprit) {
          console.log(`  open  ${target.label}   known-open: ${known!.reason}`);
          open_.push(`${viewport.name} ${target.label}`);
          continue;
        }
        console.log(
          `  FAIL  ${target.label}: scrolls to ${culprit.scrollWidth} px of ${viewport.width}\n${culprit.elements.map((e) => `          ${e}`).join("\n")}`,
        );
        failed++;
      }
    }
    console.log(
      `\n${failed ? `${failed} page(s) overflow` : "no page overflows"}; ${open_.length} known-open run(s) still overflow`,
    );
    if (failed) process.exitCode = 1;
  } finally {
    await browser?.close();
    for (const child of children) child.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
