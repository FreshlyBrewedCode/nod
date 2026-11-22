/**
 * Calm full-page messages for when there is no dashboard to show: not
 * paired, connecting, `nod serve` not running, a refused pairing, a version
 * mismatch. Onboarding and a deep link before pairing have their own pages.
 */

import type * as React from "react";

import type { Status } from "@/lib/connection";
import { Logo, TopBarShell } from "./top-bar";

export function FullPage({
  title,
  children,
  command,
}: {
  title: string;
  children?: React.ReactNode;
  command?: string;
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
          <h1 className="m-0 mb-1.5 text-[22px] font-bold tracking-[-0.01em]">{title}</h1>
          <div className="text-tx2 [&_p]:m-0 [&_p+p]:mt-2">{children}</div>
          {command && (
            <div className="bg-bg border-line text-tx fs-note my-4 mb-0 flex items-center gap-2.5 overflow-x-auto rounded-lg border px-3.5 py-2.5 font-mono phone:select-all">
              {command}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/** The page for a connection that is not open (and never was, or is gone). */
export function ConnectionPage({ status, reconnects }: { status: Status; reconnects: number }) {
  switch (status) {
    case "unpaired":
      return (
        <FullPage title="Open nod from your terminal" command="nod serve">
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
          <p>They speak different versions of their protocol. Update nod and reload this page.</p>
        </FullPage>
      );
    case "closed":
      return (
        <FullPage title="Waiting for nod serve" command="nod serve">
          <p>
            {reconnects > 1
              ? "It is not running, or it stopped. This page reconnects on its own once it is back."
              : "Reconnecting…"}
          </p>
        </FullPage>
      );
    case "connecting":
    case "open":
      return <FullPage title="Connecting to nod serve…" />;
  }
}
