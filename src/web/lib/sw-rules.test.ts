import { describe, expect, test } from "bun:test";

import {
  activatedMessage,
  cacheName,
  precacheList,
  shellInstead,
  staleCaches,
  strategyFor,
} from "./sw-rules";
import { pageBuild, registersWorker, shouldReload } from "./sw-register";

const APP = "http://127.0.0.1:4518";
const get = (path: string, mode = "cors") => ({ method: "GET", url: `${APP}${path}`, mode });

describe("the service worker's cache", () => {
  test("keyed by the build; every other build's cache goes, nobody else's", () => {
    expect(cacheName("e2523b67639f277f")).toBe("nod-shell-e2523b67639f277f");
    expect(
      staleCaches(
        ["nod-shell-aaaa", "nod-shell-bbbb", "someone-else", "nod-shell-cccc"],
        "nod-shell-bbbb",
      ),
    ).toEqual(["nod-shell-aaaa", "nod-shell-cccc"]);
  });

  test("what it caches: the shell first, the build's files, never itself or a source map", () => {
    expect(
      precacheList([
        "assets/index-x.js",
        "sw.js",
        "assets/index-x.js.map",
        "./icon.svg",
        "index.html",
      ]),
    ).toEqual(["index.html", "assets/index-x.js", "icon.svg"]);
  });
});

describe("how a request is answered", () => {
  test("navigations: the network, else the shell; assets from the cache; the rest network first", () => {
    expect(strategyFor(get("/", "navigate"), APP)).toBe("shell");
    expect(strategyFor(get("/pr/tallyho/fieldbook/7", "navigate"), APP)).toBe("shell");
    expect(strategyFor(get("/assets/index-x.js"), APP)).toBe("cache-first");
    expect(strategyFor(get("/manifest.webmanifest"), APP)).toBe("network-first");
  });

  test("never the socket, /health, a token, another origin, or anything but GET", () => {
    expect(strategyFor(get("/ws?token=abc"), APP)).toBe("pass");
    expect(strategyFor(get("/ws"), APP)).toBe("pass");
    expect(strategyFor(get("/health"), APP)).toBe("pass");
    expect(strategyFor(get("/?token=abc", "navigate"), APP)).toBe("pass");
    expect(strategyFor(get("/assets/x.js?x=1&Token=abc"), APP)).toBe("pass");
    expect(strategyFor({ method: "POST", url: `${APP}/`, mode: "navigate" }, APP)).toBe("pass");
    expect(strategyFor({ method: "HEAD", url: `${APP}/`, mode: "cors" }, APP)).toBe("pass");
    expect(
      strategyFor({ method: "GET", url: "https://ui.nod.frebreco.de/", mode: "navigate" }, APP),
    ).toBe("pass");
    expect(
      strategyFor({ method: "GET", url: "http://localhost:4518/", mode: "navigate" }, APP),
    ).toBe("pass");
  });

  test("the shell instead of a failed navigation or a proxy's 5xx, never instead of an answer", () => {
    expect(shellInstead(null)).toBe(true);
    expect(shellInstead({ status: 502 })).toBe(true);
    expect(shellInstead({ status: 503 })).toBe(true);
    expect(shellInstead({ status: 200 })).toBe(false);
    expect(shellInstead({ status: 404 })).toBe(false);
    expect(shellInstead({ status: 421 })).toBe(false);
  });
});

describe("the page's side", () => {
  const page = (origin: string) => {
    const url = new URL(origin);
    return { protocol: url.protocol, host: url.host };
  };

  test("registered by a production build on the app's pages only", () => {
    const yes = { prod: true, hasWorkers: true };
    expect(registersWorker({ ...yes, page: page(APP) })).toBe(true);
    expect(registersWorker({ ...yes, page: page("https://nod.example.test") })).toBe(true);
    expect(registersWorker({ ...yes, page: page("https://ui.nod.frebreco.de") })).toBe(false);
    expect(registersWorker({ ...yes, prod: false, page: page("http://localhost:4517") })).toBe(
      false,
    );
    expect(registersWorker({ ...yes, hasWorkers: false, page: page(APP) })).toBe(false);
  });

  test("the page's build from its meta tag", () => {
    const doc = (content: string | null) => ({
      querySelector: () =>
        content === null ? null : ({ getAttribute: () => content } as unknown as Element),
    });
    expect(pageBuild(doc("e2523b67639f277f"))).toBe("e2523b67639f277f");
    expect(pageBuild(doc(null))).toBeNull();
    expect(pageBuild(doc("<script>"))).toBeNull();
  });

  test("a page of another build reloads once a new worker took over; the same build does not", () => {
    expect(shouldReload("aaaa1111", activatedMessage("bbbb2222"))).toBe(true);
    expect(shouldReload("aaaa1111", activatedMessage("aaaa1111"))).toBe(false);
    // A page without a build (dev, an old build) never reloads by itself.
    expect(shouldReload(null, activatedMessage("bbbb2222"))).toBe(false);
    expect(shouldReload("aaaa1111", { t: "other", build: "bbbb2222" })).toBe(false);
    expect(shouldReload("aaaa1111", null)).toBe(false);
  });
});
