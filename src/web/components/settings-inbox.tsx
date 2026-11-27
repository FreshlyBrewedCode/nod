/**
 * Settings → Inbox (ADR 0009): my own inbox, as `nod serve` runs it. What
 * runs (my `inbox.ts`, or the built-in defaults), where, whether it loads,
 * every classifier and analyzer it loaded with its origin and `when`, the
 * error, how to start (`nod inbox init`, `nod inbox test`), and the
 * isolation in one line. Read-only: the inbox is a file I edit; a save
 * reloads it, and this page follows the `inbox` push.
 */

import type { InboxAnalyzer, InboxClassifier, InboxStatus } from "../../shared/protocol";
import { inboxFile, inboxStateLine } from "@/lib/personal";
import { cn } from "@/lib/utils";
import { CommandBox } from "./onboarding";
import { CARD, Code, Fact, Facts, H2, Heading, LINE, LongCode, NOTE } from "./settings-bits";

export const INBOX_DOCS = "https://nod.frebreco.de/docs/inbox";

export function InboxSection({ inbox }: { inbox: InboxStatus | null }) {
  return (
    <>
      <Heading title="Inbox">
        Your own attention classifiers and analyzers. Only your <Code>nod serve</Code> runs them:
        they decide how much of your attention a pull request gets and show insights in its panel,
        never its risk or what it needs, and nothing they say reaches GitHub.
      </Heading>
      {inbox ? <Status inbox={inbox} /> : <None />}
      {inbox && (
        <>
          <Parts inbox={inbox} />
          <Start inbox={inbox} />
        </>
      )}
      <p className={cn(NOTE, "mt-1")}>
        It runs on your machine as you, in a process of its own without your token or key: not a
        sandbox against your own code.{" "}
        <a
          href={INBOX_DOCS}
          target="_blank"
          rel="noreferrer"
          className="hover:text-tx2 underline underline-offset-2"
        >
          Your own inbox in the docs
        </a>
      </p>
    </>
  );
}

function None() {
  return (
    <section aria-labelledby="inbox-title" className={CARD}>
      <h2 id="inbox-title" className={H2}>
        No inbox runs here
      </h2>
      <p className={LINE}>
        This <Code>nod serve</Code> runs no inbox of yours: it is older than the inbox, or it was
        started without one.
      </p>
    </section>
  );
}

function Status({ inbox }: { inbox: InboxStatus }) {
  const yours = inbox.config === "yours";
  return (
    <section aria-labelledby="inbox-title" className={CARD}>
      <h2 id="inbox-title" className={cn(H2, "flex items-center gap-2")}>
        <i
          aria-hidden
          className={cn(
            "size-2 flex-none rounded-full",
            inbox.state === "error"
              ? "bg-bad"
              : inbox.state === "starting"
                ? "bg-tx3 motion-safe:animate-pulse"
                : "bg-ok",
          )}
        />
        {yours ? "Yours" : "The built-in defaults"}
      </h2>
      <p className={LINE}>{inboxStateLine(inbox)}</p>
      {inbox.error && (
        <p
          role="alert"
          className="bg-bad-bg m-0 mt-3 rounded-lg px-3 py-2.5 font-mono text-[12px] leading-[1.55] [overflow-wrap:anywhere] phone:text-[13px]"
        >
          {inbox.error}
        </p>
      )}
      <Facts className="mt-3">
        <Fact label="Runs">
          {yours ? (
            <LongCode>{inboxFile(inbox)}</LongCode>
          ) : (
            <>
              nod’s defaults: there is no <LongCode>{inboxFile(inbox)}</LongCode>
            </>
          )}
        </Fact>
        <Fact label="Folder">
          <LongCode>{inbox.path}</LongCode>
        </Fact>
        <Fact label="Reloads">when a file in the folder is saved</Fact>
      </Facts>
    </section>
  );
}

