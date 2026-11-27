/**
 * Calm full-page messages for when there is no dashboard to show: not
 * paired, connecting, `nod serve` not running, a refused pairing, a version
 * mismatch, a page inside another's frame. Not signed in to GitHub and no
 * repo picked (`onboarding.tsx`) use it too; a deep link before pairing has
 * its own page.
 */

import type * as React from "react";

import { PROTOCOL_VERSION } from "../../shared/protocol";
import { SERVICE_HINT, closedPageOf, startCommand } from "@/lib/app";
import type { Status } from "@/lib/connection";
import type { Offer } from "@/lib/forward";
import { ForwardOffer, PasteLink } from "./forward";
import { Logo, TopBarShell } from "./top-bar";

export function FullPage({
  title,
  children,
  command,
  after,
}: {
  title: string;
  children?: React.ReactNode;
  command?: string;
  /** Below the command. */
  after?: React.ReactNode;
}) {
  return (
    <div className="pt-safe pb-safe px-safe flex min-h-full flex-col">
      <TopBarShell>
        <Logo />
      </TopBarShell>
      <main
        className="mx-auto mt-24 w-full max-w-[560px] px-6 phone:mt-6 phone:px-4"
        aria-live="polite"
      >
        <div className="border-line bg-panel rounded-2xl border px-9 py-8 phone:px-5 phone:py-6">
          {title && (
            <h1 className="m-0 mb-1.5 text-[22px] font-bold tracking-[-0.01em]">{title}</h1>
          )}
          <div className="text-tx2 [&_p]:m-0 [&_p+p]:mt-2">{children}</div>
          {command && (
            <div className="bg-bg border-line text-tx fs-note my-4 mb-0 flex items-center gap-2.5 overflow-x-auto rounded-lg border px-3.5 py-2.5 font-mono phone:select-all">
              {command}
            </div>
          )}
          {after}
        </div>
      </main>
    </div>
  );
}

/**
 * The web app inside another page's frame (`lib/guard.ts`): it refuses, the
 * whole app, since it has the passphrase field and the confirmation that
 * remembers a host. Nothing here reads the fragment or opens a socket.
 */
export function FramedPage() {
  return (
    <FullPage title="nod does not run inside another page">
      <p>
        Another site shows this page inside its own. nod pairs with your machine and asks for your
        passphrase, so it runs only in a tab of its own.
      </p>
      <p>Nothing was paired or remembered. Open nod from your browser’s address bar.</p>
    </FullPage>
  );
}

/**
 * How this page pairs, when it is not paired: from the host link (a page on
 * the hosted UI or this machine), from the device link (the named host's
 * page), and, in a home-screen app, by pasting the link. `host` is the
 * named host's own `name[:port]`, for the command to show.
 */
export interface Unpaired {
  readonly offer: Offer;
  readonly onForget: () => void;
  readonly host: string | null;
  readonly standalone: boolean;
  /** The page is the app `nod serve` serves (ADR 0008): it opened from the cache. */
  readonly servedApp?: boolean;
}

/** The page for a connection that is not open (and never was, or is gone). */
export function ConnectionPage({
  status,
  reconnects,
  unpaired,
  serverProtocol = null,
}: {
  status: Status;
  reconnects: number;
  unpaired?: Unpaired;
  /** `outdated`: the protocol the server speaks, to say which side is older. */
  serverProtocol?: number | null;
}) {
  switch (status) {
    case "unpaired":
      if (unpaired?.offer.kind === "forward")
        return (
          <FullPage title="">
            <ForwardOffer
              offer={unpaired.offer}
              title="Open your nod"
              what="your nod"
              onForget={unpaired.onForget}
            />
          </FullPage>
        );
      if (unpaired?.host)
        return (
          <FullPage
            title="Pair this device with nod serve"
            command={`nod serve --allow-host ${unpaired.host}`}
            after={unpaired.standalone && <PasteLink />}
          >
            <p>
              This page talks only to <code className="font-mono">nod serve</code> on your machine,
              through this address. Start it there with this address, and scan the QR code it prints
              with this device’s camera; that pairs this browser once.
            </p>
          </FullPage>
        );
      return (
        <FullPage
          title="Open nod from your terminal"
          command="nod serve"
          after={unpaired?.standalone && <PasteLink />}
        >
          <p>
            This page talks only to <code className="font-mono">nod serve</code> on your machine.
            Start it and open the link it prints; that pairs this browser once.
          </p>
        </FullPage>
      );
    case "refused":
      return (
        <FullPage title="Pair this browser again" command="nod serve">
          <p>
            <code className="font-mono">nod serve</code> does not accept this browser’s pairing any
            more. Open the link it prints in your terminal again.
          </p>
        </FullPage>
      );
    case "outdated":
      return (
        <FullPage title="nod serve and this page do not match">
          <p>
            {serverProtocol !== null && serverProtocol < PROTOCOL_VERSION ? (
              <>
                <code className="font-mono">nod serve</code> is older than this page. Update nod,
                start <code className="font-mono">nod serve</code> again, then reload this page.
              </>
            ) : serverProtocol !== null && serverProtocol > PROTOCOL_VERSION ? (
              <>
                This page is older than <code className="font-mono">nod serve</code>. Reload it to
                get the newer one; if it stays, open the link{" "}
                <code className="font-mono">nod serve</code> prints.
              </>
            ) : (
              "They speak different versions of their protocol. Update nod and reload this page."
            )}
          </p>
        </FullPage>
      );
    case "closed":
    case "connecting": {
      const page = closedPageOf(status, reconnects);
      if (page === "not-running")
        return <NotRunningPage host={unpaired?.host ?? null} app={unpaired?.servedApp ?? false} />;
      if (page === "reconnecting")
        return (
          <FullPage title="Waiting for nod serve">
            <p>Reconnecting…</p>
          </FullPage>
        );
      return <FullPage title="Connecting to nod serve…" />;
    }
    case "open":
      return <FullPage title="Connecting to nod serve…" />;
  }
}

/**
 * The socket cannot reach `nod serve` and a retry failed too (ADR 0008 §7):
 * the installed app opened from its cache, or the server stopped before a
 * snapshot came. The command to start it, the service that keeps it
 * running, and that this page carries on by itself: it retries quietly
 * (the usual backoff, and at once when the window shows again).
 */
export function NotRunningPage({ host, app }: { host: string | null; app: boolean }) {
  return (
    <FullPage
      title="nod serve isn’t running"
      command={startCommand(host)}
      after={
        <p className="text-tx3 fs-note m-0 mt-4 leading-[1.55]">
          To keep it running in the background, <code className="font-mono">{SERVICE_HINT}</code>{" "}
          sets it up as a service (not released yet).
        </p>
      }
    >
      <p>
        {app ? "This app" : "This page"} talks to <code className="font-mono">nod serve</code> on
        your machine, and it is not answering. Start it in a terminal{host ? " there" : ""}; this{" "}
        {app ? "app" : "page"} reconnects on its own once it is back.
      </p>
    </FullPage>
  );
}
