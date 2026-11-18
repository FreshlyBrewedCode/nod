/**
 * Puts `nod serve` together: the source (fake or GitHub), the signer, the
 * session, the socket, the token and the host link. `cli.ts` parses flags
 * and prints; tests call this with a temp token file and port 0.
 */

import { systemClock, type Clock } from "./clock";
import { FakeSource, scenarioHasKey, type FakeScenario } from "./fake-source";
import { githubSource } from "./github-source";
import { serve, type Serving } from "./server";
import { Session } from "./session";
import { FakeSigner, keyFileSigner, type Signer } from "./signer";
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
  readonly clock?: Clock;
}

export interface Started {
  readonly serving: Serving;
  readonly token: string;
  readonly wsUrl: string;
  readonly link: string;
  readonly session: Session;
  readonly source: Source;
  readonly signer: Signer;
  stop(): Promise<void>;
}

export function start(options: StartOptions): Started {
  const clock = options.clock ?? systemClock;
  const fake = options.fake ?? null;
  // Fails with "not implemented yet" for the real source and signer.
  const source: Source = fake
    ? new FakeSource({
        clock,
        scenario: fake.scenario,
        live: fake.live,
        ...(options.repo && { repo: options.repo }),
      })
    : githubSource({ clock, repo: options.repo ?? null });
  const signer: Signer = fake
    ? new FakeSigner(clock, { hasKey: scenarioHasKey(fake.scenario) })
    : keyFileSigner(clock);
  const version = isRelease(options.version) ? options.version : null;
  const session = new Session({ source, signer, clock, version, fake: fake !== null });
  const token = loadOrCreateToken(options.tokenFile, { fresh: options.newToken ?? false });
  let serving: Serving;
  try {
    serving = serve({
      port: options.port,
      token,
      allowedOrigins: allowedOrigins(options.webUrl),
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
