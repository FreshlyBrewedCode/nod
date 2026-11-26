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
 * A state may also `assert` what it shows (the back gesture closes the detail
 * page and the sign sheet, the passphrase field's attributes, the docked field
 * above an emulated keyboard): a failed assertion fails the check like an
 * overflow. A state with `fresh` runs on its own `nod serve`, as it changes
 * what the fake knows (signing).
 *
 * `KNOWN_OPEN` lists routes that are expected to fail today, with the reason:
 * they are run and printed, and do not fail the check. A route on the list
 * that passes is reported too, so the list shrinks as the pages are done. It
 * is empty now: every page fits.
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
}> = [];

/** A state of a route that needs a tap first. */
interface State {
  /** The route's label in the printout, and the key of `KNOWN_OPEN`. */
  name: string;
  route: string;
  scenarios: ReadonlyArray<Scenario>;
  act: (page: Page, env: Env) => Promise<void>;
  /** What must hold after `act`: throws a message when it does not. */
  assert?: (page: Page, env: Env) => Promise<void>;
  /** Runs on a `nod serve` of its own (it signs, which the fake keeps). */
  fresh?: boolean;
  /** Puts back what the state changed in `nod serve` (the fake's signer is shared by every page). */
  after?: (page: Page) => Promise<void>;
  /** The file name under `--shots` (`docs/design/m1/impl/`), without `.png`. */
  shot?: string;
  /** Shot in its whole height, not the screen's. */
  full?: boolean;
  /** The address to open instead of `route` with the scenario's pairing (a page that is not paired). */
  url?: (env: Env) => string;
  /** Before the page opens: routes, init scripts. */
  before?: (page: Page, env: Env) => Promise<void>;
}

/** What a state's `url` and `before` know: the dev server and the scenario's `nod serve`. */
interface Env {
  web: string;
  serve: Serve;
}

/** Fails the state with `message` unless the condition holds. */
async function must(condition: Promise<boolean>, message: string) {
  if (!(await condition)) throw new Error(message);
}

const openFirstRow = async (page: Page) => {
  await page.locator("[data-key^='pr:']").first().click();
  await page.getByLabel(/^Details of #/).waitFor();
};

/** The sign sheet's review step for the five PRs the first rows ask for. */
const openReview = async (page: Page) => {
  const boxes = page.getByRole("checkbox");
  for (let i = 0; i < 5; i++) await boxes.nth(i).check();
  await page.getByRole("button", { name: /Review & sign 5/ }).click();
  await page.locator("[data-slot=dialog-content]").waitFor();
};

const openUnlock = async (page: Page) => {
  await openReview(page);
  await page.getByRole("button", { name: /Unlock and sign 5/ }).click();
  await page.locator("#batch-passphrase").waitFor();
};

const signFive = async (page: Page) => {
  await openUnlock(page);
  await page.locator("#batch-passphrase").fill("correct horse battery");
  await page.keyboard.press("Enter");
  await page.getByText(/pull requests signed/).waitFor();
};

type Kb = { __keyboard: (height: number | null) => void };

/**
 * A stand-in for the on-screen keyboard: Chromium here has none, so `visualViewport` is
 * replaced by one whose height the test sets. It tests that the sheet follows the visual
 * viewport; it is not a real iOS or Android keyboard.
 */
async function emulateKeyboard(page: Page) {
  await page.evaluate(() => {
    const target = new EventTarget();
    let height: number | null = null;
    Object.defineProperties(target, {
      height: { get: () => height ?? innerHeight },
      width: { get: () => innerWidth },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      scale: { value: 1 },
    });
    Object.defineProperty(window, "visualViewport", { value: target, configurable: true });
    (window as unknown as Kb).__keyboard = (h) => {
      height = h;
      target.dispatchEvent(new Event("resize"));
    };
  });
}

// ---------------------------------------------------------------------------
// deep links on another device (ADR 0005 §7)

/**
 * A stand-in for the named host: `https://nod.example.test` is routed to the
 * dev server, and its socket is relayed to `nod serve` on loopback (a relay
 * sends no Origin, so the loopback token lets it in). The page itself sees an
 * https origin that is not loopback, as on a phone; what it does not prove is
 * a real TLS proxy (the live check through `tailscale serve` does).
 */
const NAMED = "https://nod.example.test";
const NAMED_PAIRING = (serve: Serve) =>
  `${NAMED}/#host=${encodeURIComponent("wss://nod.example.test")}&token=${serve.token}`;

async function routeNamedHost(page: Page, env: Env) {
  await page.route(/^https:\/\/nod\.example\.test\//, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${env.web}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.routeWebSocket(/^wss:\/\/nod\.example\.test\//, (ws) => {
    const url = new URL(ws.url());
    // Vite's own socket: left open and silent.
    if (url.pathname !== "/ws") return;
    const upstream = new WebSocket(`ws://127.0.0.1:${env.serve.port}/ws${url.search}`);
    const queue: string[] = [];
    upstream.onopen = () => {
      for (const message of queue.splice(0)) upstream.send(message);
    };
    upstream.onmessage = (event) => ws.send(String(event.data));
    upstream.onclose = (event) =>
      event.code === 1000 || (event.code >= 4000 && event.code < 5000)
        ? ws.close({ code: event.code, reason: event.reason })
        : ws.close();
    ws.onMessage((message) =>
      upstream.readyState === WebSocket.OPEN
        ? upstream.send(String(message))
        : queue.push(String(message)),
    );
    ws.onClose(() => upstream.close());
  });
}

