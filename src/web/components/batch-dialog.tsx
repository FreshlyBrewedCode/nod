/**
 * The batch dialog (concept decision 14; r2 `11`–`14`, unchanged in r3).
 * Every way to sign or approve goes through one function,
 * `openBatch(prIds)`: the selection bar's "Review & sign", `s`, the
 * row's ask, the panel's "Sign", the board's "Sign…". One surface from
 * review to signed:
 *
 * - review: one sentence, rows grouped by my role with the outcome per PR,
 *   "not opened" marks, a row can be taken out; the exact heads and
 *   patch-ids behind "Show exactly what is signed";
 * - unlock, in place, when the key is locked (never a second dialog);
 * - signed: what happens now per PR; or nothing signed (stale: what moved,
 *   "Review again"); posting failures per PR, with a retry.
 *
 * Without an active key the asks are GitHub approvals (ADR 0006): the same
 * surface, review → approving → approved (or stale, or an error), with no
 * passphrase and nothing signed. One kind per batch (`batchKind`).
 *
 * A batch may span repos (ADR 0007, 10): rows carry their repo chip, the
 * sentence says "one signature each", "Show exactly what is signed" lists
 * one payload per repo, and whether my key can sign is the worst of the
 * batch's repos (`worstEnrolment`). One unlock signs them all.
 *
 * The steps are the pure state machine in `lib/batch.ts`.
 */

