/**
 * Onboarding (r3 `12`–`16`): four short steps, each mostly a list of checks.
 * Shown instead of the dashboard while the setup or the key is not ready,
 * and reopened later from the avatar menu ("Setup and checks", `#/setup`).
 *
 * Where a visit starts and what is done come from the server's state alone
 * (`lib/onboarding.ts`), so it resumes wherever it was left. Every action is
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
  STEP_NAMES,
  nextStep,
  onboardingError,
  passphraseProblem,
  progressOf,
  reachable,
  shortFingerprint,
  shortPath,
  signerLine,
  teammates,
  type Progress,
  type StepNumber,
} from "@/lib/onboarding";
import { formatRoute } from "@/lib/route";
import { GITHUB_COM, ghLoginCommand } from "../../kit/host.ts";
import { duration } from "@/lib/time";
import { cn } from "@/lib/utils";
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
// the flow

export interface OnboardingProps {
  readonly me: Account | null;
  /** The GitHub host `nod serve` reads. */
  readonly github: GitHubInfo;
  readonly setup: SetupStatus;
  readonly signer: SignerState;
  readonly people: ReadonlyArray<Person>;
  readonly actions: Actions;
  /** Reopened from the avatar menu: starts on the checks, not on what is missing. */
  readonly reopened: boolean;
  /** There is a dashboard to go to (a snapshot is in). */
  readonly canLeave: boolean;
  readonly onDone: () => void;
}

/** The step a visit opens on. */
function firstStep(progress: Progress, reopened: boolean): StepNumber {
  if (reopened && !progress.needed) return 2;
  return progress.start;
}

export function Onboarding(props: OnboardingProps) {
  const { me, setup, signer, canLeave, onDone } = props;
  const progress = progressOf({ me, setup, signer });
  const [step, setStep] = useState<StepNumber>(() => firstStep(progress, props.reopened));
  const [created, setCreated] = useState(false);
  const go = (s: StepNumber) => setStep(s);
  const next = () => setStep(nextStep(progress, step));

  return (
    <div className="pt-safe pb-safe px-safe flex min-h-full flex-col">
      <TopBarShell>
        <Logo />
        <span className="flex-1" />
        {canLeave && (
          <button
            type="button"
            onClick={onDone}
            className="text-tx3 hover:text-tx2 fs-note phone:min-h-11"
          >
            {progress.needed ? "Look around first" : "Back to the dashboard"}
          </button>
        )}
        <span className="text-tx3 fs-note phone:hidden">Setup · step {step} of 4</span>
      </TopBarShell>
      <div className="mx-auto my-12 grid w-full max-w-[940px] grid-cols-[230px_1fr] gap-11 px-6 phone:my-4 phone:grid-cols-1 phone:gap-4 phone:px-4">
        <Stepper progress={progress} step={step} onStep={go} />
        <main
          className="border-line bg-panel rounded-2xl border px-9 py-8 phone:px-5 phone:py-6"
          aria-live="polite"
        >
          {step === 1 ? (
            <GitHubStep progress={progress} {...props} onNext={next} />
          ) : step === 2 ? (
            <SetupStep progress={progress} {...props} onNext={next} />
          ) : step === 3 ? (
            <KeyStep
              progress={progress}
              {...props}
              created={created}
              onCreated={() => setCreated(true)}
              onNext={next}
            />
          ) : (
            <TestStep progress={progress} {...props} onDone={onDone} onBack={() => go(3)} />
          )}
        </main>
      </div>
    </div>
  );
}

