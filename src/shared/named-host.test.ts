import { expect, test } from "bun:test";

import { parseNamedHost } from "./named-host";

test("a name and a port: the page's origin and the socket's URL", () => {
  expect(parseNamedHost("Laptop.Example-Tailnet.ts.net:8445")).toEqual({
    hostname: "laptop.example-tailnet.ts.net",
    port: 8445,
    origin: "https://laptop.example-tailnet.ts.net:8445",
    wsUrl: "wss://laptop.example-tailnet.ts.net:8445",
  });
});

test("no port, or 443, is the default https port", () => {
  for (const value of ["laptop.example-tailnet.ts.net", "laptop.example-tailnet.ts.net:443"])
    expect(parseNamedHost(value)).toMatchObject({
      port: null,
      origin: "https://laptop.example-tailnet.ts.net",
      wsUrl: "wss://laptop.example-tailnet.ts.net",
    });
  expect(parseNamedHost("git.example.test.").hostname).toBe("git.example.test");
});

test("refused: IPs, loopback, single labels, URLs, bad ports", () => {
  for (const value of [
    "100.64.0.7",
    "100.64.0.7:8445",
    "localhost",
    "laptop",
    "https://laptop.example.test",
    "laptop.example.test/path",
    "laptop.example.test:0",
    "laptop.example.test:70000",
    "*.example.test",
    "-bad.example.test",
    "[fd7a::1]:8445",
    "0x7f.1",
    "laptop.0x10",
    "laptop.example.1",
    "",
  ])
    expect(() => parseNamedHost(value)).toThrow();
});
