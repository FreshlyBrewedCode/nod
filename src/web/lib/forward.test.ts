import { describe, expect, test } from "bun:test";

import { prDeepLink } from "../../kit/sticky.ts";
import { pastedHostLink, type KeyValue, type PageOrigin } from "./connection";
import {
  FORWARD_KEY,
  confirmOf,
  forgetForward,
  forwardSetupUrl,
  forwardUrl,
  forwardsHere,
  hostOf,
  hostParts,
  loadForward,
  namedOriginOf,
  offerFor,
  saveForward,
} from "./forward";
import { parseRoute, type LinkRoute } from "./route";

const NAMED = "https://laptop.example-tailnet.ts.net:8445";
const HOSTED: PageOrigin = { protocol: "https:", host: "ui.nod.frebreco.de" };
const DEV: PageOrigin = { protocol: "http:", host: "localhost:4517" };
const PHONE: PageOrigin = { protocol: "https:", host: "laptop.example-tailnet.ts.net:8445" };
const OTHER: PageOrigin = { protocol: "https:", host: "nod.example.test" };

function memory(entries: Record<string, string> = {}): KeyValue & { map: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const link = (hash: string) => parseRoute(hash) as LinkRoute;

describe("namedOriginOf: the hosts a forward may go to", () => {
  test("an https origin with a DNS name, normalized", () => {
    expect(namedOriginOf(NAMED)).toBe(NAMED);
    expect(namedOriginOf(`${NAMED}/`)).toBe(NAMED);
    expect(namedOriginOf("HTTPS://Laptop.Example-Tailnet.TS.NET:8445")).toBe(NAMED);
    expect(namedOriginOf("https://nod.example.test")).toBe("https://nod.example.test");
    expect(namedOriginOf("https://nod.example.test:443")).toBe("https://nod.example.test");
    expect(namedOriginOf("https://nod.example.test.")).toBe("https://nod.example.test");
  });

  test("refused: other schemes, and anything but an origin", () => {
    for (const value of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "javascript://nod.example.test/%0aalert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://nod.example.test",
      "ws://nod.example.test",
      "wss://nod.example.test",
      "file:///etc/passwd",
      "//nod.example.test",
      "nod.example.test",
      "nod.example.test:8445",
      " https://nod.example.test",
      "https://nod.example.test ",
      "https://nod.example.test/path",
      "https://nod.example.test/#/pr/a/b/1",
      "https://nod.example.test?x=1",
      "https://nod.example.test#x",
      "https://nod.example.test//",
      "https:/nod.example.test",
      "https:\\\\nod.example.test",
      "https://nod.example.test\\@evil.example",
      "https://\tnod.example.test",
      `https://${"a".repeat(300)}.test`,
    ])
      expect(namedOriginOf(value)).toBeNull();
  });

  test("refused: userinfo and suffix tricks", () => {
    for (const value of [
      "https://user@nod.example.test",
      "https://user:pass@nod.example.test",
      "https://nod.example.test@evil.example",
      "https://nod.example.test:8445@evil.example",
      "https://nod.example.test%2eevil.example",
      "https://nod.example.test%40evil.example",
      "https://nod.example.test%2F@evil.example",
      "https://evil.example/nod.example.test",
      "https://evil.example#.nod.example.test",
      "https://evil.example?.nod.example.test",
      "https://nod.example.test.evil.example/..",
    ])
      expect(namedOriginOf(value)).toBeNull();
    // A suffix that is a real other host passes the rule: what tells it
    // apart is the confirmation page, which shows the whole name.
    expect(namedOriginOf("https://nod.example.test.evil.example")).toBe(
      "https://nod.example.test.evil.example",
    );
  });

  test("refused: IP literals, names a browser reads as one, loopback", () => {
    for (const value of [
      "https://100.64.0.7",
      "https://100.64.0.7:8445",
      "https://127.0.0.1",
      "https://2130706433",
      "https://0x7f000001",
      "https://0x7f.1",
      "https://127.1",
      "https://laptop.0x10",
      "https://laptop.example.1",
      "https://[::1]",
      "https://[fd7a:115c:a1e0::1]:8445",
      "https://localhost",
      "https://localhost:4518",
      "https://laptop",
    ])
      expect(namedOriginOf(value)).toBeNull();
  });

  test("refused: bad ports, wildcards, punycode, non-ASCII", () => {
    for (const value of [
      "https://nod.example.test:0",
      "https://nod.example.test:65536",
      "https://nod.example.test:84a5",
      "https://nod.example.test:",
      "https://*.example.test",
      "https://-nod.example.test",
      "https://xn--nd-fka.example.test",
      "https://nod.xn--e1afmkfd.test",
      "https://nöd.example.test",
      "https://nod.exаmple.test", // a Cyrillic а
    ])
      expect(namedOriginOf(value)).toBeNull();
  });

  test("hostParts: breaks after dots and before the port, hyphens glued to what follows", () => {
    const parts = hostParts(hostOf(NAMED));
    expect(parts.map((label) => label.map((p) => p.text).join(""))).toEqual([
      "laptop.",
      "example-tailnet.",
      "ts.",
      "net",
      ":8445",
    ]);
    expect(parts[1]).toEqual([
      { text: "example", glued: false },
      { text: "-t", glued: true },
      { text: "ailnet.", glued: false },
    ]);
    expect(hostParts("a--b-.c")[0]).toEqual([
      { text: "a", glued: false },
      { text: "--b", glued: true },
      { text: "-.", glued: true },
    ]);
    for (const host of ["nod.example.test", "x-y-z.example-tailnet.ts.net:1"])
      expect(
        hostParts(host)
          .flat()
          .map((p) => p.text)
          .join(""),
      ).toBe(host);
  });

  test("hostOf shows the name and the port", () => {
    expect(hostOf(NAMED)).toBe("laptop.example-tailnet.ts.net:8445");
    expect(hostOf("https://nod.example.test")).toBe("nod.example.test");
  });
});

