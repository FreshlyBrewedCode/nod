/**
 * The web app root. For now a proof page for the connection to `nod serve`:
 * its state, who and which repo, the signer, and how the snapshot falls into
 * lanes and tiers. The attention dashboard (r3) replaces the page and builds
 * on `useConnection`.
 */
import { useEffect, useState } from "react";

import { attentionView, countByTier } from "../shared/attention";
import { Button } from "@/components/ui/button";
import { ConnectionProvider, useConnection } from "@/hooks/use-connection";

export function App() {
  return (
    <ConnectionProvider>
      <main className="dark bg-background text-foreground flex min-h-screen flex-col items-center justify-center gap-6 p-6">
        <h1 className="text-2xl font-semibold">nod</h1>
        <Proof />
      </main>
    </ConnectionProvider>
  );
}

const STATUS_TEXT = {
  unpaired: "Not paired. Open the link `nod serve` printed in your terminal.",
  connecting: "Connecting to nod serve…",
  open: "Connected",
  closed: "Disconnected. Is nod serve running? Retrying…",
  refused: "nod serve refused this pairing. Open the link it printed again.",
  outdated: "nod serve speaks another protocol version. Update one of them.",
} as const;

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function Proof() {
  const { status, welcome, snapshot, signer, setup, actions } = useConnection();
  const now = useNow(1000);
  const lanes = snapshot ? attentionView(snapshot.prs) : [];
  const tiers = snapshot ? countByTier(snapshot.prs) : null;
  const left =
    signer?.state === "unlocked" ? Math.max(0, Math.round((signer.until - now) / 1000)) : null;

  return (
    <section className="w-full max-w-md space-y-4 text-sm" data-testid="proof">
      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Connection</dt>
        <dd data-testid="status">{STATUS_TEXT[status]}</dd>
        <dt className="text-muted-foreground">Signed in as</dt>
        <dd data-testid="me">{welcome?.me?.login ?? "—"}</dd>
        <dt className="text-muted-foreground">Repository</dt>
        <dd data-testid="repo">
          {welcome?.repo ?? "—"}
          {welcome?.fake ? " (fake data)" : ""}
        </dd>
        <dt className="text-muted-foreground">Setup</dt>
        <dd data-testid="setup">{setup?.state ?? "—"}</dd>
        <dt className="text-muted-foreground">Signing</dt>
        <dd data-testid="signer">
          {!signer
            ? "—"
            : signer.state === "unlocked"
              ? `unlocked, locks in ${Math.floor(left! / 60)}:${String(left! % 60).padStart(2, "0")}`
              : signer.state === "locked"
                ? `locked (key ${signer.key.enrolment.state})`
                : "no key yet"}
        </dd>
        <dt className="text-muted-foreground">Pull requests</dt>
        <dd data-testid="prs">{snapshot ? snapshot.prs.length : "—"}</dd>
      </dl>

      {snapshot && tiers && (
        <>
          <ul className="space-y-1" data-testid="lanes">
            {lanes.map((lane) => (
              <li key={lane.lane} className="flex justify-between">
                <span>{lane.title}</span>
                <span className="text-muted-foreground tabular-nums">{lane.count}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground" data-testid="tiers">
            {tiers[1]} prominent · {tiers[2]} normal · {tiers[3]} one line · {tiers[4]} folded
          </p>
        </>
      )}

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={status !== "open"}
          onClick={() => void actions.refresh()}
        >
          Refresh
        </Button>
        {signer?.state === "unlocked" && (
          <Button variant="outline" size="sm" onClick={() => void actions.lock()}>
            Lock
          </Button>
        )}
      </div>
    </section>
  );
}