function Stepper({
  progress,
  step,
  onStep,
}: {
  progress: Progress;
  step: StepNumber;
  onStep: (step: StepNumber) => void;
}) {
  return (
    <div className="contents phone:flex phone:items-center phone:justify-between">
      <ol
        className="m-0 mt-1.5 list-none p-0 phone:mt-0 phone:flex phone:items-center"
        aria-label="Setup steps"
      >
        {STEP_NAMES.map((name, i) => {
          const n = (i + 1) as StepNumber | 5;
          const on = n === step;
          const done = n !== 5 && !on && progress.done[n];
          const canGo = n !== 5 && !on && reachable(progress, n);
          const inner = (
            <>
              <i
                className={cn(
                  "grid size-[22px] flex-none place-items-center rounded-full border-[1.5px] text-[11px] font-bold not-italic phone:size-7 phone:text-xs",
                  on
                    ? "border-need text-need"
                    : done
                      ? "bg-ok border-ok text-[#06140d]"
                      : "border-line2",
                )}
              >
                {done ? "✓" : n}
              </i>
              <span className="phone:sr-only">{name}</span>
            </>
          );
          const cls = cn(
            "flex items-center gap-3 py-[9px] text-left phone:min-h-11 phone:min-w-11 phone:justify-center",
            on ? "text-tx font-semibold" : done ? "text-tx2" : "text-tx3",
          );
          return (
            <li key={name} aria-current={on ? "step" : undefined}>
              {canGo ? (
                <button
                  type="button"
                  className={cn(cls, "hover:text-tx")}
                  onClick={() => onStep(n)}
                >
                  {inner}
                </button>
              ) : (
                <span className={cls}>{inner}</span>
              )}
            </li>
          );
        })}
      </ol>
      <span className="text-tx3 fs-note hidden phone:block">Step {step} of 4</span>
    </div>
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

// ---------------------------------------------------------------------------
// 1 · GitHub and repository (r3 `12`)

function GitHubStep({
  progress,
  me,
  github,
  setup,
  actions,
  onNext,
}: OnboardingProps & { progress: Progress; onNext: () => void }) {
  const now = useNow(MINUTE);
  const onGitHubCom = github.host === GITHUB_COM;
  const [repos, setRepos] = useState<ReadonlyArray<RepoChoice> | null>(null);
  const list = useRequest();
  const pick = useRequest();
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let live = true;
    void list.run("list", async () => {
      const r = await actions.request("list-repos", {});
      if (live) setRepos(r.repos);
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per account
  }, [me?.login, actions]);

  const current = repos?.find((r) => r.current) ?? repos?.[0] ?? null;
  const selected = chosen ?? setup.repo ?? current?.repo ?? null;
  const sorted = repos ? [...repos].sort((a, b) => Number(b.current) - Number(a.current)) : [];

  const onContinue = async () => {
    if (!selected) return;
    const same = setup.repo?.toLowerCase() === selected.toLowerCase();
    if (same && setup.state !== "none") return onNext();
    if (await pick.run("pick", () => actions.request("pick-repo", { repo: selected }))) onNext();
  };

  const scopes = me?.scopes ?? [];
  return (
    <>
      <Heading title="Connect to GitHub">
        nod runs on this machine and uses the GitHub login you already have. Nothing is stored on a
        server.
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
            {onGitHubCom ? "" : ` for ${github.host}, the host of this clone's origin`}. Run{" "}
            <Mono>{ghLoginCommand(github.host)}</Mono> in a terminal, then restart{" "}
            <Mono>nod serve</Mono>.
          </Check>
        )}
      </Checks>
      {me && (
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
                    ? "set up for nod already"
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
      )}
      <ErrorNote failure={list.failure} lead="Could not list repositories." />
      <ErrorNote failure={pick.failure} lead="Could not use that repository." />
      <Footer note="One repository per window in this version.">
        <button
          type="button"
          className={PRIMARY}
          disabled={!me || !selected || pick.busy !== null}
          onClick={() => void onContinue()}
        >
          {pick.busy ? "Reading the repository…" : "Continue"}
        </button>
      </Footer>
      {progress.done[2] && progress.setup === "ready" && (
        <span className="sr-only">The repository is set up already; step 2 is skipped.</span>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 2 · Repository setup (r3 `13`)

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

function AfterMerge({ setup }: { setup: SetupStatus }) {
  const paid = setup.checks.some(
    (c) => c.id === "required-check" && c.note === "needs a paid plan",
  );
  return (
    <NoteBox className="mt-4">
      <b>After it merges</b>, a repo admin does one step: the required check on, required approvals
      from 1 to 0, auto-merge allowed. <Mono>nod init --ruleset</Mono> in the repository’s folder
      does it.{" "}
      {paid
        ? "This repository’s plan has no rulesets: private repos need GitHub Pro, Team or Enterprise."
        : "On a private repository this needs GitHub Pro, Team or Enterprise."}
    </NoteBox>
  );
}

function SetupStep({
  setup,
  signer,
  actions,
  onNext,
}: OnboardingProps & { progress: Progress; onNext: () => void }) {
  const open = useRequest();
  const recheck = useRequest();
  const repo = setup.repo ?? "this repository";
  const hasKey = signer.state !== "no-key";
  const rules = setup.checks.filter((c) => !FILE_CHECKS.includes(c.id));
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
        <Heading title="Repository setup">
          Setup happens once, through a pull request. This repository has it already, so this step
          is skipped.
        </Heading>
        <Checks>
          <Check mark="ok" title={`${repo} is set up for nod`}>
            the policy, the verifier, its workflow and the allowed signers are on the default branch
          </Check>
          {rules
            .filter((c) => c.state !== "ok")
            .map((c) => (
              <SetupCheckRow key={c.id} check={c} />
            ))}
        </Checks>
        <ErrorNote failure={recheck.failure} lead="Could not check." />
        <Footer note="Changes to .nod/** go through a pull request a teammate nods.">
          {again}
          <button type="button" className={PRIMARY} onClick={onNext}>
            Continue
          </button>
        </Footer>
      </>
    );

  const pr = setup.setupPr;
  const onOpen = () => open.run("open", () => actions.request("open-setup-pr", {}));
  return (
    <>
      <Heading title={`Set up ${repo}`}>
        {pr ? (
          <>
            The setup pull request <PrAnchor pr={pr} /> is open. It merges under the repository’s
            current rules: nobody can nod it yet, the verifier comes with it.
          </>
        ) : (
          "This repository has not been set up yet. Setup happens once, through a pull request, and everything it adds lives in the repo."
        )}
      </Heading>
      <Checks>
        {setup.checks.map((c) => (
          <SetupCheckRow key={c.id} check={c} />
        ))}
      </Checks>
      {pr && <AfterMerge setup={setup} />}
      <Limits />
      <ErrorNote failure={open.failure} lead="Could not open the setup PR." />
      <ErrorNote failure={recheck.failure} lead="Could not check." />
      <Footer
        note={
          pr || hasKey
            ? "The PR is yours to read and merge the usual way. Nothing is gated before it merges."
            : "Your public key goes into this PR, so you create your key first. Nothing is gated before it merges."
        }
      >
        {pr ? (
          <>
            <a href={pr.url} target="_blank" rel="noreferrer" className={GHOST}>
              Open #{pr.number} ↗
            </a>
            <button type="button" className={PRIMARY} onClick={onNext}>
              Continue
            </button>
          </>
        ) : hasKey ? (
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
        ) : (
          <>
            {again}
            <button type="button" className={PRIMARY} onClick={onNext}>
              Continue
            </button>
          </>
        )}
      </Footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// 3 · Your signing key (r3 `14`, `15`)

function KeyStep(
  props: OnboardingProps & {
    progress: Progress;
    created: boolean;
    onCreated: () => void;
    onNext: () => void;
  },
) {
  if (props.signer.state === "no-key") return <CreateKey {...props} />;
  return <Enrol {...props} />;
}

const FIELD =
  "bg-bg text-tx h-[38px] w-full rounded-lg border px-3 text-[15px] tracking-[2px] outline-none phone:h-11";

function CreateKey({
  progress,
  actions,
  onCreated,
}: OnboardingProps & { progress: Progress; onCreated: () => void }) {
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
      <Heading title="Your signing key">
        Signatures are made with an SSH key that only this app can unlock. The public half goes into
        the repository, in <Mono>.nod/allowed_signers</Mono>.
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
        {progress.enrolVia === "setup-pr"
          ? "You are setting up this repository, so your public key is part of the setup PR. Teammates who join later get a one-line enrolment PR each, which one of you signs."
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
  onNext,
}: OnboardingProps & { progress: Progress; created: boolean; onNext: () => void }) {
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
      <button type="button" className={PRIMARY} onClick={onNext}>
        Continue
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
            : `once ${prNumber ? `#${prNumber}` : viaSetup ? "the setup PR" : "the enrolment PR"} merges. Until then you can read everything, and your signatures do not count.`}
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
// 4 · Test signature (r3 `16`)

function TestStep({
  setup,
  signer,
  actions,
  onDone,
  onBack,
}: OnboardingProps & { progress: Progress; onBack: () => void }) {
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
      <Check mark="no" title={`Not enrolled in ${repo} yet`} note="step 3">
        open the pull request that adds your key in step 3; until it merges you can read everything
        and sign nothing.
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
            <button type="button" className={PRIMARY} onClick={onDone}>
              Go to the dashboard
            </button>
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