import { Lock, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { attentionView } from "../../shared/attention";
import type {
  PrId,
  PrRef,
  PrView,
  RepoInfo,
  RepoKey,
  SignerState,
  Snapshot,
} from "../../shared/protocol";
import { idOf, prId, sameRepo } from "../../shared/repo-key";
import { afterBack, useBackStop } from "@/hooks/use-back-stop";
import { SECOND, useNow } from "@/hooks/use-clock";
import type { Actions } from "@/hooks/use-connection";
import { useIsPhone } from "@/hooks/use-is-phone";
import { useVisualViewport } from "@/hooks/use-visual-viewport";
import {
  INITIAL_BATCH,
  batchKind,
  batchReducer,
  batchRows,
  countWord,
  entriesOf,
  groupByRole,
  openModel,
  findPr,
  outcomeOf,
  outcomeSentence,
  readiness,
  reposOf,
  reviewAgain,
  roleShort,
  staleText,
  summarySentence,
  toggleRow,
  type BatchEvent,
  type BatchKind,
  type BatchRow,
  type BatchState,
  type Outcome,
} from "@/lib/batch";
import { whyNotNeeded } from "@/lib/deep-link";
import { lastOneLeft, needsYouOrder } from "@/lib/next";
import { chipsOf, repoOf, worstEnrolment } from "@/lib/repos";
import { STORAGE_KEYS, browserStorage, readJson, readOpened } from "@/lib/storage";
import { ago, countdown } from "@/lib/time";
import { keyboardOpen, sheetBox } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { whoOf, type People } from "@/lib/wording";
import { Avatar, Kbd, RepoChip, RiskBars } from "./bits";
import { DiffIndicator } from "./diff-indicator";
import {
  PassphraseField,
  StayUnlocked,
  cannotSignText,
  failureOf,
  takePassphrase,
  unlockErrorText,
} from "./unlock";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";

export interface Batch {
  /** Open the batch dialog for these PRs (one or many, of one repo or several), by PR id. */
  openBatch(prs: ReadonlyArray<PrId>): void;
}

const BatchContext = createContext<Batch | null>(null);

export function BatchProvider({
  snapshot,
  repos,
  signer,
  actions,
  onOpenPr,
  children,
}: {
  snapshot: Snapshot;
  /** The repos, with my key's enrolment in each. */
  repos: ReadonlyArray<RepoInfo>;
  signer: SignerState | null;
  actions: Actions;
  /** Show a PR's details page (a phone's "Open the last one"). */
  onOpenPr?: (pr: PrId) => void;
  children: ReactNode;
}) {
  // Each opening is a fresh dialog: its own model, steps and passphrase field.
  const [open, setOpen] = useState<{ ids: ReadonlyArray<PrId>; id: number } | null>(null);
  const openBatch = useCallback((ids: ReadonlyArray<PrId>) => {
    if (ids.length) setOpen((o) => ({ ids: [...ids], id: (o?.id ?? 0) + 1 }));
  }, []);
  const value = useMemo(() => ({ openBatch }), [openBatch]);
  // "Open the last one": the sheet closes first (its history entry is popped), then the page opens.
  const after = useRef<PrId | null>(null);
  useEffect(() => {
    if (open !== null || after.current === null) return;
    const pr = after.current;
    after.current = null;
    afterBack(() => onOpenPr?.(pr));
  }, [open, onOpenPr]);
  return (
    <BatchContext.Provider value={value}>
      {children}
      {open && (
        <BatchDialog
          key={open.id}
          ids={open.ids}
          snapshot={snapshot}
          repos={repos}
          signer={signer}
          actions={actions}
          onClose={() => setOpen(null)}
          onOpenPr={
            onOpenPr &&
            ((pr) => {
              after.current = pr;
              setOpen(null);
            })
          }
        />
      )}
    </BatchContext.Provider>
  );
}

export function useBatch(): Batch {
  const batch = useContext(BatchContext);
  if (!batch) throw new Error("useBatch needs a BatchProvider above it");
  return batch;
}

// ---------------------------------------------------------------------------

const BTN =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-semibold disabled:opacity-50";
const GHOST = cn(
  BTN,
  "text-tx2 hover:text-tx h-[42px] border-transparent px-4 text-[14px] font-medium phone:h-[46px] phone:rounded-[11px] phone:text-[15px]",
);
const PRIMARY = cn(
  BTN,
  "bg-need border-need text-on-need h-[42px] px-5 text-[14px] phone:h-[46px] phone:flex-1 phone:rounded-[11px] phone:text-[15px]",
);
const KBD_ON_NEED = "border-[#0003] bg-[#0002] text-on-need phone:hidden";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function BatchDialog({
  ids,
  snapshot,
  repos,
  signer,
  actions,
  onClose,
  onOpenPr,
}: {
  ids: ReadonlyArray<PrId>;
  snapshot: Snapshot;
  repos: ReadonlyArray<RepoInfo>;
  signer: SignerState | null;
  actions: Actions;
  onClose: () => void;
  onOpenPr?: (pr: PrId) => void;
}) {
  const { prs, people } = snapshot;
  const chips = useMemo(() => chipsOf(repos), [repos]);
  // A phone's sheet is full screen, one history entry deep (back closes it, but not while a
  // sign request is in flight) and kept above the on-screen keyboard.
  const phone = useIsPhone();
  const viewport = useVisualViewport();
  const box = phone ? sheetBox(viewport) : null;
  const keyboard = phone && keyboardOpen(viewport, window.innerHeight);
  const [model, setModel] = useState(() => openModel(prs, ids));
  // Which PRs were opened in the UI, as of now: the "not opened" mark.
  const [opened] = useState(() => readOpened(readJson(browserStorage(), STORAGE_KEYS.opened)));
  const [state, dispatch] = useReducer(batchReducer, INITIAL_BATCH);
  const [details, setDetails] = useState(false);
  const [once, setOnce] = useState(false);
  const [filled, setFilled] = useState(false);
  const passphrase = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  // Each step starts on its primary button, so Enter does the obvious thing
  // (the unlock step starts in the passphrase field instead).
  useEffect(() => {
    if (state.step !== "unlock") primary.current?.focus();
  }, [state.step]);

  const rows = useMemo(() => batchRows(model, prs, { opened }), [model, prs, opened]);
  // Nods or GitHub approvals: the first picked PR that asks for something decides.
  const kind = useMemo(() => batchKind(model, prs), [model, prs]);
  const included = rows.filter((r) => r.included);
  // One key, enrolled per repo: a batch of nods can count on the worst of its repos.
  const ready = readiness(signer, worstEnrolment(repos, reposOf(rows)));
  const busy =
    state.step === "signing" ||
    state.step === "approving" ||
    (state.step === "unlock" && state.busy);
  useBackStop(phone, onClose, busy);
  const order = useMemo(() => needsYouOrder(attentionView(prs)[0]!.items), [prs]);

  const run = async (entries: Parameters<Actions["sign"]>[0]) => {
    try {
      dispatch({ t: "signed", result: await actions.sign(entries) });
    } catch (error) {
      const details = (error as { details?: Extract<BatchEvent, { t: "sign-failed" }>["details"] })
        .details;
      dispatch({ t: "sign-failed", failure: failureOf(error), ...(details && { details }) });
    }
  };

  const runApprove = async (entries: Parameters<Actions["approve"]>[0]) => {
    try {
      dispatch({ t: "approved", result: await actions.approve(entries) });
    } catch (error) {
      const details = (
        error as { details?: Extract<BatchEvent, { t: "approve-failed" }>["details"] }
      ).details;
      dispatch({ t: "approve-failed", failure: failureOf(error), ...(details && { details }) });
    }
  };

  /** The primary button of a batch of approvals (and "Retry" after it): no unlock, ever. */
  const approve = (event: Extract<BatchEvent, { t: "approve" }>) => {
    const next = batchReducer(state, event);
    dispatch(event);
    if (next.step === "approving") void runApprove(next.attempt.entries);
  };
  const shownRows = () =>
    groupByRole(rows, people)
      .flatMap((g) => g.rows)
      .filter((r) => r.included)
      .map((r) => r.pr);

  /** The primary button in review (and "Retry" after signing): sign, or unlock first. */
  const sign = (event: Extract<BatchEvent, { t: "sign" }>) => {
    const next = batchReducer(state, event);
    dispatch(event);
    if (next.step === "signing") void run(next.attempt.entries);
  };
  const signIncluded = () =>
    // In the order the dialog shows them: by role.
    kind === "approve"
      ? approve({ t: "approve", rows: shownRows(), entries: entriesOf(rows) })
      : sign({ t: "sign", readiness: ready.state, rows: shownRows(), entries: entriesOf(rows) });

  const unlockAndSign = async () => {
    if (state.step !== "unlock" || state.busy) return;
    const secret = takePassphrase(passphrase);
    setFilled(false);
    if (!secret) return;
    const { entries } = state.attempt;
    dispatch({ t: "unlock" });
    try {
      await actions.unlock(secret, once ? { once: true } : {});
    } catch (error) {
      dispatch({ t: "unlock-failed", failure: failureOf(error) });
      requestAnimationFrame(() => passphrase.current?.focus());
      return;
    }
    dispatch({ t: "unlocked" });
    await run(entries);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    switch (state.step) {
      case "review":
        return signIncluded();
      case "unlock":
        return void unlockAndSign();
      case "signed":
      case "approved":
        return onClose();
      case "stale":
        setModel((m) => reviewAgain(m, state.stale));
        void actions.refresh().catch(() => {});
        return dispatch({ t: "back" });
      case "error":
        return onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        aria-describedby="batch-summary"
        // A phone: the whole screen (100dvh, or the visual viewport while a keyboard is up).
        className="max-h-[calc(100vh-48px)] phone:top-0 phone:left-0 phone:h-dvh phone:max-h-none phone:w-full phone:translate-x-0 phone:translate-y-0 phone:rounded-none phone:border-0 phone:pt-safe phone:px-safe"
        closeClassName="phone:hidden"
        style={box ? { top: box.top, height: box.height } : undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          primary.current?.focus();
        }}
      >
        <form onSubmit={onSubmit} className="flex min-h-0 flex-col phone:flex-1">
          {state.step === "signed" || state.step === "approved" ? (
            <Signed
              kind={state.step === "approved" ? "approve" : "sign"}
              shown={state.shown}
              result={state.result}
              people={people}
              signer={signer}
              primary={primary}
              last={
                phone && onOpenPr
                  ? lastOneLeft(
                      order,
                      state.result.posted.map((x) => prId(x.repo, x.pr)),
                    )
                  : null
              }
              prs={prs}
              chips={chips}
              onOpenLast={onOpenPr}
              onRetry={(failed) => {
                const entries = failed.map((f) => ({
                  repo: f.repo,
                  pr: f.pr,
                  head_sha: model.heads[prId(f.repo, f.pr)] ?? "",
                }));
                if (state.step === "approved") approve({ t: "approve", rows: [], entries });
                else sign({ t: "sign", readiness: ready.state, rows: [], entries });
              }}
            />
          ) : state.step === "stale" ? (
            <Stale
              kind={kind}
              state={state}
              prs={prs}
              chips={chips}
              rows={rows}
              primary={primary}
              onCancel={onClose}
            />
          ) : state.step === "error" ? (
            <ErrorStep
              kind={kind}
              state={state}
              primary={primary}
              onBack={() => dispatch({ t: "back" })}
            />
          ) : (
            <Review
              kind={kind}
              state={state}
              rows={rows}
              people={people}
              repos={repos}
              chips={chips}
              me={snapshot.me}
              phone={phone}
              details={details}
              onDetails={setDetails}
              onToggle={(pr) => setModel((m) => toggleRow(m, pr))}
            />
          )}

          {(state.step === "review" ||
            state.step === "unlock" ||
            state.step === "signing" ||
            state.step === "approving") && (
            <>
              {state.step === "unlock" && phone && (
                <UnlockDock
                  passphrase={passphrase}
                  primary={primary}
                  error={state.error ? unlockErrorText(state.error) : null}
                  busy={state.busy}
                  filled={filled}
                  count={included.length}
                  once={once}
                  keyboard={keyboard}
                  onFilled={setFilled}
                  onOnce={setOnce}
                />
              )}
              {state.step === "unlock" && !phone && (
                <div className="border-line2 bg-bg mx-[30px] mt-4 rounded-xl border p-[18px]">
                  <label htmlFor="batch-passphrase" className="text-tx3 mb-2 block text-[12.5px]">
                    Passphrase for your signing key
                  </label>
                  <PassphraseField
                    id="batch-passphrase"
                    inputRef={passphrase}
                    error={state.error ? unlockErrorText(state.error) : null}
                    disabled={state.busy}
                    onFilled={setFilled}
                  />
                  <StayUnlocked once={once} onOnce={setOnce} />
                </div>
              )}
              {state.step === "review" &&
                kind === "sign" &&
                ready.state !== "unlocked" &&
                ready.state !== "locked" && (
                  <p className="border-line2 bg-bg text-tx2 mx-[30px] mt-4 mb-0 rounded-xl border p-[18px] text-[13px] leading-[1.55] phone:mx-4 phone:p-3.5">
                    {cannotSignText(ready)}
                  </p>
                )}
              {!(phone && state.step === "unlock") && (
                <ReviewFooter
                  kind={kind}
                  state={state}
                  count={included.length}
                  ready={ready.state}
                  signer={signer}
                  filled={filled}
                  primary={primary}
                  onCancel={onClose}
                  onBack={() => dispatch({ t: "back" })}
                />
              )}
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// review (and unlock: the same rows, the field below)

/** A phone's close, at the left of the sheet's header (the corner one is hidden there). */
function SheetClose() {
  return (
    <DialogClose
      aria-label="Close"
      className="text-tx hidden min-h-11 min-w-11 flex-none place-items-center phone:grid"
    >
      <X className="size-5" />
    </DialogClose>
  );
}

/** What a phone's sheet header shows when it has no title of its own: the close alone. */
function SheetBar() {
  return (
    <div className="border-line hidden h-[52px] flex-none items-center border-b phone:flex">
      <SheetClose />
    </div>
  );
}

function Header({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex-none px-[30px] pt-[26px] pb-1.5 phone:p-0">
      <div className="phone:border-line phone:flex phone:h-[52px] phone:items-center phone:border-b">
        <SheetClose />
        <DialogTitle className="phone:text-base phone:font-[650]">{title}</DialogTitle>
      </div>
      <DialogDescription
        id="batch-summary"
        className="text-tx2 mt-1.5 mb-0 leading-[1.5] phone:mt-0 phone:px-4 phone:pt-3.5 phone:pb-1 phone:text-[14.5px] phone:leading-[21px]"
      >
        {children}
      </DialogDescription>
    </div>
  );
}

/** The bottom row of a step: buttons side by side, on a phone a bar with the home indicator's room. */
const FOOTER =
  "flex flex-none items-center gap-2.5 px-[30px] pt-[18px] pb-6 phone:border-line2 phone:bg-panel phone:flex-wrap phone:gap-2 phone:border-t phone:px-3 phone:pt-2.5 phone:pb-[calc(0.625rem+env(safe-area-inset-bottom))]";
/** The footer's note: a line of its own above the buttons on a phone. */
const FOOTER_NOTE = "text-tx3 text-[12.5px] phone:w-full phone:px-1 phone:text-[13px]";

function Review({
  kind,
  state,
  rows,
  people,
  repos,
  chips,
  me,
  phone,
  details,
  onDetails,
  onToggle,
}: {
  kind: BatchKind;
  state: BatchState;
  rows: ReadonlyArray<BatchRow>;
  people: People;
  repos: ReadonlyArray<RepoInfo>;
  chips: ReadonlyMap<RepoKey, string>;
  me: string;
  phone: boolean;
  details: boolean;
  onDetails: (open: boolean) => void;
  onToggle: (pr: PrId) => void;
}) {
  const included = rows.filter((r) => r.included);
  // What is signed (or approved), per repo: one payload each (ADR 0007, 10).
  const batchRepos = reposOf(rows).map((key) => repoOf(repos, key) ?? null);
  const locked = state.step !== "review";
  // While the passphrase is asked (and signing after it) a phone shows titles only.
  const compact = phone && locked && state.step !== "approving";
  const groups = groupByRole(rows, people, kind);
  return (
    <>
      <Header
        title={`${kind === "approve" ? "Approve" : "Sign"} ${plural(included.length, "pull request")}`}
      >
        {summarySentence(rows, kind)}{" "}
        {outcomeSentence(
          included.map((r) => r.pr),
          people,
          "before",
        )}
      </Header>
      <div className="min-h-0 flex-1 overflow-auto px-[30px] pt-2.5 pb-2 phone:px-4">
        {groups.map((g) => (
          <section key={g.role ?? "none"} aria-label={g.title}>
            {/* While the passphrase is asked a phone has room for titles only: no headings. */}
            {!compact && (
              <div className="text-tx3 mt-4 pb-1.5 text-[12.5px] phone:fs-note phone:mt-3">
                {g.title}
              </div>
            )}
            {g.rows.map((r) =>
              compact ? (
                <CompactRow key={idOf(r.pr)} row={r} />
              ) : (
                <ReviewRow
                  key={idOf(r.pr)}
                  kind={kind}
                  row={r}
                  people={people}
                  chips={chips}
                  details={details && !locked}
                  disabled={locked}
                  onToggle={() => onToggle(idOf(r.pr))}
                />
              ),
            )}
          </section>
        ))}
        {state.step === "review" && (
          <div className="text-tx3 mt-3.5 mb-1 text-[13px]">
            <button
              type="button"
              aria-expanded={details}
              onClick={() => onDetails(!details)}
              className="hover:text-tx2 text-left phone:min-h-11"
            >
              {details ? "▾" : "▸"} Show exactly what is{" "}
              {kind === "approve" ? "approved" : "signed"}
            </button>
            {details &&
              (kind === "approve" ? (
                <div className="mt-2 leading-[1.55]">
                  <p className="m-0">
                    Each approval is a GitHub review of the head commit shown above, as you. Nothing
                    is signed: a new push, a rebase too, needs a new approval.
                  </p>
                  {batchRepos.map((r, i) => (
                    <p key={r?.key ?? i} className="text-tx2 m-0 mt-1.5 font-mono text-xs">
                      {r?.key ?? "?"} · review APPROVE · commit_id head · by {me}
                    </p>
                  ))}
                </div>
              ) : (
                <div className="mt-2 leading-[1.55]">
                  <p className="m-0">
                    {batchRepos.length > 1
                      ? "One signature per repository, each over its head commits and patch-ids shown above, all made with one unlock. "
                      : "One signature covers each head commit and patch-id shown above. "}
                    A clean rebase keeps it valid; a content change does not.
                  </p>
                  {batchRepos.map((r, i) => (
                    <p
                      key={r?.key ?? i}
                      className="text-tx2 m-0 mt-1.5 font-mono text-xs [overflow-wrap:anywhere]"
                    >
                      {r && r.github.host !== "github.com" ? `${r.github.host} · ` : ""}
                      repo {r?.name ?? "?"} · verdict approve · level review · reviewer {me}
                    </p>
                  ))}
                </div>
              ))}
          </div>
        )}
      </div>
    </>
  );
}

function Dot({ tone }: { tone: Outcome["tone"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-[7px] flex-none rounded-full",
        tone === "ok" ? "bg-ok" : tone === "wait" ? "bg-need" : "bg-line2",
      )}
    />
  );
}

function Mark({ children, tone }: { children: ReactNode; tone: "need" | "bad" }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] flex-none items-center rounded-[5px] px-1.5 text-[11.5px] whitespace-nowrap",
        tone === "need" ? "bg-need-bg text-need" : "bg-bad-bg text-bad",
      )}
    >
      {children}
    </span>
  );
}

