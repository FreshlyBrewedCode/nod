/**
 * Puts `nod serve` together: the source (fake or GitHub), the signer, the
 * session, the socket, the token and the host link. `cli.ts` parses flags
 * and prints; tests call this with a temp token file and port 0.
 */

import { unsupportedManager } from "../service/manager";
import { AppControl, type AppSeams } from "./app-control";
import { systemClock, type Clock } from "./clock";
import { fakeApp, type FakeInstall, type FakeService, type FakeUpdate } from "./fake-app";
import { FakeSource, scenarioHasKey, type FakeScenario } from "./fake-source";
import { githubSource } from "./github-source";
import type { NamedHost } from "../shared/named-host";
import { serve, type Serving } from "./server";
import { Session } from "./session";
import { FakeSigner, type Signer } from "./signer";
import { KeyFileSigner } from "./signer/key-file-signer";
import { defaultKeyFile } from "./signer/key-store";
import type { Source } from "./source";
import { loadOrCreateToken, remoteTokenFile } from "./token";
import { createInstaller, FakeReleaseFeed, memoryChannelStore } from "./update";
import { allowedOrigins, appUrl, hostLink, isRelease, serverUrl } from "./web-url";
import { startInbox, type StartedInbox } from "./inbox/setup";

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
  /**
   * `--dir`: the one clone the GitHub source serves instead of the list.
   * Without it the list is read, or, when it is empty, the current folder
   * when it is a clone.
   */
  readonly dir?: string;
  /** The repo list (default `$XDG_CONFIG_HOME/nod/config.json`). */
  readonly configFile?: string;
  /** nod's cache, its own clones (default `$XDG_CACHE_HOME/nod`). */
  readonly cacheDir?: string;
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
  /**
   * My own inbox (ADR 0009): its folder (`--inbox`; default
   * `$XDG_CONFIG_HOME/nod/inbox`, with `fake` the scenario's). null: none.
   */
  readonly inbox?: { readonly dir?: string } | null;
  /**
   * The built web app to serve on loopback, the installable app (ADR 0008);
   * `appLink` then pairs a browser with it. null: loopback serves no page.
   */
  readonly appRoot?: string | null;
  /**
   * The app's side (ADR 0008): updates, the channel, the background service.
   * `seams` gives the real ones and is called only without `fake` (a fake run
   * gets fakes, `fake-app.ts`); without it, a server that checks nothing and
   * has no service (tests). `serveArgs`: the flags this server was started
   * with, for setting the service up and the restart command.
   */
  readonly app?: {
    readonly seams?: () => AppSeams;
    readonly serveArgs?: ReadonlyArray<string>;
    /** A plain `nod serve` set the service up from the page: stop now (`cli.ts` exits). */
    readonly onHandOver?: () => void;
    /** With `fake`: the state the fake app starts in. */
    readonly fake?: {
      readonly update?: FakeUpdate;
      readonly service?: FakeService;
      readonly install?: FakeInstall;
    };
  };
}

/** No feed, no install method, no service: what `start()` gets without `app.seams`. */
export function inertAppSeams(): AppSeams {
  return {
    feed: new FakeReleaseFeed({ releases: [] }),
    installer: createInstaller({ method: null }),
    channelStore: memoryChannelStore(),
    service: unsupportedManager(process.platform),
  };
}

export interface Started {
  readonly serving: Serving;
  readonly token: string;
  readonly wsUrl: string;
  readonly link: string;
  /** The host link of the app on loopback, `http://127.0.0.1:<port>/#…`, when it is served. */
  readonly appLink: string | null;
  /** The remote token, with a named host. */
  readonly remoteToken: string | null;
  /** The device link: the host link on the named host, when there is one. */
  readonly deviceLink: string | null;
  readonly session: Session;
  readonly source: Source;
  readonly signer: Signer;
  readonly app: AppControl;
  readonly appSeams: AppSeams;
  /** My inbox's runner and service; null without one. */
  readonly inbox: StartedInbox | null;
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
        ...(options.configFile !== undefined && { configFile: options.configFile }),
        ...(options.cacheDir !== undefined && { cacheDir: options.cacheDir }),
        ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
        ...(options.version && { version: options.version }),
        myKey: () => {
          const status = signer.status();
          return status.state === "no-key" ? null : status.key.publicKey;
        },
      });
  const version = isRelease(options.version) ? options.version : null;
  // My own inbox: personal code in a subprocess, never the key or the token.
  const inbox =
    options.inbox === null
      ? null
      : startInbox({
          source,
          fake: fake?.scenario ?? null,
          ...(options.inbox?.dir !== undefined && { dir: options.inbox.dir }),
        });
  const named = options.namedHost ?? null;
  // A fake run never calls the real seams: they are not even built.
  const fakeAppState = fake ? fakeApp({ clock, ...options.app?.fake }) : null;
  const appSeams = fakeAppState?.seams ?? options.app?.seams?.() ?? inertAppSeams();
  let serving: Serving | null = null;
  let deviceLink: string | null = null;
  const app = new AppControl({
    ...appSeams,
    version: fakeAppState?.version ?? version,
    clock,
    serveArgs: options.app?.serveArgs ?? [],
    ...(fakeAppState && { isThisNod: fakeAppState.isThisNod }),
    namedOrigin: named?.host.origin ?? null,
    deviceLink: named
      ? async () => ({
          origin: named.host.origin,
          qr: (await import("./qr")).qrRows(deviceLink ?? named.host.origin),
        })
      : null,
    ...(options.app?.onHandOver && { onHandOver: options.app.onHandOver }),
    simulate: fake ? { onRestarted: () => serving?.reconnectAll() } : null,
  });
  const session = new Session({
    source,
    signer,
    clock,
    version,
    fake: fake !== null,
    app,
    inbox: inbox?.service ?? null,
  });
  const token = loadOrCreateToken(options.tokenFile, { fresh: options.newToken ?? false });
  // Renewed even without a named host, so a lost phone's token is dead
  // before the next `--allow-host`.
  const renewRemote = (options.newToken ?? false) || (options.newRemoteToken ?? false);
  const remoteToken =
    named || renewRemote
      ? loadOrCreateToken(remoteTokenFile(options.tokenFile), { fresh: renewRemote })
      : null;
  let served: Serving;
  try {
    served = serve({
      port: options.port,
      token,
      allowedOrigins: allowedOrigins(options.webUrl),
      namedHost: named && {
        hostname: named.host.hostname,
        origin: named.host.origin,
        token: remoteToken!,
        webRoot: named.webRoot,
      },
      appRoot: options.appRoot ?? null,
      session,
      version,
    });
  } catch (error) {
    session.stop();
    app.stop();
    inbox?.stop();
    source.stop();
    signer.stop();
    throw error;
  }
  serving = served;
  app.start();
  const wsUrl = serverUrl(served.port);
  deviceLink = named ? hostLink(named.host.origin, named.host.wsUrl, remoteToken!) : null;
  return {
    serving: served,
    token,
    wsUrl,
    link: hostLink(options.webUrl, wsUrl, token),
    appLink: options.appRoot ? hostLink(appUrl(served.port), wsUrl, token) : null,
    remoteToken: named ? remoteToken : null,
    deviceLink,
    session,
    source,
    signer,
    app,
    appSeams,
    inbox,
    async stop() {
      await served.stop();
      app.stop();
      inbox?.stop();
      source.stop();
      signer.stop();
    },
  };
}
