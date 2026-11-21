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
import { loadOrCreateToken } from "./token";
import { allowedOrigins, hostLink, isRelease, serverUrl } from "./web-url";

export interface StartOptions {
  readonly port: number;
  readonly webUrl: string;
  readonly tokenFile: string;
  /** Replace the stored token (unpairs every browser). */
  readonly newToken?: boolean;
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
   * `--allow-host`: the TLS proxy's name in front of this port (finding 04).
   * The server then also serves the built web app (`webRoot`) on that name,
   * and `phoneLink` pairs a browser on another device with it.
   */
  readonly namedHost?: NamedHost | null;
  /** The built web app (`dist/web`), needed with `namedHost`. */
  readonly webRoot?: string | null;
}

export interface Started {
  readonly serving: Serving;
  readonly token: string;
  readonly wsUrl: string;
  readonly link: string;
  /** The host link on the named host, when there is one. */
  readonly phoneLink: string | null;
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
  let serving: Serving;
  try {
    serving = serve({
      port: options.port,
      token,
      allowedOrigins: [...allowedOrigins(options.webUrl), ...(named ? [named.origin] : [])],
      namedHost: named?.hostname ?? null,
      webRoot: named ? (options.webRoot ?? null) : null,
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
    phoneLink: named ? hostLink(named.origin, named.wsUrl, token) : null,
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