function RowCheckbox({
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
    <label
      className="relative grid size-4 place-items-center phone:size-11"
      title={checked ? "Take out of the batch" : "Put back"}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
        className="peer border-line2 hover:border-tx3 checked:bg-need checked:border-need absolute inset-0 m-0 cursor-pointer appearance-none rounded-[5px] border-[1.5px] disabled:cursor-default phone:inset-auto phone:top-1/2 phone:left-1/2 phone:size-[22px] phone:-translate-x-1/2 phone:-translate-y-1/2 phone:rounded-[7px]"
      />
      <span className="pointer-events-none relative hidden h-1 w-2 translate-y-[-1px] -rotate-45 border-b-2 border-l-2 border-[#111] peer-checked:block phone:h-1.5 phone:w-3" />
    </label>
  );
}

/**
 * The row while the passphrase is asked, on a phone: title and role on one
 * line, so that as many titles as possible stay above the docked field.
 */
function CompactRow({ row }: { row: BatchRow }) {
  return (
    <div className="border-line flex min-h-[42px] items-center gap-3 border-t text-[14px]">
      <span className={cn("min-w-0 flex-1 truncate", !row.included && "opacity-50")}>
        {row.pr.title}
      </span>
      <span className="text-tx3 flex-none text-[13px]">
        {row.included ? roleShort(row.role) : "left out"}
      </span>
    </div>
  );
}

