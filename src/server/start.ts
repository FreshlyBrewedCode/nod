/**
 * Puts `nod serve` together: the source (fake or GitHub), the signer, the
 * session, the socket, the token and the host link. `cli.ts` parses flags
 * and prints; tests call this with a temp token file and port 0.
 */

import { systemClock, type Clock } from "./clock";
import { FakeSource, scenarioHasKey, type FakeScenario } from "./fake-source";
import { githubSource } from "./github-source";
import type { NamedHost } from "./named-host";
import { serve, type Serving } from "./server";
import { Session } from "./session";
import { FakeSigner, type Signer } from "./signer";
import { KeyFileSigner } from "./signer/key-file-signer";
import { defaultKeyFile } from "./signer/key-store";
import type { Source } from "./source";
import { loadOrCreateToken, remoteTokenFile } from "./token";
import { allowedOrigins, hostLink, isRelease, serverUrl } from "./web-url";

export interface StartOptions {
  readonly port: number;
  readonly webUrl: string;
  readonly tokenFile: string;
  /** Replace both stored tokens (unpairs every browser, on both sides). */
  readonly newToken?: boolean;
  /** Replace only the remote token (unpairs the other device). */
  readonly newRemoteToken?: boolean;
  readonly version: string | null;
  /** Serve the fake data set instead of GitHub. */
  readonly fake?: { readonly scenario: FakeScenario; readonly live: boolean } | null;
  readonly repo?: string | null;
  /** The GitHub host; default: the one of the clone's remote (`--host`, for an ssh alias). */
  readonly host?: string | null;
  /** The clone the GitHub source reads patch-ids from (default: the current folder). */
  readonly dir?: string;
  /** How often the GitHub source polls (default 60 s). */
  readonly pollMs?: number;
  readonly clock?: Clock;
  /** The signing key file (default `$XDG_CONFIG_HOME/nod/signing-key.json`); not with `fake`. */
  readonly keyFile?: string;
  /**
   * `--allow-host`: the TLS proxy's name in front of this port (ADR 0005).
   * The server then also serves the built web app (`webRoot`) on that name,
   * with the remote token, and `deviceLink` pairs a browser on another
   * device with it.
   */
  readonly namedHost?: { readonly host: NamedHost; readonly webRoot: string } | null;
}

export interface Started {
  readonly serving: Serving;
  readonly token: string;
  readonly wsUrl: string;
  readonly link: string;
  /** The remote token, with a named host. */
  readonly remoteToken: string | null;
  /** The device link: the host link on the named host, when there is one. */
  readonly deviceLink: string | null;
  readonly session: Session;
  readonly source: Source;
  readonly signer: Signer;
  stop(): Promise<void>;
}

export function start(options: StartOptions): Started {
  const clock = options.clock ?? systemClock;
  const fake = options.fake ?? null;
  // First, as it starts nothing: a damaged key file fails before any polling.
  const signer: Signer = fake
    ? new FakeSigner(clock, { hasKey: scenarioHasKey(fake.scenario) })
    : new KeyFileSigner({ clock, file: options.keyFile ?? defaultKeyFile() });
  // A folder that is not a clone of the repo fails here, before the socket opens.
  const source: Source = fake
    ? new FakeSource({
        clock,
        scenario: fake.scenario,
        live: fake.live,
        ...(options.repo && { repo: options.repo }),
      })
    : githubSource({
        clock,
        repo: options.repo ?? null,
        host: options.host ?? null,
        ...(options.dir !== undefined && { dir: options.dir }),
        ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
        ...(options.version && { version: options.version }),
        myKey: () => {
          const status = signer.status();
          return status.state === "no-key" ? null : status.key.publicKey;
        },
      });
  const version = isRelease(options.version) ? options.version : null;
  const session = new Session({ source, signer, clock, version, fake: fake !== null });
  const named = options.namedHost ?? null;
  const token = loadOrCreateToken(options.tokenFile, { fresh: options.newToken ?? false });
  // Renewed even without a named host, so a lost phone's token is dead
  // before the next `--allow-host`.
  const renewRemote = (options.newToken ?? false) || (options.newRemoteToken ?? false);
  const remoteToken =
    named || renewRemote
      ? loadOrCreateToken(remoteTokenFile(options.tokenFile), { fresh: renewRemote })
      : null;
  let serving: Serving;
  try {
    serving = serve({
      port: options.port,
      token,
      allowedOrigins: allowedOrigins(options.webUrl),
      namedHost: named && {
        hostname: named.host.hostname,
        origin: named.host.origin,
        token: remoteToken!,
        webRoot: named.webRoot,
      },
      session,
      version,
    });
  } catch (error) {
    session.stop();
    source.stop();
    signer.stop();
    throw error;
  }
  const wsUrl = serverUrl(serving.port);
  return {
    serving,
    token,
    wsUrl,
    link: hostLink(options.webUrl, wsUrl, token),
    remoteToken: named ? remoteToken : null,
    deviceLink: named ? hostLink(named.host.origin, named.host.wsUrl, remoteToken!) : null,
    session,
    source,
    signer,
    async stop() {
      await serving.stop();
      source.stop();
      signer.stop();
    },
  };
}