describe("the remembered host", () => {
  test("saved, loaded, forgotten", () => {
    const storage = memory();
    expect(loadForward(storage)).toBeNull();
    expect(saveForward(storage, NAMED, 1000)).toBe(true);
    expect(loadForward(storage)).toEqual({ to: NAMED, since: 1000 });
    forgetForward(storage);
    expect(loadForward(storage)).toBeNull();
    expect(storage.map.has(FORWARD_KEY)).toBe(false);
  });

  test("only a checked origin is saved", () => {
    const storage = memory();
    for (const to of ["https://127.0.0.1", "javascript:alert(1)", `${NAMED}/`, "HTTPS://A.B.C"])
      expect(saveForward(storage, to, 1)).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  test("an entry that breaks the rule (planted, or an older rule) is dropped", () => {
    for (const raw of [
      JSON.stringify({ to: "https://127.0.0.1:4518", since: 1 }),
      JSON.stringify({ to: "javascript:alert(1)", since: 1 }),
      JSON.stringify({ to: `${NAMED}/#/pr/a/b/1`, since: 1 }),
      JSON.stringify({ to: NAMED }),
      JSON.stringify({ to: NAMED, since: "yesterday" }),
      JSON.stringify("https://nod.example.test"),
      "{broken",
    ]) {
      const storage = memory({ [FORWARD_KEY]: raw });
      expect(loadForward(storage)).toBeNull();
    }
    const kept = memory({ [FORWARD_KEY]: JSON.stringify({ to: NAMED, since: 5 }) });
    expect(loadForward(kept)).toEqual({ to: NAMED, since: 5 });
  });

  test("blocked storage reads as nothing and never throws", () => {
    const blocked: KeyValue = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadForward(blocked)).toBeNull();
    expect(saveForward(blocked, NAMED, 1)).toBe(false);
    expect(() => forgetForward(blocked)).not.toThrow();
    expect(loadForward(null)).toBeNull();
  });
});

describe("forwardUrl: the route, rebuilt, on the named host", () => {
  test("a PR, a batch, another GitHub host, the list", () => {
    expect(forwardUrl(NAMED, link("#/pr/tallyho/fieldbook/7"))).toBe(
      `${NAMED}/#/pr/tallyho/fieldbook/7`,
    );
    expect(forwardUrl(NAMED, link("#/batch/tallyho/fieldbook/7,9,7"))).toBe(
      `${NAMED}/#/batch/tallyho/fieldbook/7,9`,
    );
    expect(forwardUrl(NAMED, link("#/pr/acme.ghe.com/tallyho/fieldbook/7"))).toBe(
      `${NAMED}/#/pr/acme.ghe.com/tallyho/fieldbook/7`,
    );
    expect(forwardUrl(NAMED, null)).toBe(`${NAMED}/`);
  });

  test("the link the verifier writes into a comment forwards to the same route", () => {
    const comment = prDeepLink("https://ui.nod.frebreco.de", "tallyho/fieldbook", 7);
    const hash = new URL(comment).hash;
    expect(forwardUrl(NAMED, link(hash))).toBe(`${NAMED}/${hash}`);
  });

  test("a route with a pairing behind it forwards without it", () => {
    const route = link("#/pr/tallyho/fieldbook/7?host=ws%3A%2F%2F127.0.0.1%3A4518&token=secret");
    const url = forwardUrl(NAMED, route)!;
    expect(url).toBe(`${NAMED}/#/pr/tallyho/fieldbook/7`);
    expect(url).not.toContain("token");
    expect(url).not.toContain("host=");
  });

  test("nothing in the route part leaves the named host", () => {
    for (const hash of [
      "#/pr/tallyho/fieldbook/7//evil.example",
      "#/pr/evil.example%2F..%2F/tallyho/fieldbook/7",
      "#/pr/%2F%2Fevil.example/tallyho/fieldbook/7",
      "#/pr/tallyho/fieldbook/7@evil.example",
      "#/pr/tallyho/fieldbook/7?to=https://evil.example",
      "#/pr/..%2F..%2Fevil.example/fieldbook/7",
      "#/batch/tallyho/fieldbook/7,javascript:alert(1)",
      "#/forward?to=https://evil.example",
    ]) {
      const route = parseRoute(hash);
      if (route.view !== "pr" && route.view !== "batch") continue; // the list: nothing to forward
      const url = forwardUrl(NAMED, route)!;
      expect(new URL(url).origin).toBe(NAMED);
      expect(url.startsWith(`${NAMED}/#/`)).toBe(true);
      expect(url).not.toContain("evil");
    }
  });

  test("never to a host the rule refuses", () => {
    const route = link("#/pr/tallyho/fieldbook/7");
    for (const to of ["https://127.0.0.1", "javascript:alert(1)//", `${NAMED}/x`, "http://a.b.c"])
      expect(forwardUrl(to, route)).toBeNull();
  });
});

describe("offerFor: what a deep link offers", () => {
  const route = link("#/pr/tallyho/fieldbook/7");
  const forward = { to: NAMED, since: 1 };

  test("a paired page shows its landing, whatever it remembers", () => {
    for (const page of [HOSTED, DEV, PHONE])
      expect(offerFor({ paired: true, page, forward, route })).toEqual({ kind: "paired" });
  });

  test("not paired, a host remembered: open it there", () => {
    expect(offerFor({ paired: false, page: HOSTED, forward, route })).toEqual({
      kind: "forward",
      to: NAMED,
      url: `${NAMED}/#/pr/tallyho/fieldbook/7`,
    });
    expect(offerFor({ paired: false, page: DEV, forward, route: null })).toEqual({
      kind: "forward",
      to: NAMED,
      url: `${NAMED}/`,
    });
  });

  test("not paired, nothing remembered: how to pair", () => {
    expect(offerFor({ paired: false, page: HOSTED, forward: null, route })).toEqual({
      kind: "pair",
    });
  });

  test("the named host's own page and other https pages never forward", () => {
    for (const page of [PHONE, OTHER])
      expect(offerFor({ paired: false, page, forward, route })).toEqual({ kind: "pair" });
    expect(forwardsHere(HOSTED)).toBe(true);
    expect(forwardsHere(DEV)).toBe(true);
    expect(forwardsHere(PHONE)).toBe(false);
  });
});

describe("confirmOf: the page #/forward shows", () => {
  test("a new host, the same one, a replacement", () => {
    expect(confirmOf(NAMED, null, HOSTED)).toEqual({ kind: "new", to: NAMED });
    expect(confirmOf(`${NAMED}/`, { to: NAMED, since: 3 }, HOSTED)).toEqual({
      kind: "same",
      to: NAMED,
      since: 3,
    });
    expect(confirmOf(NAMED, { to: "https://nod.example.test", since: 3 }, HOSTED)).toEqual({
      kind: "replace",
      to: NAMED,
      was: "https://nod.example.test",
    });
  });

  test("a host the rule refuses has nothing to remember", () => {
    expect(confirmOf("https://127.0.0.1:4518", null, HOSTED)).toEqual({
      kind: "invalid",
      given: "https://127.0.0.1:4518",
    });
    expect(confirmOf(null, null, HOSTED)).toEqual({ kind: "invalid", given: null });
  });

  test("a repeated to= is no host (the route says null)", () => {
    const route = parseRoute(`#/forward?to=${NAMED}&to=https://evil.example`);
    expect(route).toEqual({ view: "forward", to: null });
    expect(confirmOf(null, null, HOSTED).kind).toBe("invalid");
  });

  test("the named host's own page does not forward", () => {
    expect(confirmOf(NAMED, null, PHONE)).toEqual({ kind: "not-here" });
  });
});

describe("forwardSetupUrl: the named host's way to the hosted page", () => {
  test("on the named host: the hosted UI of its channel, carrying the origin only", () => {
    const next = forwardSetupUrl(PHONE, null)!;
    expect(next).toBe(`https://ui.nod.frebreco.de/next/#/forward?to=${encodeURIComponent(NAMED)}`);
    expect(forwardSetupUrl(PHONE, "1.4.0-next.3")).toBe(next);
    expect(forwardSetupUrl(PHONE, "1.4.0")).toBe(
      `https://ui.nod.frebreco.de/#/forward?to=${encodeURIComponent(NAMED)}`,
    );
    expect(next).not.toContain("token");
    // What the hosted page reads back from it.
    expect(parseRoute(new URL(next).hash)).toEqual({ view: "forward", to: NAMED });
  });

  test("nowhere else", () => {
    expect(forwardSetupUrl(HOSTED, null)).toBeNull();
    expect(forwardSetupUrl(DEV, null)).toBeNull();
    expect(forwardSetupUrl({ protocol: "http:", host: "nod.example.test" }, null)).toBeNull();
    expect(forwardSetupUrl({ protocol: "https:", host: "100.64.0.7:8445" }, null)).toBeNull();
    expect(forwardSetupUrl(null, null)).toBeNull();
  });
});

describe("pastedHostLink: pairing inside a home-screen app", () => {
  const device = `${NAMED}/#host=${encodeURIComponent("wss://laptop.example-tailnet.ts.net:8445")}&token=t0k`;

  test("the device link of this very page", () => {
    expect(pastedHostLink(device, PHONE)).toBe(new URL(device).hash);
    expect(pastedHostLink(`  ${device}\n`, PHONE)).toBe(new URL(device).hash);
  });

  test("refused: another page's link, a link that does not pair this page, no link", () => {
    expect(pastedHostLink(device, OTHER)).toBeNull();
    expect(pastedHostLink(`${NAMED}/#/pr/tallyho/fieldbook/7`, PHONE)).toBeNull();
    // The named host's page never pairs with loopback, not even from its own link.
    expect(
      pastedHostLink(`${NAMED}/#host=${encodeURIComponent("ws://127.0.0.1:4518")}&token=t`, PHONE),
    ).toBeNull();
    expect(pastedHostLink("t0k", PHONE)).toBeNull();
    expect(pastedHostLink("javascript:alert(1)", PHONE)).toBeNull();
  });
});