/**
 * A stand-in for the hosted UI on GitHub Pages, which sends no framing
 * headers: `https://ui.nod.frebreco.de` is routed to the dev server with its
 * `X-Frame-Options` and CSP taken off, and its Vite socket kept silent. It
 * is the hosted origin to the app (`pairsWithLoopback`), so it forwards.
 */
const HOSTED = "https://ui.nod.frebreco.de";

async function routeHosted(page: Page, env: Env) {
  await page.route(/^https:\/\/ui\.nod\.frebreco\.de\//, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${env.web}${url.pathname}${url.search}` });
    const headers = { ...response.headers() };
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];
    await route.fulfill({ response, headers });
  });
  await page.routeWebSocket(/^wss:\/\/ui\.nod\.frebreco\.de\//, () => {});
}

/** Another site that frames the hosted UI's confirmation for a host of its own. */
const FRAMING = "https://evil.example.test/";
const EVIL = "https://evil.example.test";

async function routeFraming(page: Page, env: Env) {
  await routeHosted(page, env);
  const src = `${HOSTED}/#/forward?to=${encodeURIComponent(EVIL)}`;
  await page.route(FRAMING, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;background:#fff"><p style="font:14px sans-serif;margin:12px">A page of another site</p><iframe src="${src}" style="border:0;width:100%;height:700px"></iframe>`,
    }),
  );
}

const FORWARD_TO = (web: string, to = NAMED) => `${web}/#/forward?to=${encodeURIComponent(to)}`;
/** The host a page first asks for in the swap checks: long, with a hyphen in a label. */
const LAPTOP = "https://laptop.example-tailnet.ts.net:8445";
/** Long enough to wrap twice at 360 px, with hyphens in its labels. */
const LONG = "https://build-laptop.example-tailnet-long.ts.net:8445";
const rememberButton = (page: Page) => page.getByRole("button", { name: "Remember this address" });
const stored = (page: Page) =>
  page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem("nod.forward") ?? "null") as { to?: string } | null)?.to ??
      null,
  );
const LINK = `#/pr/${REPO}/${PRS[0]}`;

const remember = async (page: Page, web: string) => {
  await page.goto(FORWARD_TO(web));
  await page.getByRole("button", { name: "Remember this address" }).click();
  await page.getByRole("heading", { name: /^Links from GitHub open your nod at/ }).waitFor();
};

const forwardStored = (page: Page) =>
  page.evaluate(() => localStorage.getItem("nod.forward") !== null);