function Parts({ inbox }: { inbox: InboxStatus }) {
  return (
    <section aria-labelledby="inbox-parts" className={CARD}>
      <h2 id="inbox-parts" className={H2}>
        What it loaded
      </h2>
      <p className={cn(NOTE, "mb-3")}>
        <b className="text-tx2 font-medium">default</b> is one of nod’s built-in parts (
        <Code>...defaults()</Code> keeps them in your file);{" "}
        <b className="text-tx2 font-medium">yours</b> is written by you.
      </p>
      <h3 className="text-tx3 m-0 mt-1 mb-1 text-[11px] font-semibold tracking-[0.08em] uppercase">
        Attention classifiers
      </h3>
      <PartList
        empty="No classifier: nothing moves a pull request up or down for you."
        rows={inbox.classifiers.map((c) => classifierRow(c))}
      />
      <h3 className="text-tx3 m-0 mt-4 mb-1 text-[11px] font-semibold tracking-[0.08em] uppercase">
        Analyzers
      </h3>
      <PartList
        empty="No analyzer: the panel shows no insights."
        rows={inbox.analyzers.map((a) => analyzerRow(a))}
      />
    </section>
  );
}

interface Row {
  key: string;
  name: string;
  /** Mono: an id, a `when`. */
  detail: string | null;
  origin: "default" | "yours";
  repos: string | undefined;
}

const classifierRow = (c: InboxClassifier): Row => ({
  key: c.name,
  name: c.name,
  detail: null,
  origin: c.origin,
  repos: c.repos,
});

const analyzerRow = (a: InboxAnalyzer): Row => ({
  key: `${a.repos ?? ""}:${a.id}`,
  name: a.title,
  detail: `${a.id} · ${a.when === "open" ? "when opened" : "after each poll"}`,
  origin: a.origin,
  repos: a.repos,
});

function PartList({ rows, empty }: { rows: ReadonlyArray<Row>; empty: string }) {
  if (rows.length === 0) return <p className={NOTE}>{empty}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {rows.map((r) => (
        <li
          key={r.key}
          className="border-line grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-3 border-t py-1.5 first:border-t-0 phone:py-2"
        >
          <span className="min-w-0">
            <span className="text-tx2 text-[13.5px] [overflow-wrap:anywhere]">{r.name}</span>
            {r.detail && (
              <span className="text-tx3 ml-2 font-mono text-[11.5px] phone:ml-0 phone:block phone:text-[12px]">
                {r.detail}
              </span>
            )}
            {r.repos && (
              <span className="text-tx3 fs-note ml-2 phone:ml-0 phone:block">
                only in <span className="font-mono">{r.repos}</span>
              </span>
            )}
          </span>
          <span
            className={cn(
              "inline-flex h-[17px] items-center rounded-[4px] border px-[5px] font-mono text-[10.5px]",
              r.origin === "yours" ? "border-line2 text-tx2" : "border-line text-tx3",
            )}
          >
            {r.origin}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Start({ inbox }: { inbox: InboxStatus }) {
  const yours = inbox.config === "yours";
  return (
    <section aria-labelledby="inbox-start" className={CARD}>
      <h2 id="inbox-start" className={H2}>
        {yours ? "Change it, try it" : "Write your own"}
      </h2>
      <p className={cn(LINE, "mb-3")}>
        {yours ? (
          <>
            Edit <Code>inbox.ts</Code> or a file it imports; a save reloads it. Try it on one pull
            request first: it prints what the panel would show.
          </>
        ) : (
          <>
            This writes <Code>inbox.ts</Code> (the defaults, and an example to start from), an
            analyzer, and a <Code>package.json</Code> so your editor knows the kit. Then try it on
            one pull request.
          </>
        )}
      </p>
      <div className="space-y-2">
        {!yours && <CommandBox command="nod inbox init" />}
        <CommandBox command="nod inbox test <pr>" />
      </div>
      <p className={cn(NOTE, "mt-2.5")}>
        <Code>{"<pr>"}</Code> is a number with one repository, else <Code>owner/name#123</Code> or
        the pull request’s link. No LLM analyzer ships in this version.
      </p>
    </section>
  );
}