const CALL: Readonly<Record<BatchKind, string>> = {
  sign: "Signing is still your call.",
  approve: "Approving is still your call.",
};

function ReviewRow({
  kind,
  row,
  people,
  chips,
  details,
  disabled,
  onToggle,
}: {
  kind: BatchKind;
  row: BatchRow;
  people: People;
  chips: ReadonlyMap<RepoKey, string>;
  details: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { pr } = row;
  const now = useNow(60 * SECOND);
  // What a desktop shows as tooltips (head, patch-id, "never opened", "take out") a phone shows
  // when the row is tapped.
  const phone = useIsPhone();
  const [tapped, setTapped] = useState(false);
  const outcome: Outcome = !row.included
    ? {
        text:
          row.blocked === "no-ask" || row.blocked === "not-open"
            ? (whyNotNeeded(pr, people, now) ?? "no longer needs you")
            : row.blocked === "no-patch-id"
              ? "patch-id not known yet"
              : row.blocked === "other-kind"
                ? `${kind === "approve" ? "sign" : "approve"} it in a batch of its own`
                : "left out",
        tone: "none",
      }
    : outcomeOf(pr, people);
  const who = whoOf(pr, people);
  const head = (
    <>
      <div className="truncate phone:whitespace-normal phone:[overflow-wrap:anywhere]">
        {pr.title}
      </div>
      <div className="text-tx3 mt-0.5 flex min-w-0 items-center gap-[7px] overflow-hidden text-[12.5px] whitespace-nowrap phone:flex-wrap phone:gap-y-1 phone:overflow-visible phone:text-[13px]">
        <Avatar login={pr.prompter} people={people} />
        <span>{who === "you" ? "you" : who}</span>
        <RepoChip repo={pr.repo} chips={chips} />
        <DiffIndicator inline added={pr.diff.added} removed={pr.diff.removed} />
        <RiskBars risk={pr.risk} className={cn(pr.risk === 0 && "hidden")} />
        {row.notOpened && row.included && (
          <Mark tone="need">
            <span title={`You never opened its details here. ${CALL[kind]}`}>not opened</span>
          </Mark>
        )}
        {row.moved && <Mark tone="bad">moved since you looked</Mark>}
        {row.changed && !row.moved && <Mark tone="need">new head</Mark>}
      </div>
      {/* a phone's outcome sits under the meta, not at the right */}
      <div className="text-tx2 mt-1 hidden items-start gap-[7px] text-[13px] phone:flex">
        <span className="mt-[7px] flex-none">
          <Dot tone={outcome.tone} />
        </span>
        {outcome.text}
      </div>
    </>
  );
  return (
    <div className="border-line grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 border-t py-2.5 phone:grid-cols-[44px_minmax(0,1fr)] phone:items-start phone:gap-x-0 phone:py-1">
      <div className="phone:flex phone:h-11 phone:items-center phone:justify-center">
        <RowCheckbox
          checked={row.included}
          disabled={disabled || row.blocked !== null}
          label={row.included ? `Take #${pr.number} out of the batch` : `Put #${pr.number} back`}
          onChange={onToggle}
        />
      </div>
      <div className={cn("min-w-0 phone:py-2.5", !row.included && "opacity-50")}>
        {phone ? (
          <button
            type="button"
            aria-expanded={tapped}
            onClick={() => setTapped(!tapped)}
            className="block w-full min-w-0 text-left"
          >
            {head}
          </button>
        ) : (
          head
        )}
        {details && !tapped && (
          <div
            className="text-tx3 mt-0.5 font-mono text-xs phone:mt-1.5 phone:text-[12.5px]"
            title={
              kind === "approve"
                ? `head ${row.headSha}`
                : `head ${row.headSha}\npatch ${pr.patchId ?? "not known yet"}`
            }
          >
            #{pr.number} · {pr.base} · {row.headSha.slice(0, 7)}
            {kind === "sign" && ` · patch ${pr.patchId?.slice(0, 8) ?? "–"}`}
          </div>
        )}
        {tapped && !disabled && (
          <div className="text-tx3 mt-1.5 text-[13px] leading-[1.5]">
            <div className="font-mono text-[12.5px] [overflow-wrap:anywhere]">
              head {row.headSha}
              {kind === "sign" && (
                <>
                  <br />
                  patch {pr.patchId ?? "not known yet"}
                </>
              )}
            </div>
            {row.notOpened && row.included && (
              <p className="m-0 mt-1.5">You never opened its details here. {CALL[kind]}</p>
            )}
            {row.blocked === null && (
              <button
                type="button"
                onClick={onToggle}
                className="text-tx2 border-line2 mt-2 inline-flex min-h-11 items-center rounded-lg border px-3.5 text-[14px] font-medium"
              >
                {row.included ? "Take out of the batch" : "Put back"}
              </button>
            )}
          </div>
        )}
      </div>
      <span className="text-tx2 flex items-center gap-[7px] text-[13px] whitespace-nowrap phone:hidden">
        <Dot tone={outcome.tone} />
        {outcome.text}
      </span>
    </div>
  );
}

/**
 * A phone's docked unlock (m1 `a-unlock`): the passphrase field with the sign
 * button at its right and the chips under it, at the bottom of the sheet above
 * the on-screen keyboard (the sheet itself follows the visual viewport), the
 * titles still visible above. One form with the rest of the sheet: Enter ("go")
 * submits.
 */
function UnlockDock({
  passphrase,
  primary,
  error,
  busy,
  filled,
  count,
  once,
  keyboard,
  onFilled,
  onOnce,
}: {
  passphrase: RefObject<HTMLInputElement | null>;
  primary: RefObject<HTMLButtonElement | null>;
  error: string | null;
  busy: boolean;
  filled: boolean;
  count: number;
  once: boolean;
  keyboard: boolean;
  onFilled: (filled: boolean) => void;
  onOnce: (once: boolean) => void;
}) {
  return (
    <div
      className="bg-panel2 border-line2 flex-none border-t px-3 pt-2.5"
      // The home indicator's room is only wanted while no keyboard covers it.
      style={{ paddingBottom: keyboard ? 12 : "calc(12px + env(safe-area-inset-bottom))" }}
    >
      <label htmlFor="batch-passphrase" className="text-tx2 mb-1.5 block text-[13px]">
        Passphrase for your signing key
      </label>
      <PassphraseField
        id="batch-passphrase"
        inputRef={passphrase}
        error={error}
        disabled={busy}
        onFilled={onFilled}
        side={
          <button
            ref={primary}
            type="submit"
            className={cn(PRIMARY, "min-h-12 flex-none px-5 phone:flex-none")}
            disabled={!filled || busy}
          >
            {busy ? "Signing…" : `Sign ${count}`}
          </button>
        }
      />
      <StayUnlocked once={once} onOnce={onOnce} />
    </div>
  );
}

function ReviewFooter({
  kind,
  state,
  count,
  ready,
  signer,
  filled,
  primary,
  onCancel,
  onBack,
}: {
  kind: BatchKind;
  state: BatchState;
  count: number;
  ready: ReturnType<typeof readiness>["state"];
  signer: SignerState | null;
  filled: boolean;
  primary: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onBack: () => void;
}) {
  const now = useNow(SECOND);
  if (kind === "approve")
    return (
      <ApproveFooter
        approving={state.step === "approving"}
        count={count}
        primary={primary}
        onCancel={onCancel}
      />
    );
  const n = plural(count, "change");
  const unlockStep = state.step === "unlock";
  const signing = state.step === "signing" || (unlockStep && state.busy);
  const note = unlockStep
    ? "The key never leaves this machine."
    : signer?.state === "unlocked" && ready === "unlocked"
      ? `Signing is unlocked for ${countdown(signer.until, now)}.`
      : null;
  const label = signing
    ? "Signing…"
    : unlockStep || ready === "locked"
      ? `Unlock and sign ${count}`
      : `Sign ${n}`;
  const canSign =
    count > 0 && (unlockStep ? filled : ready === "unlocked" || ready === "locked") && !signing;
  return (
    <div className={FOOTER}>
      {note && <span className={FOOTER_NOTE}>{note}</span>}
      <span className="flex-1 phone:hidden" />
      <button
        type="button"
        className={GHOST}
        onClick={unlockStep ? onBack : onCancel}
        disabled={signing}
      >
        {unlockStep ? "Back" : "Cancel"}
      </button>
      <button ref={primary} type="submit" className={PRIMARY} disabled={!canSign}>
        {!unlockStep && ready === "locked" && !signing && <Lock className="size-[15px]" />}
        {label}
        {!signing && <Kbd className={KBD_ON_NEED}>↵</Kbd>}
      </button>
    </div>
  );
}

/** The review step's footer for a batch of approvals: no key, no unlock, one button. */
function ApproveFooter({
  approving,
  count,
  primary,
  onCancel,
}: {
  approving: boolean;
  count: number;
  primary: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
}) {
  return (
    <div className={FOOTER}>
      <span className={FOOTER_NOTE}>No key needed: it is your approval on GitHub.</span>
      <span className="flex-1 phone:hidden" />
      <button type="button" className={GHOST} onClick={onCancel} disabled={approving}>
        Cancel
      </button>
      <button ref={primary} type="submit" className={PRIMARY} disabled={count === 0 || approving}>
        {approving ? "Approving…" : count > 1 ? `Approve ${count} on GitHub` : "Approve on GitHub"}
        {!approving && <Kbd className={KBD_ON_NEED}>↵</Kbd>}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// signed (and approved)

function Signed({
  kind,
  shown,
  result,
  people,
  signer,
  primary,
  last,
  prs,
  chips,
  onOpenLast,
  onRetry,
}: {
  kind: BatchKind;
  /** Every PR of the attempt, as they were before. */
  shown: ReadonlyArray<PrView>;
  result: Pick<Extract<BatchState, { step: "signed" }>["result"], "posted" | "failed">;
  people: People;
  signer: SignerState | null;
  primary: RefObject<HTMLButtonElement | null>;
  /** A phone's "Open the last one": the one PR that still needs me, when exactly one does. */
  last: PrId | null;
  prs: ReadonlyArray<PrView>;
  chips: ReadonlyMap<RepoKey, string>;
  onOpenLast?: (pr: PrId) => void;
  onRetry: (failed: ReadonlyArray<PrRef>) => void;
}) {
  const now = useNow(SECOND);
  const approved = kind === "approve";
  const of = (pr: PrView) => (x: PrRef) => x.pr === pr.number && sameRepo(x.repo, pr.repo);
  const posted = shown.filter((p) => result.posted.some(of(p)));
  const failed = result.failed;
  const title =
    failed.length === 0
      ? `${plural(posted.length, "pull request")} ${approved ? "approved" : "signed"}`
      : posted.length === 0
        ? approved
          ? "Not approved"
          : "Signed, but not posted yet"
        : `${posted.length} of ${shown.length} pull requests ${approved ? "approved" : "posted"}`;
  const note = approved
    ? "Approved on GitHub, as you. No key was used."
    : signer?.state === "unlocked"
      ? `Signing stays unlocked for ${countdown(signer.until, now)}.`
      : "Signing is locked again.";
  const lastPr = last === null ? null : (findPr(prs, last) ?? null);
  return (
    <>
      <SheetBar />
      <div className="flex-none px-[30px] pt-[26px] pb-1.5 phone:px-4 phone:pt-4 phone:pb-0">
        <div
          className={cn(
            "mb-3.5 grid size-11 place-items-center rounded-full text-[22px]",
            failed.length ? "bg-need-bg text-need" : "bg-ok-bg text-ok",
          )}
          aria-hidden
        >
          {failed.length ? "!" : "✓"}
        </div>
        <DialogTitle className="phone:text-xl phone:font-[650]">{title}</DialogTitle>
        <DialogDescription
          id="batch-summary"
          className="text-tx2 mt-1.5 mb-0 leading-[1.5] phone:text-[14.5px] phone:leading-[21px]"
        >
          {outcomeSentence(posted, people, "after")}
          {failed.length > 0 &&
            (approved
              ? ` GitHub did not take the approval on ${plural(failed.length, "pull request")}; nothing was approved there.`
              : ` The signature is valid; posting the comment failed on ${plural(failed.length, "pull request")}.`)}
        </DialogDescription>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-[30px] pt-2.5 pb-2 phone:px-4 phone:pt-3">
        {shown.map((pr) => {
          const fail = failed.find(of(pr));
          const url = result.posted.find(of(pr))?.url;
          const outcome = outcomeOf(pr, people, "after");
          return (
            <div
              key={idOf(pr)}
              className="border-line grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-3 border-t py-2.5 phone:grid-cols-[24px_minmax(0,1fr)] phone:items-start phone:gap-x-0 phone:gap-y-0.5"
            >
              <span className={cn("font-bold", fail ? "text-bad" : "text-ok")} aria-hidden>
                {fail ? "✕" : "✓"}
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate phone:whitespace-normal phone:[overflow-wrap:anywhere]">
                    {pr.title}
                  </span>
                  <RepoChip repo={pr.repo} chips={chips} />
                </div>
                {fail && <div className="text-bad mt-0.5 text-[12.5px]">{fail.message}</div>}
              </div>
              {fail ? (
                <span className="text-tx3 text-[13px] whitespace-nowrap phone:col-start-2">
                  {approved ? "not approved" : "not posted"}
                </span>
              ) : (
                <a
                  href={url || pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-tx2 hover:text-tx flex items-center gap-[7px] text-[13px] whitespace-nowrap phone:col-start-2 phone:min-h-6"
                  title={approved ? "The approval on GitHub" : "The nod comment on GitHub"}
                >
                  <Dot tone={outcome.tone} />
                  {outcome.text}
                </a>
              )}
            </div>
          );
        })}
        {lastPr && (
          <div className="border-line2 bg-panel2 mt-4 rounded-xl border p-3.5">
            <span className="text-tx3 text-[11.5px] font-semibold tracking-[0.05em] uppercase">
              One left that needs you
            </span>
            <div className="mt-1 mb-1.5 text-[15px] leading-[21px] [overflow-wrap:anywhere]">
              {lastPr.title}
            </div>
            <div className="text-tx3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              <Avatar login={lastPr.prompter} people={people} />
              <span>{ago(lastPr.openedAt, now)}</span>
              <DiffIndicator inline added={lastPr.diff.added} removed={lastPr.diff.removed} />
              <RiskBars risk={lastPr.risk} className={cn(lastPr.risk === 0 && "hidden")} />
            </div>
          </div>
        )}
      </div>
      <div className={FOOTER}>
        <span className={FOOTER_NOTE}>{note}</span>
        <span className="flex-1 phone:hidden" />
        {failed.length > 0 && (
          <button type="button" className={GHOST} onClick={() => onRetry(failed)}>
            Retry {plural(failed.length, approved ? "approval" : "post")}
          </button>
        )}
        {lastPr && onOpenLast ? (
          <>
            <button type="submit" className={cn(GHOST, "border-line2 phone:flex-none")}>
              Done
            </button>
            <button
              ref={primary}
              type="button"
              className={PRIMARY}
              onClick={() => onOpenLast(idOf(lastPr))}
            >
              Open the last one
            </button>
          </>
        ) : (
          <button ref={primary} type="submit" className={PRIMARY}>
            Done <Kbd className={KBD_ON_NEED}>↵</Kbd>
          </button>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// stale: nothing was signed

function Stale({
  kind,
  state,
  prs,
  chips,
  rows,
  primary,
  onCancel,
}: {
  kind: BatchKind;
  state: Extract<BatchState, { step: "stale" }>;
  prs: ReadonlyArray<PrView>;
  chips: ReadonlyMap<RepoKey, string>;
  rows: ReadonlyArray<BatchRow>;
  primary: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
}) {
  const { stale } = state;
  const unchanged = rows.filter(
    (r) => r.included && !stale.some((s) => s.pr === r.pr.number && sameRepo(s.repo, r.pr.repo)),
  );
  return (
    <>
      <Header title={`Nothing was ${kind === "approve" ? "approved" : "signed"}`}>
        {stale.length === 1
          ? "One pull request"
          : `${capital(countWord(stale.length))} pull requests`}{" "}
        changed since you looked. {kind === "approve" ? "An approval covers" : "A nod covers"}{" "}
        exactly the commits you saw, so look at {stale.length === 1 ? "it" : "them"} again, then{" "}
        {kind === "approve" ? "approve" : "sign"}.
      </Header>
      <div className="min-h-0 flex-1 overflow-auto px-[30px] pt-2.5 pb-2 phone:px-4">
        <div className="text-tx3 mt-4 pb-1.5 text-[12.5px]">Changed since you looked</div>
        {stale.map((s) => {
          const pr = findPr(prs, prId(s.repo, s.pr)) ?? null;
          return (
            <div
              key={prId(s.repo, s.pr)}
              className="border-line grid grid-cols-[20px_minmax(0,1fr)] items-center gap-3 border-t py-2.5"
            >
              <span className="text-need font-bold" aria-hidden>
                !
              </span>
              <div className="min-w-0">
                <div className="truncate">{pr?.title ?? `#${s.pr}`}</div>
                <div className="text-tx3 mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px]">
                  <RepoChip repo={s.repo} chips={chips} />#{s.pr} ·{" "}
                  <span className="font-mono text-xs">{staleText(s, null)}</span>
                  {pr && ` · ${pr.lastActivity.text}`}
                </div>
              </div>
            </div>
          );
        })}
        {unchanged.length > 0 && (
          <p className="text-tx3 mt-3 mb-0 text-[12.5px]">
            The other {plural(unchanged.length, "pull request")} did not change and{" "}
            {unchanged.length === 1 ? "stays" : "stay"} in the batch as{" "}
            {unchanged.length === 1 ? "it was" : "they were"}.
          </p>
        )}
      </div>
      <div className={FOOTER}>
        <span className="flex-1 phone:hidden" />
        <button type="button" className={GHOST} onClick={onCancel}>
          Cancel
        </button>
        <button ref={primary} type="submit" className={PRIMARY}>
          Review again <Kbd className={KBD_ON_NEED}>↵</Kbd>
        </button>
      </div>
    </>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// error: nothing was signed, and why

function ErrorStep({
  kind,
  state,
  primary,
  onBack,
}: {
  kind: BatchKind;
  state: Extract<BatchState, { step: "error" }>;
  primary: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
}) {
  const { failure } = state;
  // The connection dropped, or went quiet, after the request went out: the
  // server may have signed and posted. "Nothing was signed" would be a guess.
  const uncertain = failure.uncertain === true;
  const explained =
    failure.code === "bad-key-file"
      ? cannotSignText({ state: "bad-key-file" })
      : failure.code === "no-key"
        ? cannotSignText({ state: "no-key" })
        : null;
  return (
    <>
      <Header
        title={
          failure.code === "bad-key-file"
            ? "The key cannot be unlocked"
            : uncertain
              ? `Not sure whether it was ${kind === "approve" ? "approved" : "signed"}`
              : `Nothing was ${kind === "approve" ? "approved" : "signed"}`
        }
      >
        {explained ??
          (uncertain
            ? kind === "approve"
              ? "The connection to nod serve dropped while it was approving, so the approvals may be on GitHub already. Wait for it to reconnect, then look at the PRs before you approve again."
              : "The connection to nod serve dropped while it was signing, so the nod may be posted already. Wait for it to reconnect, then look for the nod on the PRs before you sign again."
            : failure.message)}
      </Header>
      <div className={FOOTER}>
        <span className="flex-1 phone:hidden" />
        {!explained && !uncertain && (
          <button type="button" className={GHOST} onClick={onBack}>
            Back to the batch
          </button>
        )}
        <button ref={primary} type="submit" className={PRIMARY}>
          Close <Kbd className={KBD_ON_NEED}>↵</Kbd>
        </button>
      </div>
    </>
  );
}