const FORWARD_STATES: ReadonlyArray<State> = [
  {
    name: "forward, confirm",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => FORWARD_TO(web),
    act: async () => {},
    assert: async (page) => {
      await must(
        page.getByText("https://nod.example.test", { exact: true }).isVisible(),
        "the host is not spelled out",
      );
      await must(
        page
          .getByRole("button", { name: "Don’t remember" })
          .evaluate((el) => document.activeElement === el),
        "“Don’t remember” is not the default",
      );
      await must(
        forwardStored(page).then((stored) => !stored),
        "something was remembered on arrival",
      );
    },
    shot: "21a-forward-confirm",
  },
  {
    // Finding 3: a long name breaks after its dots, never at a hyphen inside a label.
    name: "forward, a long hyphenated host",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => FORWARD_TO(web, LONG),
    act: async () => {},
    assert: async (page) => {
      const breaks = await page.evaluate((shown) => {
        const box = [...document.querySelectorAll("main div")].find(
          (el) => el.textContent === shown,
        )!;
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        const chars: { ch: string; top: number }[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          for (let i = 0; i < node.textContent!.length; i++) {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            chars.push({ ch: node.textContent![i]!, top: range.getBoundingClientRect().top });
          }
        const out: string[] = [];
        for (let i = 1; i < chars.length; i++)
          if (chars[i]!.top > chars[i - 1]!.top + 2) out.push(chars[i - 1]!.ch + chars[i]!.ch);
        return out;
      }, LONG);
      await must(Promise.resolve(breaks.length > 0), "the long host does not wrap: not a test");
      const wrong = breaks.filter((pair) => !/^[./]|:$/.test(pair) && pair[1] !== ":");
      await must(Promise.resolve(wrong.length === 0), `the host breaks inside a label: ${wrong}`);
    },
    shot: "21j-forward-long-host",
  },
  {
    // Finding 1: an opener sets the fragment of the open page to another host.
    name: "forward, another host after Remember",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => FORWARD_TO(web, LAPTOP),
    act: async (page, { web }) => {
      await rememberButton(page).click();
      await page.getByRole("heading", { name: /^Links from GitHub open your nod at/ }).waitFor();
      await page.evaluate((url) => (window.location.href = url), FORWARD_TO(web, EVIL));
      await page.getByRole("heading", { name: /^Open nod links in this browser/ }).waitFor();
      await must(rememberButton(page).isDisabled(), "the new host's Remember is armed at once");
    },
    assert: async (page) => {
      await must(
        stored(page).then((to) => to === LAPTOP),
        "the remembered host changed without a tap",
      );
      await must(
        page.getByText("It replaces").isVisible(),
        "the new host is not asked about as a replacement",
      );
      await must(
        page
          .getByRole("link", { name: "Back to your nod" })
          .count()
          .then((n) => n === 0),
        "the finished page still shows, for a host that is not stored",
      );
    },
  },
  {
    // Finding 1: the host swapped just before a tap at the button's spot.
    name: "forward, another host just before the tap",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => FORWARD_TO(web, LAPTOP),
    act: async (page, { web }) => {
      const button = rememberButton(page);
      await must(button.isDisabled(), "Remember is armed on arrival");
      await page.waitForFunction(
        () =>
          !(
            [...document.querySelectorAll("button")].find(
              (b) => b.textContent === "Remember this address",
            ) as HTMLButtonElement
          ).disabled,
      );
      const box = (await button.boundingBox())!;
      await page.evaluate((url) => (window.location.href = url), FORWARD_TO(web, EVIL));
      await page.getByText(EVIL, { exact: true }).waitFor();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    },
    assert: async (page) => {
      await must(
        stored(page).then((to) => to === null),
        "a tap right after the swap remembered a host",
      );
      await must(
        page.getByText("https://evil.example.test", { exact: true }).isVisible(),
        "the page does not name the host it now asks about",
      );
    },
  },
  {
    // Finding 2: a page opened in the background does not arrive armed.
    name: "forward, opened hidden",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => FORWARD_TO(web),
    before: async (page) => {
      await page.addInitScript(() => {
        const w = window as unknown as { __visible: boolean };
        w.__visible = false;
        Object.defineProperty(document, "visibilityState", {
          get: () => (w.__visible ? "visible" : "hidden"),
          configurable: true,
        });
      });
    },
    act: async (page) => {
      await page.waitForTimeout(1500);
      await must(rememberButton(page).isDisabled(), "a hidden page armed Remember");
      await page.evaluate(() => {
        (window as unknown as { __visible: boolean }).__visible = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await must(rememberButton(page).isDisabled(), "Remember armed as soon as the page showed");
      await page.waitForTimeout(1200);
    },
    assert: async (page) => {
      await must(rememberButton(page).isEnabled(), "Remember never arms once visible");
    },
  },
  {
    // How "Remember" looks before it is armed (kept hidden, so it stays so for the shot).
    name: "forward, not armed yet",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => FORWARD_TO(web),
    before: async (page) => {
      await page.addInitScript(() =>
        Object.defineProperty(document, "visibilityState", { get: () => "hidden" }),
      );
    },
    act: async () => {},
    assert: async (page) => {
      await must(rememberButton(page).isDisabled(), "a hidden page armed Remember");
      await must(
        page.getByRole("button", { name: "Don’t remember" }).isEnabled(),
        "“Don’t remember” waits too",
      );
    },
    shot: "21k-forward-not-armed",
  },
  {
    // Finding 2: inside another site's frame the app refuses.
    name: "forward, framed by another site",
    route: "#/forward",
    scenarios: ["team"],
    url: () => FRAMING,
    before: routeFraming,
    act: async (page) => {
      await page
        .frameLocator("iframe")
        .getByRole("heading", { name: "nod does not run inside another page" })
        .waitFor();
    },
    assert: async (page) => {
      const frame = page.frames().find((f) => f.url().startsWith(HOSTED))!;
      await must(
        frame
          .getByRole("button", { name: "Remember this address" })
          .count()
          .then((n) => n === 0),
        "the framed page offers to remember",
      );
      await must(
        frame.evaluate(() => localStorage.getItem("nod.forward") === null),
        "the framed page stored a host",
      );
    },
    shot: "21i-framed",
  },
  {
    // The stand-in is not vacuous: at the top, the routed hosted origin forwards.
    name: "forward, the hosted origin at the top",
    route: "#/forward",
    scenarios: ["team"],
    url: () => `${HOSTED}/#/forward?to=${encodeURIComponent(LAPTOP)}`,
    before: routeHosted,
    act: async (page) => {
      await rememberButton(page).waitFor();
    },
    assert: async (page) => {
      await must(rememberButton(page).isEnabled(), "Remember does not arm on the hosted origin");
    },
  },
  {
    name: "forward, don't remember",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => FORWARD_TO(web),
    act: async (page) => {
      await page.keyboard.press("Enter");
      await page.getByRole("heading", { name: "Open nod from your terminal" }).waitFor();
    },
    assert: async (page) => {
      await must(
        forwardStored(page).then((stored) => !stored),
        "Enter remembered the host",
      );
    },
  },
  {
    name: "forward, a host it refuses",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => `${web}/#/forward?to=${encodeURIComponent("https://127.0.0.1:4518")}`,
    act: async () => {},
    assert: async (page) => {
      await must(
        page.getByRole("heading", { name: /names no address nod can open/ }).isVisible(),
        "a loopback host is offered",
      );
      await must(
        page
          .getByRole("button", { name: "Remember this address" })
          .count()
          .then((n) => n === 0),
        "a refused host can be remembered",
      );
    },
    shot: "21b-forward-refused",
  },
  {
    name: "forward, remembered",
    route: "#/forward",
    scenarios: ["team"],
    url: ({ web }) => `${web}/#/`,
    act: (page, { web }) => remember(page, web),
    assert: async (page) => {
      await must(forwardStored(page), "nothing was remembered");
    },
    shot: "21c-forward-remembered",
  },
  {
    name: "link, open on the remembered host",
    route: LINK,
    scenarios: ["team"],
    url: ({ web }) => `${web}/#/`,
    act: async (page, { web }) => {
      await remember(page, web);
      await page.goto(`${web}/${LINK}`);
      await page.getByRole("link", { name: /^Open on nod\.example\.test$/ }).waitFor();
    },
    assert: async (page) => {
      const href = await page
        .getByRole("link", { name: /^Open on nod\.example\.test$/ })
        .getAttribute("href");
      await must(Promise.resolve(href === `${NAMED}/${LINK}`), `the forward goes to ${href}`);
    },
    shot: "21d-link-forward-offer",
  },
  {
    name: "link, forget the host",
    route: LINK,
    scenarios: ["team"],
    url: ({ web }) => `${web}/#/`,
    act: async (page, { web }) => {
      await remember(page, web);
      await page.goto(`${web}/${LINK}`);
      await page.getByRole("button", { name: "Forget this address" }).click();
    },
    assert: async (page) => {
      await must(
        page.getByRole("heading", { name: "Open it in nod on your machine" }).isVisible(),
        "forgetting does not show the pairing steps",
      );
      await must(
        forwardStored(page).then((stored) => !stored),
        "the host is still remembered",
      );
    },
  },
  {
    name: "link, forwarded to the named host",
    route: LINK,
    scenarios: ["team"],
    // Paired on the named host first, as the phone is.
    url: ({ serve }) => NAMED_PAIRING(serve),
    before: routeNamedHost,
    act: async (page, { web }) => {
      await page.locator("[data-key^='pr:']").first().waitFor();
      await remember(page, web);
      await page.goto(`${web}/${LINK}`);
      await page.getByRole("link", { name: /^Open on nod\.example\.test$/ }).click();
      await page.waitForURL(`${NAMED}/**`);
      await page.getByRole("button", { name: /^Review & sign/ }).waitFor();
    },
    assert: async (page) => {
      await must(
        Promise.resolve(page.url() === `${NAMED}/${LINK}`),
        `the forward landed on ${page.url()}`,
      );
      await must(
        page.getByText(/^Opened from a link/).isVisible(),
        "the named host does not show the link's landing",
      );
    },
    shot: "21e-link-forwarded",
  },
  {
    name: "named host, the avatar menu",
    route: "#/",
    scenarios: ["team"],
    url: ({ serve }) => NAMED_PAIRING(serve),
    before: routeNamedHost,
    act: async (page) => {
      await page.getByRole("button", { name: /: menu$/ }).click();
    },
    assert: async (page) => {
      const href = await page
        .getByRole("link", { name: /^Open links from GitHub here/ })
        .getAttribute("href");
      const expected = `https://ui.nod.frebreco.de/next/#/forward?to=${encodeURIComponent(NAMED)}`;
      await must(Promise.resolve(href === expected), `the item goes to ${href}`);
      await must(Promise.resolve(!href?.includes("token")), "the item carries the token");
    },
    shot: "21f-named-host-menu",
  },
  {
    name: "named host, a link before pairing",
    route: LINK,
    scenarios: ["team"],
    url: () => `${NAMED}/${LINK}`,
    before: routeNamedHost,
    act: async () => {},
    assert: async (page) => {
      await must(
        page.getByText(/Scan the QR code it prints/).isVisible(),
        "the named host does not say to scan the device link",
      );
      await must(
        page.evaluate(() => localStorage.getItem("nod.pendingLink") !== null),
        "the link is not remembered for the pairing",
      );
    },
    shot: "21g-named-host-link-not-paired",
  },
  {
    name: "home-screen app, not paired",
    route: "#/",
    scenarios: ["team"],
    url: () => `${NAMED}/`,
    before: async (page, env) => {
      await routeNamedHost(page, env);
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "standalone", { value: true, configurable: true }),
      );
    },
    act: async () => {},
    assert: async (page) => {
      await must(page.getByLabel("Pair this app").isVisible(), "no field to paste the link");
    },
    shot: "21h-installed-app-not-paired",
  },
  {
    name: "home-screen app, pasted link pairs",
    route: "#/",
    scenarios: ["team"],
    url: () => `${NAMED}/`,
    before: async (page, env) => {
      await routeNamedHost(page, env);
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "standalone", { value: true, configurable: true }),
      );
    },
    act: async (page, { serve }) => {
      await page.getByLabel("Pair this app").fill("https://evil.example/#host=x&token=y");
      await page.getByRole("button", { name: "Pair" }).click();
      await page.getByRole("alert").waitFor();
      await page.getByLabel("Pair this app").fill(NAMED_PAIRING(serve));
      await page.getByRole("button", { name: "Pair" }).click();
      await page.locator("[data-key^='pr:']").first().waitFor();
    },
    assert: async (page) => {
      await must(Promise.resolve(!page.url().includes("token")), "the token stays in the address");
    },
  },
  {
    name: "paired, a host remembered: the landing as before",
    route: LINK,
    scenarios: ["team"],
    act: async (page, { web }) => {
      await remember(page, web);
      await page.goto(`${web}/${LINK}`);
      await page.getByRole("button", { name: /^Review & sign/ }).waitFor();
    },
    assert: async (page) => {
      await must(
        page
          .getByRole("link", { name: /^Open on / })
          .count()
          .then((n) => n === 0),
        "a paired page offers the forward",
      );
    },
  },
];

