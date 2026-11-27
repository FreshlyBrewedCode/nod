/**
 * The setup page (`#/setup`, `#/setup/<step>`): the opt-in ladder (ADR
 * 0006), each step mostly a list of checks (r3 `12`–`16`). Nothing here
 * gates: the dashboard shows as soon as `gh` is logged in and a repo is
 * picked; the steps are offered (`offer.tsx`, the avatar menu) and done here.
 * Only the two pages before a dashboard are left: not signed in to GitHub,
 * and no repo picked yet.
 *
 * Every step takes one repo's setup and my signer as props, so a settings
 * page for many repos (epic C) can show them per repo. Where each step stands
 * comes from the server's state alone (`lib/onboarding.ts`). Every action is
 * one protocol request; the state it changes arrives as a push.
 *
 * Passphrases live only in their inputs and the one request that sends
 * them: read on submit, the inputs cleared at once and when the step goes
 * away, never in React state, never logged.
 */

import { Lock } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";

import {
  MIN_PASSPHRASE_LENGTH,
  type Account,
  type GitHubInfo,
  type Person,
  type PrLink,
  type RepoChoice,
  type SetupCheck,
  type SetupStatus,
  type SignerState,
  type TestSignatureResult,
} from "../../shared/protocol";
import type { Actions } from "@/hooks/use-connection";
import { MINUTE, useNow } from "@/hooks/use-clock";
import type { Failure } from "@/lib/batch";
import {
  CHECK_PURPOSE,
  RUNGS,
  RUNG_NAMES,
  RUNG_WHO,
  offersOf,
  onboardingError,
  passphraseProblem,
  progressOf,
  rungsOf,
  shortFingerprint,
  shortPath,
  signerLine,
  teammates,
  type Progress,
  type Rung,
  type RungState,
} from "@/lib/onboarding";
import { formatRoute } from "@/lib/route";
import { GITHUB_COM, ghLoginCommand } from "../../kit/host.ts";
import { duration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { FullPage } from "./full-page";
import { Logo, TopBarShell } from "./top-bar";
import { PassphraseField, failureOf, takePassphrase } from "./unlock";

// ---------------------------------------------------------------------------
// r3's pieces: buttons, the check row, the card

const BTN =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-semibold disabled:opacity-50 disabled:cursor-default phone:h-auto phone:min-h-11 phone:py-2 phone:text-center phone:whitespace-normal";
export const PRIMARY = cn(BTN, "bg-need border-need text-on-need h-[42px] px-5 text-[14px]");
export const GHOST = cn(
  BTN,
  "text-tx2 hover:text-tx h-[42px] border-transparent px-4 text-[14px] font-medium",
);

/** Text with `backticks` as code, for messages that name a command. */
export function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="font-mono fs-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono fs-code">{children}</span>
);

type Mark = "ok" | "no" | "wait" | "bad";

function CheckIcon({ mark }: { mark: Mark }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-px grid size-5 place-items-center rounded-full text-[11px] font-bold",
        mark === "ok" && "bg-ok text-[#06140d]",
        mark === "no" && "border-line2 text-tx3 border-[1.5px] border-dashed",
        mark === "wait" && "border-need text-need border-[1.5px]",
        mark === "bad" && "bg-bad text-[#1a0806]",
      )}
    >
      {mark === "ok" ? "✓" : mark === "wait" ? "…" : mark === "bad" ? "!" : ""}
    </span>
  );
}

const MARK_LABEL: Record<Mark, string> = {
  ok: "done",
  no: "not yet",
  wait: "pending",
  bad: "failed",
};

/** One line of a checklist (r3 `.chk`): mark, what, a small line under it, a note on the right. */
function Check({
  mark,
  title,
  children,
  note,
}: {
  mark: Mark;
  title: ReactNode;
  children?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <li className="border-line grid grid-cols-[24px_1fr_auto] items-start gap-3 border-t py-3 phone:grid-cols-[24px_1fr]">
      <CheckIcon mark={mark} />
      <div className="min-w-0 phone:[overflow-wrap:anywhere]">
        <span className="sr-only">{MARK_LABEL[mark]}: </span>
        {title}
        {children && (
          <small className="text-tx3 mt-0.5 block fs-note leading-[1.5]">{children}</small>
        )}
      </div>
      {note ? (
        <span className="text-tx3 fs-note leading-[1.55] phone:col-start-2 phone:-mt-1.5">
          {note}
        </span>
      ) : (
        <span className="phone:hidden" />
      )}
    </li>
  );
}

function Checks({ children }: { children: ReactNode }) {
  return <ul className="m-0 list-none p-0">{children}</ul>;
}

/**
 * The note on the left, the buttons on the right. On a phone they stack, the
 * buttons first and the main one on top (the DOM order has it last), full width.
 */
export function Footer({
  note,
  noteClass = "max-w-[300px]",
  children,
}: {
  note?: ReactNode;
  noteClass?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-[26px] flex items-center gap-2.5 phone:mt-5 phone:flex-col-reverse phone:items-stretch phone:gap-4">
      <span className={cn("text-tx3 fs-note leading-[1.55]", noteClass, "phone:max-w-none")}>
        {note}
      </span>
      <span className="flex-1 phone:hidden" />
      <div className="contents phone:flex phone:flex-col-reverse phone:gap-1.5">{children}</div>
    </div>
  );
}

