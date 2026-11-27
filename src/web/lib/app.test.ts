import { describe, expect, test } from "bun:test";

import {
  appAddressOf,
  closedPageOf,
  installHelp,
  installStateOf,
  isServedApp,
  startCommand,
} from "./app";

const page = (origin: string) => {
  const url = new URL(origin);
  return { protocol: url.protocol, host: url.host };
};
const pairing = (host: string) => ({ host, token: "t".repeat(43) });

describe("is this page the app nod serve serves", () => {
  test("paired with the very host that served it", () => {
    expect(isServedApp(page("http://127.0.0.1:4518"), pairing("ws://127.0.0.1:4518"))).toBe(true);
    expect(isServedApp(page("https://nod.example.test"), pairing("wss://nod.example.test"))).toBe(
      true,
    );
  });

  test("the hosted UI, the dev server, another port, or no pairing: no", () => {
    expect(isServedApp(page("https://ui.nod.frebreco.de"), pairing("ws://127.0.0.1:4518"))).toBe(
      false,
    );
    expect(isServedApp(page("http://localhost:4517"), pairing("ws://127.0.0.1:4518"))).toBe(false);
    expect(isServedApp(page("http://127.0.0.1:4519"), pairing("ws://127.0.0.1:4518"))).toBe(false);
    expect(isServedApp(page("http://127.0.0.1:4518"), pairing("wss://127.0.0.1:4518"))).toBe(false);
    expect(isServedApp(page("http://127.0.0.1:4518"), null)).toBe(false);
    expect(isServedApp(null, pairing("ws://127.0.0.1:4518"))).toBe(false);
  });

  test("the app's address from a loopback pairing, else the default port", () => {
    expect(appAddressOf(pairing("ws://127.0.0.1:4523"))).toBe("http://127.0.0.1:4523");
    expect(appAddressOf(pairing("wss://nod.example.test"))).toBe("http://127.0.0.1:4518");
    expect(appAddressOf(null)).toBe("http://127.0.0.1:4518");
  });
});

describe("install", () => {
  const base = { standalone: false, installed: false, prompt: false, servedApp: true };
  test("running as the app wins, then installed, then the browser's prompt", () => {
    expect(installStateOf({ ...base, standalone: true, prompt: true })).toBe("running");
    expect(installStateOf({ ...base, installed: true, prompt: true })).toBe("installed");
    expect(installStateOf({ ...base, prompt: true })).toBe("prompt");
    expect(installStateOf(base)).toBe("manual");
    expect(installStateOf({ ...base, servedApp: false })).toBe("elsewhere");
  });

  test("how each browser installs", () => {
    const chrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
    const edge = `${chrome} Edg/157.0.0.0`;
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
    const ios =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
    const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0";
    const android =
      "Mozilla/5.0 (Linux; Android 16; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36";
    expect(installHelp(chrome).browser).toBe("Chrome");
    expect(installHelp(edge).browser).toBe("Edge");
    expect(installHelp(safari).how).toContain("Add to Dock");
    expect(installHelp(ios).how).toContain("Add to Home Screen");
    expect(installHelp(firefox).how).toContain("does not install");
    expect(installHelp(android).browser).toBe("Chrome on Android");
    expect(installHelp("curl/8").browser).toBe("this browser");
  });
});

describe("nod serve isn't running", () => {
  test("the first try connects; one drop reconnects; a failed retry says it is not running", () => {
    expect(closedPageOf("connecting", 0)).toBe("connecting");
    expect(closedPageOf("closed", 1)).toBe("reconnecting");
    expect(closedPageOf("connecting", 1)).toBe("connecting");
    expect(closedPageOf("closed", 2)).toBe("not-running");
    // While it retries, the page does not flip back to "connecting".
    expect(closedPageOf("connecting", 2)).toBe("not-running");
    expect(closedPageOf("closed", 9)).toBe("not-running");
  });

  test("not about the server being away: no such page", () => {
    for (const status of ["open", "unpaired", "refused", "outdated"] as const)
      expect(closedPageOf(status, 5)).toBeNull();
  });

  test("the command names the named host on its page", () => {
    expect(startCommand(null)).toBe("nod serve");
    expect(startCommand("nod.example.test")).toBe("nod serve --allow-host nod.example.test");
  });
});
