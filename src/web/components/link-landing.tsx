/**
 * Where a deep link lands (concept decision 7; r1/r2 `4-deeplink`, r3
 * `#link`, unchanged since round 1): a focused view of the PRs the link
 * names, what is needed from me, and one button that goes through the
 * normal batch dialog. A link never approves by itself.
 *
 * - `#/pr/…` shows one PR; `#/batch/…` also opens the batch dialog's review
 *   step for the ones that still need me (the others are listed greyed,
 *   with the reason).
 * - A link for another repo, or a PR the snapshot does not have: a calm
 *   explanation with the GitHub link.
 * - Not paired yet (`UnpairedLanding`): what nod is, what to do; the link is
 *   remembered across the pairing; never a sign button. A hosted page that
 *   remembers this browser's named host offers "Open on <host>" instead
 *   (`ForwardOffer`, ADR 0005 §7); the named host's own page says to scan
 *   the device link.
 */

import { Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { GitHubInfo, PrView, SignerState, Snapshot } from "../../shared/protocol";
import { MINUTE, useNow } from "@/hooks/use-clock";
import { rememberLink } from "@/lib/connection";
import {
  afterwards,
  asWhat,
  githubPrUrl,
  githubPullsUrl,
  landingOf,
  repoLabel,
  webUrlOf,
  type LinkTarget,
} from "@/lib/deep-link";
import { formatRoute, linkNumbers, type LinkRoute } from "@/lib/route";
import { browserStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";
import { actWord, askHeadline, rowTag, statusText, type People } from "@/lib/wording";
import { readiness } from "@/lib/batch";
import { RiskBars, Tag } from "./bits";
import { BriefText } from "./brief-text";
import { cannotSignText } from "./unlock";
import { useBatch } from "./batch-dialog";
import { DiffIndicator } from "./diff-indicator";
import { ForwardOffer, PasteLink } from "./forward";
import type { Unpaired } from "./full-page";
import { Footer, GHOST, PRIMARY } from "./onboarding";
import { Logo, TopBarShell } from "./top-bar";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Banner({ route, children }: { route: LinkRoute; children?: ReactNode }) {
  const numbers = linkNumbers(route);
  const repo = repoLabel(route.host, route.repo);
  return (
    <div className="border-[#74a9ff44] bg-know-bg col-span-full rounded-xl border px-5 py-4 phone:order-1 phone:px-4">
      <b className="text-know font-semibold">Opened from a link</b> ·{" "}
      {numbers.length === 1
        ? `#${numbers[0]} in ${repo}`
        : `${plural(numbers.length, "pull request")} in ${repo}: ${numbers.map((n) => `#${n}`).join(", ")}`}
      {children}
      <span className="text-tx3 block text-[12.5px] leading-[1.55]">
        Nothing is signed yet. A link only opens this view.
      </span>
    </div>
  );
}

const LINK = "underline underline-offset-2 hover:text-tx2";
/** A link that is a row's action: a touch-sized target on a phone. */
const LINK_ACTION = cn(LINK, "phone:inline-flex phone:min-h-11 phone:items-center");

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "border-line bg-panel mb-2.5 grid grid-cols-[20px_1fr] gap-3.5 rounded-xl border px-5 py-[18px] phone:px-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Tick({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className="relative mt-[3px] grid size-4 place-items-center phone:after:absolute phone:after:-inset-3.5 phone:after:content-['']">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
        className="peer border-line2 hover:border-tx3 checked:bg-need checked:border-need absolute inset-0 m-0 cursor-pointer appearance-none rounded-[5px] border-[1.5px] disabled:cursor-default disabled:opacity-60"
      />
      <span className="pointer-events-none relative hidden h-1 w-2 translate-y-[-1px] -rotate-45 border-b-2 border-l-2 border-[#111] peer-checked:block" />
    </label>
  );
}

function PrCard({
  target,
  people,
  selected,
  onToggle,
  onOpen,
  mixed,
}: {
  target: LinkTarget;
  people: People;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  /** Some PRs of the link need me: say why this one is not selected. */
  mixed: boolean;
}) {
  const { pr, needsMe, why } = target;
  const tag = rowTag(pr);
  return (
    <Card>
      <Tick
        checked={selected}
        disabled={!needsMe}
        label={
          selected
            ? `Leave #${pr.number} out`
            : `${pr.ask?.kind === "approve" ? "Approve" : "Sign"} #${pr.number} too`
        }
        onChange={onToggle}
      />
      <div className="min-w-0">
        <h3 className={cn("m-0 mb-1 text-[15px] font-bold", !needsMe && "text-tx2")}>{pr.title}</h3>
        <div className="text-tx3 mt-[3px] flex items-center gap-[7px] text-[12.5px] phone:flex-wrap phone:gap-y-1.5">
          <span className="font-mono text-[12px]">#{pr.number}</span>
          {tag && <Tag tag={tag} />}
          <RiskBars risk={pr.risk} label />
          <DiffIndicator inline added={pr.diff.added} removed={pr.diff.removed} />
          <span className="flex-1" />
          {needsMe ? (
            <span className="text-need text-[12.5px] font-semibold whitespace-nowrap">
              {askHeadline(pr)}
            </span>
          ) : (
            <span className="whitespace-nowrap">{statusText(pr, people)}</span>
          )}
        </div>
        {pr.brief?.what && (
          <p className={cn("text-tx2 m-0 mt-1.5", !needsMe && "text-tx3")}>
            <BriefText text={pr.brief.what} />
          </p>
        )}
        {why && (
          <div className="bg-panel2 text-tx2 mt-3 rounded-lg px-3 py-2.5 text-[13px] leading-[1.55]">
            <b className="text-tx font-semibold">Not needed from you.</b>{" "}
            {why.charAt(0).toUpperCase() + why.slice(1)}
            {mixed ? ", so it is not selected." : "."}
          </div>
        )}
        <div className="text-tx3 mt-2.5 flex items-center gap-[7px] text-[12.5px] phone:gap-4">
          <button type="button" className={LINK_ACTION} onClick={onOpen}>
            Open
          </button>
          <span className="phone:hidden">·</span>
          <a className={LINK_ACTION} href={`${pr.url}/files`} target="_blank" rel="noreferrer">
            Diff on GitHub ↗
          </a>
        </div>
      </div>
    </Card>
  );
}

function NoteCard({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <span
        aria-hidden
        className="border-line2 mt-[3px] size-4 rounded-[5px] border-[1.5px] border-dashed"
      />
      <div className="min-w-0">
        <h3 className="text-tx2 m-0 mb-1 text-[15px] font-bold">{title}</h3>
        <p className="text-tx3 m-0 mt-1.5 text-[13px] leading-[1.55]">{children}</p>
      </div>
    </Card>
  );
}

export function LinkLanding({
  route,
  snapshot,
  github,
  signer,
  onOpen,
  onList,
}: {
  route: LinkRoute;
  snapshot: Snapshot;
  /** The GitHub host `nod serve` reads. */
  github: GitHubInfo;
  signer: SignerState | null;
  /** Show a PR in the full list, with its details open. */
  onOpen: (pr: number) => void;
  onList: () => void;
}) {
  const { openBatch } = useBatch();
  const now = useNow(MINUTE);
  const landing = useMemo(
    () => landingOf(route, snapshot, now, github),
    [route, snapshot, now, github],
  );
  const targets = landing.kind === "found" ? landing.targets : [];
  const needing = targets.filter((t) => t.needsMe).map((t) => t.pr.number);
  const [left, setLeft] = useState<ReadonlySet<number>>(new Set());
  const selected = targets.filter((t) => t.needsMe && !left.has(t.pr.number)).map((t) => t.pr);
  const people = snapshot.people;

  // A batch link opens the review step once, for what still needs me; the
  // others come along and are shown greyed with the reason.
  const opened = useRef<string | null>(null);
  const key = formatRoute(route);
  useEffect(() => {
    if (route.view !== "batch" || opened.current === key || !needing.length) return;
    opened.current = key;
    openBatch([...needing, ...targets.filter((t) => !t.needsMe).map((t) => t.pr.number)]);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per link
  }, [key, needing.length]);

  const otherNeeds = snapshot.prs.filter(
    (p) => p.needsMe && !linkNumbers(route).includes(p.number),
  ).length;
  const toList = (
    <p className="text-tx3 mx-1 my-4 text-[12.5px] leading-[1.55]">
      <button type="button" className={cn(LINK, "phone:block phone:min-h-11")} onClick={onList}>
        Go to the full list
      </button>
      {otherNeeds > 0 && (
        <>
          <span className="phone:hidden"> · </span>
          {otherNeeds === 1
            ? "1 more pull request waits"
            : `${otherNeeds} more pull requests wait`}{" "}
          for you there.
        </>
      )}
    </p>
  );

  if (landing.kind === "other-repo") {
    const numbers = linkNumbers(route);
    return (
      <Column>
        <Banner route={route} />
        <main className="col-span-full max-w-[660px] phone:order-2">
          <NoteCard title={`This link is for ${landing.repo}`}>
            nod serve here reads {landing.here} only, the repository of the folder it runs in. To
            look at {numbers.map((n) => `#${n}`).join(", ")} in nod, run{" "}
            <code className="font-mono text-[12px]">nod serve</code> in a clone of {landing.repo}.
            Or open {numbers.length === 1 ? "it" : "them"} on GitHub:{" "}
            {numbers.map((n, i) => (
              <span key={n}>
                {i > 0 && ", "}
                <a
                  className={LINK}
                  href={githubPrUrl(landing.webUrl, route.repo, n)}
                  target="_blank"
                  rel="noreferrer"
                >
                  #{n} ↗
                </a>
              </span>
            ))}
            .
          </NoteCard>
          {toList}
        </main>
      </Column>
    );
  }

  const ready = signer?.state === "unlocked";
  const keyState = readiness(signer).state;
  const keyBlocked =
    (keyState === "pending" || keyState === "not-enrolled" || keyState === "no-key") &&
    targets.some((t) => t.pr.waitingOn.some((w) => w.kind === "me"));
  const leftOut = targets.filter((t) => !selected.includes(t.pr)).map((t) => `#${t.pr.number}`);
  // Without an active key the link's asks are GitHub approvals (ADR 0006).
  const approving = actWord(targets.filter((t) => t.needsMe).map((t) => t.pr)) === "approve";
  return (
    <Column>
      <Banner route={route} />
      <main className="min-w-0 phone:order-3">
        {targets.map((t) => (
          <PrCard
            key={t.pr.number}
            target={t}
            people={people}
            selected={t.needsMe && !left.has(t.pr.number)}
            onToggle={() =>
              setLeft((l) => {
                const next = new Set(l);
                if (!next.delete(t.pr.number)) next.add(t.pr.number);
                return next;
              })
            }
            onOpen={() => onOpen(t.pr.number)}
            mixed={needing.length > 0}
          />
        ))}
        {landing.unclassified.map((u) => (
          <NoteCard key={u.number} title={u.title}>
            #{u.number} is not classified yet: the verifier has not run on it
            {u.reason === "verifier-error" ? " successfully" : ""}, so nothing can be signed.{" "}
            <a className={LINK} href={u.url} target="_blank" rel="noreferrer">
              Open it on GitHub ↗
            </a>
          </NoteCard>
        ))}
        {landing.missing.map((n) => (
          <NoteCard key={n} title={`#${n} is not here`}>
            It is not among the open pull requests of {snapshot.repo}, nor those merged or closed in
            the last 14 days: it may have merged long ago, or the number is wrong.{" "}
            <a
              className={LINK}
              href={githubPrUrl(github.webUrl, snapshot.repo, n)}
              target="_blank"
              rel="noreferrer"
            >
              Open #{n} on GitHub ↗
            </a>
          </NoteCard>
        ))}
        {toList}
      </main>
      <aside
        className="border-need-line bg-panel sticky top-[76px] self-start rounded-[14px] border p-5 phone:static phone:order-2 phone:p-4"
        aria-label="Requested"
      >
        <h6 className="text-tx3 m-0 mb-1.5 text-[11px] font-semibold tracking-[0.08em] uppercase">
          Requested
        </h6>
        {needing.length === 0 ? (
          <>
            <b className="mb-1 block text-[17px]">Nothing to sign</b>
            <p className="text-tx3 m-0 text-[12.5px] leading-[1.55]">
              {!targets.length
                ? "This link names nothing nod can show here."
                : keyBlocked
                  ? cannotSignText(readiness(signer))
                  : "Nothing this link names needs you now."}
            </p>
            <button type="button" className={cn(GHOST, "mt-3 w-full")} onClick={onList}>
              Go to the full list
            </button>
          </>
        ) : (
          <>
            <b className="mb-1 block text-[17px]">
              {targets.length + landing.missing.length + landing.unclassified.length === 1
                ? askHeadline(selected[0] ?? targets[0]!.pr)
                : `${approving ? "Approve" : "Sign"} ${selected.length} of ${targets.length + landing.missing.length + landing.unclassified.length}`}
            </b>
            <p className="text-tx3 m-0 mb-4 text-[12.5px] leading-[1.55]">
              {selected.length
                ? `${asWhat(selected)}. ${afterwards(selected, people)}`
                : "Nothing is selected."}
              {leftOut.length > 0 &&
                ` ${leftOut.join(", ")} ${leftOut.length === 1 ? "is" : "are"} left out.`}
            </p>
            <button
              type="button"
              className={cn(PRIMARY, "w-full")}
              disabled={selected.length === 0}
              onClick={() => openBatch(selected.map((p: PrView) => p.number))}
            >
              {!ready && !approving && <Lock className="size-4" />}
              Review &amp; {approving ? "approve" : "sign"} {selected.length}
            </button>
            <p className="text-tx3 m-0 mt-3.5 text-[12.5px] leading-[1.55]">
              {approving
                ? "You see what you approve before anything is posted. No key needed: it is your approval on GitHub."
                : "You see what you sign and enter your passphrase before anything is posted."}
            </p>
          </>
        )}
      </aside>
    </Column>
  );
}

function Column({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid w-full max-w-[1000px] grid-cols-[minmax(0,1fr)_300px] gap-x-10 gap-y-10 px-6 pt-7 pb-[100px] phone:flex phone:flex-col phone:gap-4 phone:px-4 phone:pt-4 phone:pb-[calc(2rem+env(safe-area-inset-bottom))]">
      {children}
    </div>
  );
}

/**
 * A deep link in a browser that is not paired with `nod serve` yet: what nod
 * is, what to do, the GitHub link. The link is remembered, so the host link
 * `nod serve` prints lands here again; nothing can sign before that.
 */
export function UnpairedLanding({ route, unpaired }: { route: LinkRoute; unpaired: Unpaired }) {
  const key = formatRoute(route);
  useEffect(() => {
    const storage = browserStorage();
    if (storage) rememberLink(storage, key, Date.now());
  }, [key]);
  const numbers = linkNumbers(route);
  const first = numbers[0]!;
  const github = (
    <a
      className={cn(GHOST, "phone:border-line2")}
      href={
        numbers.length === 1
          ? githubPrUrl(webUrlOf(route.host), route.repo, first)
          : githubPullsUrl(webUrlOf(route.host), route.repo)
      }
      target="_blank"
      rel="noreferrer"
    >
      {numbers.length === 1 ? `#${first} on GitHub ↗` : "On GitHub ↗"}
    </a>
  );
  const { offer, host } = unpaired;
  return (
    <div className="pt-safe pb-safe px-safe flex min-h-full flex-col">
      <TopBarShell>
        <Logo />
      </TopBarShell>
      <div className="mx-auto grid w-full max-w-[760px] gap-6 px-6 pt-7 pb-[100px] phone:gap-4 phone:px-4 phone:pt-4 phone:pb-8">
        <Banner route={route} />
        <main
          className="border-line bg-panel rounded-2xl border px-9 py-8 phone:order-2 phone:px-5 phone:py-6"
          aria-live="polite"
        >
          {offer.kind === "forward" ? (
            <ForwardOffer
              offer={offer}
              what={numbers.length === 1 ? `#${first}` : "these pull requests"}
              onForget={unpaired.onForget}
            >
              {github}
            </ForwardOffer>
          ) : (
            <>
              <h1 className="m-0 mb-1.5 text-[22px] font-bold tracking-[-0.01em]">
                {host ? "Pair this device with nod serve" : "Open it in nod on your machine"}
              </h1>
              <p className="text-tx2 m-0 mb-[22px]">
                nod is a local dashboard for agent-written pull requests: it runs on your machine,
                with your GitHub login, and signs nods with a key only you can unlock.
              </p>
              <ol className="m-0 list-none p-0">
                <li className="border-line grid grid-cols-[24px_1fr] gap-3 border-t py-3">
                  <span className="border-line2 text-tx3 mt-px grid size-5 place-items-center rounded-full border-[1.5px] text-[11px] font-bold">
                    1
                  </span>
                  <div className="min-w-0">
                    {host ? "On your machine" : "In a terminal"}, in your clone of{" "}
                    {repoLabel(route.host, route.repo)}:
                    <div className="bg-bg border-line text-tx my-2 flex items-center gap-2.5 overflow-x-auto rounded-lg border px-3.5 py-2.5 font-mono text-[12.5px] phone:text-[13px] phone:select-all">
                      {host ? `nod serve --allow-host ${host}` : "nod serve"}
                    </div>
                  </div>
                </li>
                <li className="border-line grid grid-cols-[24px_1fr] gap-3 border-t py-3">
                  <span className="border-line2 text-tx3 mt-px grid size-5 place-items-center rounded-full border-[1.5px] text-[11px] font-bold">
                    2
                  </span>
                  <div>
                    {host
                      ? "Scan the QR code it prints with this device’s camera."
                      : "Open the link it prints."}
                    <small className="text-tx3 mt-0.5 block text-[12.5px] leading-[1.5]">
                      It pairs this browser once, and then you land on{" "}
                      {numbers.length === 1 ? `#${first}` : "these pull requests"} again.
                    </small>
                  </div>
                </li>
              </ol>
              {unpaired.standalone && <PasteLink />}
              <Footer
                noteClass="max-w-[340px]"
                note="Until then this page cannot sign anything: it has no connection to your machine."
              >
                {github}
              </Footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