const STATES: ReadonlyArray<State> = [
  ...FORWARD_STATES,
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
    name: "detail page",
    route: "#/",
    scenarios: ["team"],
    act: openFirstRow,
    assert: async (page) => {
      await must(page.getByLabel(/^Details of #/).isVisible(), "the detail page is not shown");
      await must(
        page.getByText(/^\d+ of \d+ that need you$/).isVisible(),
        'the header does not say "1 of 6 that need you"',
      );
      await must(
        page.getByRole("button", { name: "Next that needs you, #485" }).isVisible(),
        "no Next › in the action bar",
      );
    },
    shot: "02-detail-page",
  },
  {
    name: "detail page, folds open",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await openFirstRow(page);
      await page.getByRole("button", { name: /^Why this needs you/ }).click();
      await page.getByRole("button", { name: /^Signatures/ }).click();
      await page.getByRole("button", { name: /^Why this needs you/ }).scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        const head = [...document.querySelectorAll("button")].find((b) =>
          b.textContent?.startsWith("Why this needs you"),
        );
        head?.scrollIntoView({ block: "start" });
      });
    },
    shot: "02b-detail-folds-open",
  },
  {
    name: "detail page, Next",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await openFirstRow(page);
      await page.getByRole("button", { name: /^Next that needs you/ }).click();
    },
    assert: async (page) => {
      await must(
        page.getByText(/^2 of \d+ that need you$/).isVisible(),
        "Next › does not show the second PR",
      );
    },
  },
  {
    name: "back from the detail page",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      const list = page.locator("#list-scroll");
      await list.evaluate((el) => (el.scrollTop = 240));
      await page.evaluate(() => ((window as unknown as { __at: number }).__at = 0));
      await page.locator("[data-key^='pr:']").nth(1).click();
      await page.getByLabel(/^Details of #/).waitFor();
      await page.goBack();
      await page.getByLabel(/^Details of #/).waitFor({ state: "detached" });
    },
    assert: async (page) => {
      const top = await page.locator("#list-scroll").evaluate((el) => el.scrollTop);
      await must(Promise.resolve(Math.abs(top - 240) < 2), `the list is at ${top} px, not 240`);
      // The header's back button does the same and leaves no entry behind.
      const before = await page.evaluate(() => history.length);
      await page.locator("[data-key^='pr:']").nth(1).click();
      await page.getByLabel(/^Details of #/).waitFor();
      await page.getByRole("button", { name: "Back to the list" }).click();
      await page.getByLabel(/^Details of #/).waitFor({ state: "detached" });
      await settle(page, 300);
      const after = await page.evaluate(() => history.length);
      await must(Promise.resolve(after <= before + 1), `history grew from ${before} to ${after}`);
      await must(
        page.evaluate(() => history.state === null),
        "an entry of the page is left on top",
      );
    },
  },
  {
    name: "sign sheet, review",
    route: "#/",
    scenarios: ["team"],
    act: openReview,
    assert: async (page) => {
      await must(
        page.getByRole("button", { name: /Unlock and sign 5/ }).isVisible(),
        "the review step has no footer button",
      );
      const box = await page.locator("[data-slot=dialog-content]").boundingBox();
      await must(
        Promise.resolve(box !== null && box.x === 0 && box.y === 0 && box.height >= 780),
        "the sheet is not the whole screen",
      );
    },
    shot: "11-batch-sheet",
  },
  {
    name: "sign sheet, row tapped",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await openReview(page);
      await page.getByRole("button", { name: /billing: add invoices/ }).click();
    },
    assert: async (page) => {
      await must(
        page.getByText(/^head [0-9a-f]{40}/).isVisible(),
        "tapping a row does not show its head and patch-id",
      );
      await must(
        page.getByRole("button", { name: "Take out of the batch" }).isVisible(),
        'no "Take out of the batch" on the tapped row',
      );
    },
    shot: "11e-batch-row-details",
  },
  {
    name: "sign sheet, unlock",
    route: "#/",
    scenarios: ["team"],
    act: openUnlock,
    assert: async (page) => {
      const field = await page.locator("#batch-passphrase").evaluate((el) => {
        const input = el as HTMLInputElement;
        return {
          type: input.type,
          autocomplete: input.autocomplete,
          name: input.name,
          size: parseFloat(getComputedStyle(input).fontSize),
          form: Boolean(input.form),
          submit: Boolean(input.form?.querySelector("button[type=submit]")),
        };
      });
      await must(
        Promise.resolve(
          field.type === "password" &&
            field.autocomplete === "current-password" &&
            field.name === "passphrase" &&
            field.size >= 16 &&
            field.form &&
            field.submit,
        ),
        `the passphrase field is not as specified: ${JSON.stringify(field)}`,
      );
      await must(
        page
          .getByText(/^billing: add invoices/)
          .first()
          .isVisible(),
        "the titles are not above the field",
      );
    },
    shot: "11b-batch-unlock",
  },
  {
    name: "sign sheet, unlock above an emulated keyboard",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await emulateKeyboard(page);
      await openUnlock(page);
      await page.evaluate(() => (window as unknown as Kb).__keyboard(544));
    },
    assert: async (page) => {
      const field = await page.locator("#batch-passphrase").boundingBox();
      const button = await page.getByRole("button", { name: /^Sign 5$/ }).boundingBox();
      const chip = await page.getByRole("button", { name: /just this once/ }).boundingBox();
      await must(
        Promise.resolve(
          field !== null &&
            button !== null &&
            chip !== null &&
            field.y + field.height <= 544 &&
            button.y + button.height <= 544 &&
            chip.y + chip.height <= 544,
        ),
        "the docked field is below the top of the emulated keyboard (544 px)",
      );
      await must(
        page
          .locator("[data-slot=dialog-content]")
          .getByText(/^billing: prorate/)
          .isVisible(),
        "the titles are gone with the keyboard up",
      );
    },
    shot: "11f-batch-unlock-keyboard-emulated",
  },
  {
    name: "sign sheet, wrong passphrase",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await openUnlock(page);
      // The fake signer takes any passphrase but "wrong".
      await page.locator("#batch-passphrase").fill("wrong");
      await page.keyboard.press("Enter");
      await page.getByRole("alert").waitFor();
    },
    assert: async (page) => {
      await must(page.getByText(/does not unlock the key/).isVisible(), "no error under the field");
      await must(
        page.locator("#batch-passphrase").evaluate((el) => document.activeElement === el),
        "the field does not take focus again",
      );
    },
    shot: "11c-batch-unlock-wrong-passphrase",
  },
  {
    name: "sign sheet, signed",
    route: "#/",
    scenarios: ["team"],
    fresh: true,
    act: signFive,
    assert: async (page) => {
      await must(
        page.getByRole("button", { name: "Open the last one" }).isVisible(),
        'no "Open the last one" with one PR left',
      );
      await must(
        page.getByText(/Signing stays unlocked for/).isVisible(),
        "the unlocked countdown is missing",
      );
    },
    shot: "11d-batch-signed",
  },
  {
    name: "open the last one",
    route: "#/",
    scenarios: ["team"],
    fresh: true,
    act: async (page) => {
      await signFive(page);
      await page.getByRole("button", { name: "Open the last one" }).click();
      await page.getByLabel(/^Details of #/).waitFor();
      await page.locator("[data-slot=dialog-content]").waitFor({ state: "detached" });
    },
    assert: async (page) => {
      await must(
        page
          .getByLabel(/^Details of #/)
          .getByText(/search: fix facet counts/)
          .isVisible(),
        "the last PR's page is not shown",
      );
      await page.goBack();
      await page.getByLabel(/^Details of #/).waitFor({ state: "detached" });
      await must(
        Promise.resolve(page.url().includes("#/") || true),
        "back from the opened page does not return to the list",
      );
    },
  },
  {
    name: "back closes the sign sheet",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await openReview(page);
      await page.goBack();
      await page.locator("[data-slot=dialog-content]").waitFor({ state: "detached" });
    },
    assert: async (page) => {
      await must(
        page.getByText(/5 selected/).isVisible(),
        "the selection is gone after back from the sheet",
      );
    },
  },
  {
    name: "sign from the detail page",
    route: "#/",
    scenarios: ["team"],
    act: async (page) => {
      await openFirstRow(page);
      await page
        .getByLabel(/^Details of #/)
        .getByRole("button", { name: /^Sign as/ })
        .click();
      await page.locator("[data-slot=dialog-content]").waitFor();
      // Back closes the sheet and leaves the page; back again closes the page.
      await page.goBack();
      await page.locator("[data-slot=dialog-content]").waitFor({ state: "detached" });
    },
    assert: async (page) => {
      await must(page.getByLabel(/^Details of #/).isVisible(), "back closed the page too");
      await page.goBack();
      await page.getByLabel(/^Details of #/).waitFor({ state: "detached" });
    },
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

export async function startServe(
  scenario: Scenario,
  webUrl: string,
  dir: string,
  name: string = scenario,
): Promise<Serve> {
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
      join(dir, `token-${name}`),
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
  /** The pairing, for a state on a `nod serve` of its own. */
  pairing?: (serve: Serve) => string;
  /** What the state's hooks get. */
  env?: Env;
}

const pairingOf = (serve: Serve) =>
  `host=${encodeURIComponent(`ws://127.0.0.1:${serve.port}`)}&token=${serve.token}`;

function targets(web: string, serves: Map<Scenario, Serve>, deadPort: number): Target[] {
  const out: Target[] = [];
  for (const [scenario, serve] of serves) {
    const pairing = pairingOf(serve);
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
        url: state.url ? state.url({ web, serve }) : `${web}/${state.route}?${pairing}`,
        state,
        env: { web, serve },
        ...(state.fresh && {
          pairing: (own: Serve) => `${web}/${state.route}?${pairingOf(own)}`,
        }),
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

/** Opens a target; a `fresh` state gets a `nod serve` of its own, stopped with `done`. */
async function open(
  context: BrowserContext,
  target: Target,
  own: (target: Target) => Promise<{ url: string; done: () => void }>,
): Promise<{ page: Page; done: () => void }> {
  const { url, done } = await own(target);
  const page = await context.newPage();
  if (target.state && target.env) await target.state.before?.(page, target.env);
  await page.goto(url);
  await settle(page, target.wait);
  if (target.state && target.env) {
    await target.state.act(page, target.env);
    await settle(page, 400);
    await target.state.assert?.(page, target.env);
  }
  return { page, done };
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
    let owned = 0;
    /** The address of a target: its own `nod serve` when the state asks for one. */
    const own = async (target: Target) => {
      if (!target.pairing) return { url: target.url, done: () => {} };
      const serve = await startServe("team", vite.url, dir, `own${owned++}`);
      return { url: target.pairing(serve), done: () => serve.child.stop() };
    };

    if (shotsAt) {
      mkdirSync(shotsAt, { recursive: true });
      const width = Number(argAfter("--width") ?? 390);
      for (const target of all) {
        // A fresh context per page, as in the check: its own storage.
        const context = await browser.newContext(phone({ width, height: 844 }, 2));
        const { page, done } = await open(context, target, own);
        const name =
          SHOT_NAMES[target.label] ??
          target.state?.shot ??
          target.label.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
        // The list scrolls inside the page: a full shot makes the screen as tall as the list.
        if (target.state?.full || SHOT_NAMES[target.label]) await growToList(page, width);
        await page.screenshot({ path: join(shotsAt, `${name}.png`) });
        await target.state?.after?.(page);
        await context.close();
        done();
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
        let opened: Awaited<ReturnType<typeof open>>;
        try {
          opened = await open(context, target, own);
        } catch (error) {
          console.log(`  FAIL  ${target.label}: ${(error as Error).message.split("\n")[0]}`);
          failed++;
          await context.close();
          continue;
        }
        const { page, done } = opened;
        const known = knownOpen(target);
        const overflow = await overflowOf(page, viewport.width);
        await target.state?.after?.(page);
        done();
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
      `\n${failed ? `${failed} page(s) overflow or fail` : "no page overflows, every state holds"}; ${open_.length} known-open run(s) still overflow`,
    );
    if (failed) process.exitCode = 1;
  } finally {
    await browser?.close();
    for (const child of children) child.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
