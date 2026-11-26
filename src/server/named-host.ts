/**
 * `nod serve --allow-host <name[:port]>`: the one named host, besides
 * loopback, the server answers to (spike, finding 04). It is the name a
 * TLS proxy in front of the loopback port serves, first of all
 * `tailscale serve --https=<port> http://127.0.0.1:<nod port>`, so a phone
 * on the tailnet opens `https://<machine>.<tailnet>.ts.net:<port>`.
 *
 * Only https and wss: the proxy terminates TLS, and plain `ws://` stays
 * loopback-only. The name is a DNS name, never an IP literal (a certificate
 * names a host) and never a loopback name (those are allowed anyway).
 */

export interface NamedHost {
  /** `machine.tailnet.ts.net`, lowercase. */
  readonly hostname: string;
  /** The proxy's https port; `null` is 443. */
  readonly port: number | null;
  /** `https://machine.tailnet.ts.net:8445`: the page's origin, and the web app's URL. */
  readonly origin: string;
  /** `wss://machine.tailnet.ts.net:8445`: the socket the page opens. */
  readonly wsUrl: string;
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Parse `--allow-host`; throws with a message for the CLI. */
export function parseNamedHost(value: string): NamedHost {
  const match = /^([^:/\s]+)(?::(\d{1,5}))?$/.exec(value.trim().toLowerCase());
  if (!match) throw new Error(`expected a host name with an optional port, not ${value}`);
  const hostname = match[1]!.replace(/\.$/, "");
  const labels = hostname.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)))
    throw new Error(`${hostname} is not a DNS name with a domain`);
  if (labels.every((label) => /^\d+$/.test(label)))
    throw new Error("an IP address has no certificate: use the proxy's host name");
  if (LOOPBACK.has(hostname)) throw new Error("loopback is allowed anyway");
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) throw new Error(`${match[2]} is not a port`);
  const authority = port === null || port === 443 ? hostname : `${hostname}:${port}`;
  return {
    hostname,
    port: port === 443 ? null : port,
    origin: `https://${authority}`,
    wsUrl: `wss://${authority}`,
  };
}