/** r3's dashed note box (`.noteb`). */
function NoteBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "border-line2 text-tx2 rounded-[10px] border border-dashed px-3.5 py-2.5 text-[13px] leading-[1.55] [&_b]:text-tx",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ErrorNote({ failure, lead }: { failure: Failure | null; lead: string }) {
  if (!failure) return null;
  return (
    <p
      role="alert"
      className="bg-bad-bg m-0 mt-4 rounded-lg px-3 py-2.5 text-[13px] leading-[1.55]"
    >
      <b className="text-bad">{lead}</b> <Words text={onboardingError(failure)} />
    </p>
  );
}

function PrAnchor({ pr, children }: { pr: PrLink; children?: ReactNode }) {
  return (
    <a href={pr.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children ?? `#${pr.number}`}
    </a>
  );
}

/** A request with its busy state and failure, for the steps' buttons. */
function useRequest() {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const run = async (what: string, request: () => Promise<unknown>): Promise<boolean> => {
    setBusy(what);
    setFailure(null);
    try {
      await request();
      return true;
    } catch (error) {
      setFailure(failureOf(error));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, failure, run, clear: () => setFailure(null) };
}

// ---------------------------------------------------------------------------
// the pages before a dashboard

/** `gh` is not logged in: a calm page with the command, nothing else to do here. */
export function SignInPage({ github }: { github: GitHubInfo }) {
  const onGitHubCom = github.host === GITHUB_COM;
  return (
    <FullPage
      title={onGitHubCom ? "Sign in to GitHub" : `Sign in to ${github.host}`}
      command={ghLoginCommand(github.host)}
      after={
        <p className="text-tx3 m-0 mt-4 fs-note leading-[1.55]">
          Then restart <Mono>nod serve</Mono>. nod asks for no permission of its own and stores
          nothing on a server.
        </p>
      }
    >
      <p>
        nod runs on this machine and reads GitHub with the login of the <Mono>gh</Mono> command line
        tool{onGitHubCom ? "" : ` for ${github.host}, the host of this clone’s origin`}. It is not
        logged in yet. Run this in a terminal:
      </p>
    </FullPage>
  );
}

/** No repo picked yet (only `nod serve --fake --scenario fresh`: the GitHub source reads its clone's). */
export function PickRepoPage(props: { me: Account; setup: SetupStatus; actions: Actions }) {
  return (
    <FullPage title="Pick a repository">
      <p>nod shows the pull requests of one repository. Nothing in it changes by looking.</p>
      <RepoPicker {...props} />
    </FullPage>
  );
}

// ---------------------------------------------------------------------------
// the setup page

export interface SetupPageProps {
  readonly me: Account | null;
  /** The GitHub host `nod serve` reads. */
  readonly github: GitHubInfo;
  /** The repo's setup and ladder step. */
  readonly setup: SetupStatus;
  /** My key and its enrolment in the repo. */
  readonly signer: SignerState;
  readonly people: ReadonlyArray<Person>;
  readonly actions: Actions;
  /** The step shown (`setupRungOf`). */
  readonly step: Rung;
  readonly onStep: (step: Rung) => void;
  /** Back to the dashboard; null while there is none to go to (no snapshot yet). */
  readonly onLeave: (() => void) | null;
}

type StepProps = SetupPageProps & { readonly progress: Progress };

export function SetupPage(props: SetupPageProps) {
  const { me, setup, signer, step, onStep, onLeave } = props;
  const progress = progressOf({ me, setup, signer });
  const rungs = rungsOf({ me, setup, signer });
  const next = offersOf({ me, setup, signer })[0]?.rung ?? null;
  const stepProps: StepProps = { ...props, progress };

  return (
    <div className="pt-safe pb-safe px-safe flex min-h-full flex-col">
      <TopBarShell>
        <Logo />
        {setup.repo && <span className="text-tx3 min-w-0 truncate text-[13px]">{setup.repo}</span>}
        <span className="flex-1" />
        {onLeave && (
          <button
            type="button"
            onClick={onLeave}
            className="text-tx3 hover:text-tx2 fs-note flex-none phone:min-h-11"
          >
            <span className="phone:hidden">Back to the dashboard</span>
            <span className="hidden phone:inline">Dashboard</span>
          </button>
        )}
      </TopBarShell>
      <div className="mx-auto my-12 grid w-full max-w-[940px] grid-cols-[230px_1fr] gap-11 px-6 phone:my-4 phone:grid-cols-1 phone:gap-4 phone:px-4">
        <Ladder
          rungs={rungs}
          step={step}
          next={next}
          setup={setup}
          signer={signer}
          onStep={onStep}
        />
        <main
          className="border-line bg-panel rounded-2xl border px-9 py-8 phone:px-5 phone:py-6"
          aria-live="polite"
        >
          {step === "inbox" ? (
            <InboxStep {...stepProps} />
          ) : step === "shared-policy" ? (
            <SetupStep {...stepProps} />
          ) : step === "signing" ? (
            <SigningStep key={setup.repo ?? ""} {...stepProps} />
          ) : (
            <EnforcedStep {...stepProps} state={rungs.enforced} />
          )}
        </main>
      </div>
    </div>
  );
}

/** The short line under a step's name: who opts in, and where it stands. */
function rungLine(
  rung: Rung,
  state: RungState,
  next: boolean,
  setup: SetupStatus,
  signer: SignerState,
): string {
  const who = RUNG_WHO[rung];
  if (state === "done") return `${who} · done`;
  if (state === "waiting") {
    const pr =
      rung === "shared-policy"
        ? setup.setupPr
        : signer.state !== "no-key" && signer.key.enrolment.state === "pending"
          ? signer.key.enrolment.pr
          : null;
    return `${who} · ${pr ? `#${pr.number} open` : "pending"}`;
  }
  if (state === "later") return `${who} · after the shared policy`;
  if (state === "not-yours")
    return `${who} · ${rung === "enforced" ? "needs a repo admin" : "needs write access"}`;
  return `${who} · ${next ? "next" : "optional"}`;
}

/**
 * The ladder (r3's stepper): the four steps with who opts in and where each
 * stands, the next one marked; any step can be opened. On a phone the circles
 * only, and the open step's name beside them.
 */
function Ladder({
  rungs,
  step,
  next,
  setup,
  signer,
  onStep,
}: {
  rungs: Readonly<Record<Rung, RungState>>;
  step: Rung;
  next: Rung | null;
  setup: SetupStatus;
  signer: SignerState;
  onStep: (step: Rung) => void;
}) {
  return (
    <nav aria-label="The ladder" className="contents phone:flex phone:items-center phone:gap-3">
      <div className="phone:contents">
        <h2 className="text-tx3 m-0 mt-1.5 mb-1 text-[11px] font-semibold tracking-[0.08em] uppercase phone:hidden">
          The ladder
        </h2>
        <ol className="m-0 list-none p-0 phone:flex phone:items-center">
          {RUNGS.map((rung, i) => {
            const on = rung === step;
            const state = rungs[rung];
            const done = state === "done";
            const line = rungLine(rung, state, rung === next, setup, signer);
            return (
              <li key={rung} aria-current={on ? "step" : undefined}>
                <button
                  type="button"
                  onClick={() => onStep(rung)}
                  className={cn(
                    "hover:text-tx flex w-full items-start gap-3 py-[9px] text-left phone:min-h-11 phone:min-w-11 phone:items-center phone:justify-center",
                    on ? "text-tx" : done ? "text-tx2" : "text-tx3",
                  )}
                >
                  <i
                    aria-hidden
                    className={cn(
                      "mt-px grid size-[22px] flex-none place-items-center rounded-full border-[1.5px] text-[11px] font-bold not-italic phone:mt-0 phone:size-7 phone:text-xs",
                      on
                        ? "border-need text-need"
                        : done
                          ? "bg-ok border-ok text-[#06140d]"
                          : state === "waiting"
                            ? "border-need-line text-need"
                            : "border-line2",
                    )}
                  >
                    {done && !on ? "✓" : i}
                  </i>
                  <span className="phone:sr-only">
                    <span className={cn("block", on && "font-semibold")}>{RUNG_NAMES[rung]}</span>
                    <span
                      className={cn(
                        "block fs-note leading-[1.45]",
                        rung === next && state === "open" ? "text-need" : "text-tx3",
                      )}
                    >
                      {line}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <span className="text-tx3 fs-note hidden phone:block">
        <b className="text-tx2 font-semibold">{RUNG_NAMES[step]}</b>
        <br />
        {rungLine(step, rungs[step], step === next, setup, signer)}
      </span>
    </nav>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1 className="m-0 mb-1.5 text-[22px] font-bold tracking-[-0.01em]">{title}</h1>
      <p className="text-tx2 m-0 mb-[22px]">{children}</p>
    </>
  );
}

/** The button to the next step of the ladder, or back to the dashboard after the last. */
function NextButton({ to, onStep }: { to: Rung; onStep: (step: Rung) => void }) {
  return (
    <button type="button" className={PRIMARY} onClick={() => onStep(to)}>
      Next: {RUNG_NAMES[to].toLowerCase()}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 0 · Inbox: GitHub and the repository (r3 `12`)

function InboxStep({ me, github, setup, actions, onStep }: StepProps) {
  const onGitHubCom = github.host === GITHUB_COM;
  const scopes = me?.scopes ?? [];
  return (
    <>
      <Heading title="Your inbox">
        The first step is yours alone. nod reads the pull requests with your GitHub login and sorts
        them on your screen. Nothing changes in the repository.
      </Heading>
      <Checks>
        {me ? (
          <Check
            mark="ok"
            title={
              <>
                Signed in as <b>{me.login}</b>
              </>
            }
            note="no new permission"
          >
            found through <Mono>gh auth status</Mono> ·{" "}
            {scopes.length
              ? `scopes ${scopes.join(", ")}`
              : "a token without classic scopes (fine-grained or an app)"}
          </Check>
        ) : (
          <Check
            mark="bad"
            title={onGitHubCom ? "Not signed in to GitHub" : `Not signed in to ${github.host}`}
            note="nothing changed"
          >
            nod uses the login of the <Mono>gh</Mono> command line tool
            {onGitHubCom ? "" : ` for ${github.host}, the host of this clone’s origin`}. Run{" "}
            <Mono>{ghLoginCommand(github.host)}</Mono> in a terminal, then restart{" "}
            <Mono>nod serve</Mono>.
          </Check>
        )}
      </Checks>
      {me && (
        <RepoPicker
          me={me}
          setup={setup}
          actions={actions}
          then={() => onStep("shared-policy")}
          label={setup.state === "none" ? "Continue" : "Next: shared policy"}
        />
      )}
    </>
  );
}

/** The repos to pick from (`list-repos`), the current folder's first; one per `nod serve`. */
function RepoPicker({
  me,
  setup,
  actions,
  then,
  label = "Continue",
}: {
  me: Account;
  setup: SetupStatus;
  actions: Actions;
  /** After the pick: the next step, or nothing (the app moves on by itself). */
  then?: () => void;
  label?: string;
}) {
  const now = useNow(MINUTE);
  const [repos, setRepos] = useState<ReadonlyArray<RepoChoice> | null>(null);
  const list = useRequest();
  const pick = useRequest();
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void list.run("list", async () => {
      const r = await actions.request("list-repos", {});
      if (live) setRepos(r.repos);
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per account
  }, [me.login, actions]);

  const current = repos?.find((r) => r.current) ?? repos?.[0] ?? null;
  const selected = chosen ?? setup.repo ?? current?.repo ?? null;
  const sorted = repos ? [...repos].sort((a, b) => Number(b.current) - Number(a.current)) : [];

  const onContinue = async () => {
    if (!selected) return;
    const same = setup.repo?.toLowerCase() === selected.toLowerCase();
    if (same && setup.state !== "none") return then?.();
    if (await pick.run("pick", () => actions.request("pick-repo", { repo: selected }))) then?.();
  };

  return (
    <>
      <fieldset className="m-0 mt-5 border-0 p-0">
        <legend className="text-tx3 mb-2 p-0 fs-note">Repository</legend>
        {!repos && !list.failure && <p className="text-tx3 m-0 text-[13px]">Reading…</p>}
        {sorted.map((r) => {
          const on = r.repo === selected;
          const sub = r.current
            ? [
                "the repo of your current folder",
                r.canWrite ? "you have write access" : "you can read it, not push to it",
                setup.state === "ready" && setup.repo?.toLowerCase() === r.repo.toLowerCase()
                  ? "its policy is shared already"
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : r.pushedAt
              ? `last pushed ${duration(now - r.pushedAt)} ago`
              : "";
          return (
            <label
              key={r.repo}
              className={cn(
                "mb-2 grid w-full cursor-pointer grid-cols-[20px_1fr] gap-3 rounded-[10px] border px-4 py-3.5 text-left has-[:focus-visible]:ring-2",
                on ? "border-need bg-need-bg" : "border-line hover:border-line2",
              )}
            >
              <input
                type="radio"
                name="repo"
                value={r.repo}
                checked={on}
                onChange={() => setChosen(r.repo)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 size-4 rounded-full",
                  on ? "border-need border-[5px]" : "border-line2 border-[1.5px]",
                )}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {on ? <b>{r.repo}</b> : r.repo}
                <span className="text-tx3 block fs-note leading-[1.55]">{sub}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <ErrorNote failure={list.failure} lead="Could not list repositories." />
      <ErrorNote failure={pick.failure} lead="Could not use that repository." />
      <Footer note="One repository per window in this version.">
        <button
          type="button"
          className={PRIMARY}
          disabled={!selected || pick.busy !== null}
          onClick={() => void onContinue()}
        >
          {pick.busy ? "Reading the repository…" : label}
        </button>
      </Footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// 1 · Shared policy: the setup PR (r3 `13`)

const FILE_CHECKS: ReadonlyArray<SetupCheck["id"]> = [
  "policy",
  "verifier",
  "workflow",
  "allowed-signers",
];

function checkMark(check: SetupCheck): Mark {
  return check.state === "ok" ? "ok" : check.state === "pending" ? "wait" : "no";
}

function SetupCheckRow({ check }: { check: SetupCheck }) {
  const purpose = CHECK_PURPOSE[check.id];
  const paid = check.note === "needs a paid plan";
  return (
    <Check mark={paid ? "bad" : checkMark(check)} title={check.label} note={check.note}>
      {FILE_CHECKS.includes(check.id) ? (
        <>
          <Mono>{check.detail}</Mono> · {purpose}
        </>
      ) : paid ? (
        <>
          Private repositories need GitHub Pro, Team or Enterprise for rulesets; this plan has none.
        </>
      ) : check.id === "auto-merge" ? (
        <>
          {check.detail} · {purpose}
        </>
      ) : (
        <>
          <Mono>nod</Mono> {purpose}
        </>
      )}
    </Check>
  );
}

function Limits() {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-tx3 mt-4 text-[13px]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hover:text-tx2 text-left"
      >
        {open ? "▾" : "▸"} What this does and doesn’t protect
      </button>
      {open && (
        <p className="text-tx2 m-0 mt-2 leading-[1.55]">
          nod guards against mistakes and unattended merges. It does not stop an agent that
          deliberately pushes a workflow forging the <Mono>nod</Mono> check (ADR 0003): let agents
          push with a token that has no <Mono>workflow</Mono> scope and no admin rights.
        </p>
      )}
    </div>
  );
}

function AfterMerge() {
  return (
    <NoteBox className="mt-4">
      <b>After it merges</b>, every pull request gets a <Mono>nod</Mono> check that says what it
      needs and blocks nothing. Requiring it is the ladder’s last step, enforced, taken by a
      repository admin.
    </NoteBox>
  );
}

function SetupStep({ setup, signer, actions, onStep }: StepProps) {
  const open = useRequest();
  const recheck = useRequest();
  const repo = setup.repo ?? "this repository";
  const hasKey = signer.state !== "no-key";
  // The required check and auto-merge are the last step's (enforced).
  const files = setup.checks.filter((c) => FILE_CHECKS.includes(c.id));
  const again = (
    <button
      type="button"
      className={GHOST}
      disabled={recheck.busy !== null}
      onClick={() => void recheck.run("check", () => actions.request("check-setup", {}))}
    >
      {recheck.busy ? "Checking…" : "Check again"}
    </button>
  );

  if (setup.state === "ready")
    return (
      <>
        <Heading title="Shared policy">
          The repository has its policy and verifier: every pull request is classified the same way
          for everyone, and its <Mono>nod</Mono> check never blocks until the repository is
          enforced.
        </Heading>
        <Checks>
          <Check mark="ok" title={`${repo} shares one policy`}>
            the policy, the verifier, its workflow and the allowed signers are on the default branch
          </Check>
        </Checks>
        <ErrorNote failure={recheck.failure} lead="Could not check." />
        <Footer note="Changes to .nod/** go through a pull request a teammate nods.">
          {again}
          <NextButton to="signing" onStep={onStep} />
        </Footer>
      </>
    );

  const pr = setup.setupPr;
  const readOnly = setup.permission === "read";
  const onOpen = () => open.run("open", () => actions.request("open-setup-pr", {}));
  return (
    <>
      <Heading title={pr ? "Shared policy" : "Share one policy with the team"}>
        {pr ? (
          <>
            The setup pull request <PrAnchor pr={pr} /> is open. It merges under the repository’s
            current rules, the usual way: nothing is gated before or after it merges.
          </>
        ) : (
          "Today only your nod sorts these pull requests. One setup pull request adds a policy and a verifier to the repository: then every pull request is classified the same way for everyone, and its nod check never blocks until the repository is enforced."
        )}
      </Heading>
      <Checks>
        {files.map((c) => (
          <SetupCheckRow key={c.id} check={c} />
        ))}
      </Checks>
      {pr && <AfterMerge />}
      <Limits />
      <ErrorNote failure={open.failure} lead="Could not open the setup PR." />
      <ErrorNote failure={recheck.failure} lead="Could not check." />
      <Footer
        note={
          readOnly
            ? `Opening the setup PR needs write access to ${repo}. Someone who has it can open it from their nod.`
            : pr
              ? "The PR is yours to read and merge the usual way. Teammates who never install nod keep approving on GitHub."
              : hasKey
                ? "Your public key goes in as its first allowed signer. The PR is yours to read and merge the usual way."
                : "No key needed: approvals count. Signing is a step of its own, for each person, whenever they want it."
        }
      >
        {pr ? (
          <>
            <a href={pr.url} target="_blank" rel="noreferrer" className={GHOST}>
              Open #{pr.number} ↗
            </a>
            <NextButton to="signing" onStep={onStep} />
          </>
        ) : readOnly ? (
          again
        ) : (
          <>
            {again}
            <button
              type="button"
              className={PRIMARY}
              disabled={open.busy !== null}
              onClick={() => void onOpen()}
            >
              {open.busy ? "Opening the setup PR…" : "Open the setup PR"}
            </button>
          </>
        )}
      </Footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// 2 · Signing: your key (r3 `14`, `15`) and a test signature (r3 `16`)

function SigningStep(props: StepProps) {
  const [created, setCreated] = useState(false);
  const [testing, setTesting] = useState(false);
  if (props.signer.state === "no-key")
    return <CreateKey {...props} onCreated={() => setCreated(true)} />;
  if (testing) return <TestStep {...props} onBack={() => setTesting(false)} />;
  return <Enrol {...props} created={created} onTest={() => setTesting(true)} />;
}

const FIELD =
  "bg-bg text-tx h-[38px] w-full rounded-lg border px-3 text-[15px] tracking-[2px] outline-none phone:h-11";

function CreateKey({ progress, setup, actions, onCreated }: StepProps & { onCreated: () => void }) {
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);
  // Only facts about the fields, never their content.
  const [filled, setFilled] = useState({ first: false, second: false, long: false });
  const [problem, setProblem] = useState<{ field: "first" | "second"; message: string } | null>(
    null,
  );
  const create = useRequest();

  // The fields are emptied when the step goes away.
  useEffect(() => {
    const a = first.current;
    const b = second.current;
    return () => {
      if (a) a.value = "";
      if (b) b.value = "";
    };
  }, []);

  const onInput = () => {
    const a = first.current?.value ?? "";
    setFilled({
      first: a.length > 0,
      second: (second.current?.value ?? "").length > 0,
      long: [...a].length >= MIN_PASSPHRASE_LENGTH,
    });
    setProblem(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (create.busy) return;
    const found = passphraseProblem(first.current?.value ?? "", second.current?.value ?? "");
    if (found) {
      setProblem(found);
      (found.field === "first" ? first : second).current?.focus();
      return;
    }
    const passphrase = takePassphrase(first);
    takePassphrase(second);
    setFilled({ first: false, second: false, long: false });
    if (await create.run("create", () => actions.request("create-key", { passphrase })))
      onCreated();
  };

  const field = (
    id: string,
    label: string,
    ref: RefObject<HTMLInputElement | null>,
    which: "first" | "second",
  ) => (
    <div>
      <label htmlFor={id} className="text-tx3 mb-[5px] block fs-note">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        disabled={create.busy !== null}
        onInput={onInput}
        aria-invalid={problem?.field === which || undefined}
        aria-describedby="key-rule"
        className={cn(
          FIELD,
          problem?.field === which ? "border-bad" : "border-line2 focus:border-need",
        )}
      />
    </div>
  );

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <Heading title="Sign your own agent PRs">
        GitHub does not let you approve your own pull request; a nod can attest it. Nods are signed
        with an SSH key that only this app can unlock, and its public half goes into{" "}
        {setup.repo ?? "the repository"}, in <Mono>.nod/allowed_signers</Mono>. Without one you keep
        approving on GitHub.
      </Heading>
      <div className="border-need bg-need-bg rounded-[10px] border px-4 py-3.5">
        <b>Create a new key</b>
        <div className="text-tx3 fs-note leading-[1.55]">
          ed25519, kept encrypted in nod’s folder on this machine, used for nothing else
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2.5 phone:grid-cols-1">
          {field("key-passphrase", "Passphrase", first, "first")}
          {field("key-repeat", "Repeat", second, "second")}
        </div>
        <p id="key-rule" className="text-tx3 m-0 mt-2.5 fs-note leading-[1.55]">
          <span className={cn(filled.long && "text-ok")}>
            {filled.long ? "✓ " : ""}At least {MIN_PASSPHRASE_LENGTH} characters
          </span>
          ; a few words are easy to type. It protects your key on this machine and cannot be
          recovered: if you forget it, you make a new key.
        </p>
        {problem && (
          <p role="alert" className="text-bad m-0 mt-2 fs-note">
            {problem.message}
          </p>
        )}
      </div>
      <NoteBox className="mt-4">
        <b>How your key gets enrolled.</b>{" "}
        {progress.enrolVia === "setup-pr" && !setup.setupPr
          ? "Nobody has opened the setup PR yet, so if you open it after this, your public key goes in as its first allowed signer. Teammates who join later get a one-line enrolment PR each, which one of you signs."
          : progress.enrolVia === "setup-pr"
            ? "The setup PR is open already, without your key, so your key gets its own one-line enrolment PR once it merges. While nobody is enrolled, that first one merges the usual way."
            : "This repository is set up already, so your key gets a one-line enrolment PR. It touches .nod/**, so a teammate has to nod it; until it merges you can read everything and sign nothing."}
      </NoteBox>
      <ErrorNote failure={create.failure} lead="No key was created." />
      <Footer note="Nothing is registered on your GitHub account and no extra permission is asked for.">
        <button
          type="submit"
          className={PRIMARY}
          disabled={!filled.first || !filled.second || create.busy !== null}
        >
          {create.busy ? "Creating…" : "Create key"}
        </button>
      </Footer>
    </form>
  );
}

function Enrol({
  progress,
  me,
  github,
  setup,
  signer,
  people,
  actions,
  created,
  onTest,
}: StepProps & { created: boolean; onTest: () => void }) {
  const open = useRequest();
  const [copied, setCopied] = useState(false);
  if (signer.state === "no-key") return null;
  const { key } = signer;
  const enrolment = key.enrolment;
  const login = me?.login ?? "you";
  const repo = setup.repo ?? "this repository";
  const pendingPr = enrolment.state === "pending" ? enrolment.pr : null;
  const viaSetup = progress.enrolVia === "setup-pr";
  const inSetupPr =
    pendingPr !== null && setup.setupPr !== null && pendingPr.number === setup.setupPr.number;
  const who = teammates(people, login, "or") ?? "a teammate";
  const ask = teammates(people, login, "and");

  const openPr = (t: "open-setup-pr" | "open-enrol-pr") =>
    void open.run(t, () => actions.request(t, {}));

  const copyAsk = async (pr: PrLink) => {
    if (!setup.repo) return;
    const link = `${window.location.origin}${window.location.pathname}${formatRoute({ view: "pr", host: github.host, repo: setup.repo, number: pr.number })}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const enrolCheck = viaSetup ? (
    pendingPr ? (
      <Check
        mark="wait"
        title={
          <>
            {inSetupPr ? "Setup PR" : "Pull request"} <PrAnchor pr={pendingPr} /> is open
          </>
        }
        note="pending"
      >
        adds the policy, the verifier and your public key. Nobody can nod it yet: it merges under
        the repository’s current rules.
      </Check>
    ) : setup.setupPr ? (
      <Check
        mark="no"
        title={
          <>
            Setup PR <PrAnchor pr={setup.setupPr} /> is open without your key
          </>
        }
        note="after merge"
      >
        once it merges, your key gets its own one-line enrolment PR here.
      </Check>
    ) : (
      <Check mark="no" title="Setup PR" note="not opened yet">
        adds the policy, the verifier, its workflow and this key to{" "}
        <Mono>.nod/allowed_signers</Mono>. Nobody can nod it yet: it merges under the repository’s
        current rules.
      </Check>
    )
  ) : enrolment.state === "active" ? (
    <Check mark="ok" title={`Enrolled in ${repo}`}>
      your key is in <Mono>.nod/allowed_signers</Mono> on the default branch
    </Check>
  ) : (
    <Check
      mark={pendingPr ? "wait" : "no"}
      title={
        pendingPr ? (
          <>
            Enrolment PR <PrAnchor pr={pendingPr} /> is open
          </>
        ) : (
          "Enrolment PR"
        )
      }
      note={pendingPr ? "pending" : "not opened yet"}
    >
      adds one line to <Mono>.nod/allowed_signers</Mono>. The policy treats changes there as highest
      risk: {who} has to sign it.
    </Check>
  );

  const prNumber = pendingPr?.number ?? setup.setupPr?.number ?? null;
  const active = enrolment.state === "active";

  let primary: ReactNode;
  if (active || pendingPr)
    primary = (
      <button type="button" className={PRIMARY} onClick={onTest}>
        Test signature
      </button>
    );
  else if (viaSetup && !setup.setupPr)
    primary = (
      <button
        type="button"
        className={PRIMARY}
        disabled={open.busy !== null}
        onClick={() => openPr("open-setup-pr")}
      >
        {open.busy ? "Opening the setup PR…" : "Open the setup PR"}
      </button>
    );
  else if (!viaSetup)
    primary = (
      <button
        type="button"
        className={PRIMARY}
        disabled={open.busy !== null}
        onClick={() => openPr("open-enrol-pr")}
      >
        {open.busy ? "Opening the enrolment PR…" : "Open the enrolment PR"}
      </button>
    );
  else
    primary = (
      <button
        type="button"
        className={PRIMARY}
        disabled={open.busy !== null}
        onClick={() => void open.run("check", () => actions.request("check-setup", {}))}
      >
        Check again
      </button>
    );

  return (
    <>
      <Heading title="Your signing key">
        {viaSetup
          ? "Your public key goes into the repository’s list of allowed signers with the setup pull request."
          : "Your public key has to be in the repository’s list of allowed signers. Adding it is a small pull request that a teammate signs off."}
      </Heading>
      <Checks>
        <Check mark="ok" title={created ? "Key created" : "Your key on this machine"}>
          <Mono>{shortPath(key.location)}</Mono> · {shortFingerprint(key.fingerprint)} · protected
          by your passphrase
          <span className="bg-bg border-line text-tx2 mt-2 block rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-[1.5] break-all">
            {signerLine(login, key.publicKey)}
          </span>
        </Check>
        {enrolCheck}
        <Check mark={active ? "ok" : "no"} title="Key active">
          {active
            ? `your nods count in ${repo}`
            : `once ${prNumber ? `#${prNumber}` : viaSetup ? "the setup PR" : "the enrolment PR"} merges. Until then you approve on GitHub, and your signatures do not count.`}
        </Check>
      </Checks>
      <ErrorNote
        failure={open.failure}
        lead={viaSetup ? "Could not open the setup PR." : "Could not open the enrolment PR."}
      />
      <Footer note="No extra GitHub permission is needed for this.">
        {pendingPr && !viaSetup ? (
          <button
            type="button"
            className={cn(GHOST, "phone:flex-col phone:gap-0")}
            onClick={() => void copyAsk(pendingPr)}
            title="Copies a nod link to the PR, to send them"
          >
            {copied ? "Link copied" : ask ? `Ask ${ask}` : "Copy a link to ask a teammate"}
            <small className="hidden text-[13px] font-normal phone:block">
              copies a nod link to the PR, to send them
            </small>
          </button>
        ) : pendingPr ? (
          <a href={pendingPr.url} target="_blank" rel="noreferrer" className={GHOST}>
            Open #{pendingPr.number} ↗
          </a>
        ) : null}
        {primary}
      </Footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// 2 · Signing, the test signature (r3 `16`)

function TestStep({ setup, signer, actions, onLeave, onBack }: StepProps & { onBack: () => void }) {
  const passphrase = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [result, setResult] = useState<
    (TestSignatureResult & { readonly unlocked: "now" | "before" }) | null
  >(null);
  const test = useRequest();
  const repo = setup.repo ?? "this repository";

  useEffect(() => {
    const input = passphrase.current;
    return () => {
      if (input) input.value = "";
    };
  }, []);

  if (signer.state === "no-key")
    return (
      <>
        <Heading title="Test signature">There is no signing key to test yet.</Heading>
        <Footer>
          <button type="button" className={PRIMARY} onClick={onBack}>
            Create your key
          </button>
        </Footer>
      </>
    );

  const unlocked = signer.state === "unlocked";
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (test.busy) return;
    let how: "now" | "before" = "before";
    if (!unlocked) {
      const secret = takePassphrase(passphrase);
      setFilled(false);
      if (!secret) return;
      how = "now";
      // This one signature only: locked again right after it.
      const ok = await test.run("unlock", () => actions.unlock(secret, { minutes: 1, once: true }));
      if (!ok) {
        requestAnimationFrame(() => passphrase.current?.focus());
        return;
      }
    }
    await test.run("sign", async () => {
      const r = await actions.request("test-signature", {});
      setResult({ ...r, unlocked: how });
    });
  };

  const enrolment = result?.enrolment ?? signer.key.enrolment;
  const pendingPr = enrolment.state === "pending" ? enrolment.pr : null;
  const viaSetup = pendingPr !== null && setup.setupPr?.number === pendingPr.number;
  const enrolled =
    enrolment.state === "active" ? (
      <Check mark="ok" title={`Enrolled in ${repo}`}>
        your signatures count
      </Check>
    ) : enrolment.state === "pending" ? (
      <Check mark="wait" title={`Enrolled in ${repo}`} note="pending">
        pending:{" "}
        {pendingPr ? (
          <>
            {viaSetup ? "setup PR" : "enrolment PR"} <PrAnchor pr={pendingPr} /> is open
          </>
        ) : (
          "its pull request is open"
        )}
        . Your signatures count once it merges.
      </Check>
    ) : (
      <Check mark="no" title={`Not enrolled in ${repo} yet`} note="not yet">
        open the pull request that adds your key first; until it merges you approve on GitHub and
        sign nothing.
      </Check>
    );

  const badPassphrase = test.failure?.code === "bad-passphrase";
  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <Heading title="Test signature">
        A round trip with a harmless test message, to see that signing works on this machine.
      </Heading>
      <Checks>
        <Check
          mark={result ? "ok" : "no"}
          title={
            result?.unlocked === "before"
              ? "The key was unlocked already"
              : "Unlocked the key with your passphrase"
          }
        >
          the key stays inside nod serve, not in ssh-agent, and locks again right after
        </Check>
        <Check mark={result ? "ok" : "no"} title="Signed a test message">
          <Mono>SSHSIG</Mono> · namespace nod · not a nod, so it can never count on a pull request
        </Check>
        <Check
          mark={result ? (result.verified ? "ok" : "bad") : "no"}
          title={
            result && !result.verified
              ? "Did not verify against your public key"
              : "Verified against your public key"
          }
          note={result ? (result.verified ? "verified ✓" : "failed") : undefined}
        >
          {result && !result.verified
            ? "the signature does not match the key nod shows. Restart nod serve and try again."
            : "locally, the same way the verifier will do it"}
        </Check>
        {enrolled}
      </Checks>
      {!result && !unlocked && (
        <div className="border-line2 bg-bg mt-4 rounded-xl border p-[18px]">
          <label htmlFor="test-passphrase" className="text-tx3 mb-2 block fs-note">
            Passphrase for your signing key
          </label>
          <PassphraseField
            id="test-passphrase"
            inputRef={passphrase}
            error={badPassphrase ? onboardingError(test.failure!) : null}
            disabled={test.busy !== null}
            onFilled={setFilled}
          />
        </div>
      )}
      {!badPassphrase && <ErrorNote failure={test.failure} lead="The test did not run." />}
      <Footer
        note={
          result
            ? enrolment.state === "active"
              ? "You are ready to nod."
              : pendingPr
                ? `You can start reading now. Signing is switched on when #${pendingPr.number} merges.`
                : "You can start reading now. Signing is switched on once your key is enrolled."
            : "Nothing is posted anywhere: the message stays on this machine."
        }
      >
        {result ? (
          <>
            {pendingPr && (
              <a href={pendingPr.url} target="_blank" rel="noreferrer" className={GHOST}>
                Open #{pendingPr.number}
              </a>
            )}
            {onLeave ? (
              <button type="button" className={PRIMARY} onClick={onLeave}>
                Go to the dashboard
              </button>
            ) : (
              <button type="button" className={GHOST} onClick={onBack}>
                Back
              </button>
            )}
          </>
        ) : (
          <button
            type="submit"
            className={PRIMARY}
            disabled={test.busy !== null || (!unlocked && !filled)}
          >
            {!unlocked && <Lock className="size-4" />}
            {test.busy === "unlock"
              ? "Unlocking…"
              : test.busy === "sign"
                ? "Signing…"
                : unlocked
                  ? "Sign a test message"
                  : "Unlock and sign a test message"}
          </button>
        )}
      </Footer>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 3 · Enforced: the required check (`nod init --ruleset`, run by an admin)

/** The command that enforces a repo; nod never runs it from the browser: it changes who may merge. */
export const ENFORCE_COMMAND = "nod init --ruleset";

/** The command, in a box with a copy button. */
export function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="bg-bg border-line flex items-center gap-2.5 rounded-lg border py-1 pr-1 pl-3.5">
      <code className="text-tx fs-code min-w-0 flex-1 font-mono [overflow-wrap:anywhere] phone:select-all">
        {command}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        className="text-tx2 hover:text-tx fs-note h-8 flex-none rounded-md px-2.5 phone:h-11"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function EnforcedStep({
  setup,
  actions,
  onLeave,
  onStep,
  state,
}: StepProps & { state: RungState }) {
  const recheck = useRequest();
  const repo = setup.repo ?? "this repository";
  const rules = setup.checks.filter((c) => c.id === "required-check" || c.id === "auto-merge");
  const paid = rules.some((c) => c.note === "needs a paid plan");
  const again = (
    <button
      type="button"
      className={GHOST}
      disabled={recheck.busy !== null}
      onClick={() => void recheck.run("check", () => actions.request("check-setup", {}))}
    >
      {recheck.busy ? "Checking…" : "Check again"}
    </button>
  );
  const leave = onLeave && (
    <button type="button" className={PRIMARY} onClick={onLeave}>
      Back to the dashboard
    </button>
  );

  return (
    <>
      <Heading title={state === "done" ? "Enforced" : "Let agents merge on their own"}>
        {state === "done" ? (
          <>
            {repo} requires the <Mono>nod</Mono> check: a pull request merges once its requirement
            is met, and agents merge on their own.
          </>
        ) : (
          <>
            The last step, taken by the repository. A ruleset makes the <Mono>nod</Mono> check
            required on the default branch, with zero required approvals, and auto-merge is allowed.
            Then a pull request merges once its requirement is met: a nod, or an approval where the
            policy takes one.
          </>
        )}
      </Heading>
      {rules.length > 0 && (
        <Checks>
          {rules.map((c) => (
            <SetupCheckRow key={c.id} check={c} />
          ))}
        </Checks>
      )}
      {state === "later" ? (
        <NoteBox className="mt-4">
          <b>After the shared policy.</b> The check exists once the setup PR has merged; requiring
          it comes after that.
        </NoteBox>
      ) : state === "open" || state === "not-yours" ? (
        <div className="mt-4">
          <p className="text-tx2 m-0 mb-2.5 text-[13px] leading-[1.55]">
            {state === "open"
              ? "Run this in a clone of the repository. It needs admin rights"
              : "It needs a repository admin: ask one to run this in a clone of the repository"}
            {setup.permission === "admin" ? ", which you have" : ""}. nod does not run it from here:
            it changes who may merge.
          </p>
          <CommandBox command={ENFORCE_COMMAND} />
          {paid && (
            <p className="text-bad m-0 mt-2 fs-note">
              Private repositories need GitHub Pro, Team or Enterprise for rulesets; this plan has
              none.
            </p>
          )}
          <NoteBox className="mt-4">
            <b>Before you do.</b> From then on every change to <Mono>.nod/</Mono> or{" "}
            <Mono>.github/workflows/</Mono> needs a peer’s nod, so at least two people should have
            signing set up. Teammates without a key keep approving on GitHub; their approval counts
            where the policy takes one.
          </NoteBox>
        </div>
      ) : null}
      <ErrorNote failure={recheck.failure} lead="Could not check." />
      <Footer
        note={
          state === "done"
            ? "Changes to the policy go through a pull request a teammate nods."
            : "nod reads the rules again on its next poll, or when you check."
        }
      >
        {state === "later" ? (
          <button type="button" className={PRIMARY} onClick={() => onStep("shared-policy")}>
            Back to the shared policy
          </button>
        ) : (
          <>
            {again}
            {leave}
          </>
        )}
      </Footer>
    </>
  );
}
