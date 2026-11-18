/**
 * Unlocking the signing key, in the two places it happens: inside the batch
 * dialog (r2 `13`) and in the lock chip's popover. The passphrase lives only
 * in the input: read on submit, cleared at once, sent in the one `unlock`
 * request, never kept in React state and never logged.
 *
 * Also the lock chip itself (r3 top bar): locked, or unlocked with a live
 * countdown to the auto-lock; quiet "No key" and "Key pending" states.
 */

import { Lock, LockOpen } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";

import { DEFAULT_UNLOCK_MINUTES, type SignerState } from "../../shared/protocol";
import { SECOND, useNow } from "@/hooks/use-clock";
import type { Actions } from "@/hooks/use-connection";
import { readiness, type Failure, type Readiness } from "@/lib/batch";
import { countdown } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** Reads the passphrase out of the input and clears it: the only way it leaves the field. */
export function takePassphrase(ref: RefObject<HTMLInputElement | null>): string {
  const input = ref.current;
  if (!input) return "";
  const value = input.value;
  input.value = "";
  return value;
}

/** What a failed unlock says, calmly, under the field. */
export function unlockErrorText(failure: Failure): string {
  if (failure.code === "bad-passphrase")
    return "That passphrase does not unlock the key. Try again.";
  return failure.message;
}

export function PassphraseField({
  inputRef,
  error,
  disabled,
  onFilled,
  id,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  error: string | null;
  disabled: boolean;
  /** Whether the field has something in it (for the button), never what. */
  onFilled: (filled: boolean) => void;
  id: string;
}) {
  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="password"
        autoComplete="current-password"
        spellCheck={false}
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onInput={(e) => onFilled(e.currentTarget.value.length > 0)}
        className={cn(
          "bg-panel text-tx h-[42px] w-full rounded-lg border px-3 text-lg tracking-[3px] outline-none",
          error
            ? "border-bad shadow-[0_0_0_3px_var(--bad-bg)]"
            : "border-need shadow-[0_0_0_3px_var(--need-bg)]",
        )}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-bad m-0 mt-2 text-[12.5px]">
          {error}
        </p>
      )}
    </>
  );
}

/** The chips under the field: the 15-minute window, or this one batch (`once`). */
export function StayUnlocked({ once, onOnce }: { once: boolean; onOnce: (once: boolean) => void }) {
  const chip = (on: boolean) =>
    cn(
      "rounded-md border px-2.5 py-1 text-[13px]",
      on ? "border-need text-need bg-need-bg" : "border-line text-tx2 hover:text-tx",
    );
  return (
    <fieldset className="text-tx3 m-0 mt-3 flex items-center gap-1.5 border-0 p-0 text-[13px]">
      Stay unlocked
      <button
        type="button"
        aria-pressed={!once}
        className={chip(!once)}
        onClick={() => onOnce(false)}
      >
        for {DEFAULT_UNLOCK_MINUTES} minutes
      </button>
      <button type="button" aria-pressed={once} className={chip(once)} onClick={() => onOnce(true)}>
        just this once
      </button>
    </fieldset>
  );
}

/**
 * Why signing is not possible, and what to do instead of a passphrase
 * field: no key yet, a key waiting for its enrolment PR, a key the repo does
 * not know, a key file nod cannot read.
 */
export function cannotSignText(state: Readiness | { state: "bad-key-file" }): ReactNode {
  switch (state.state) {
    case "no-key":
      return (
        <>
          <b className="text-tx font-semibold">You have no signing key yet.</b> Create one in a
          terminal with <code className="font-mono text-xs">nod key create</code>, then come back:
          everything you picked stays here.
        </>
      );
    case "pending":
      return (
        <>
          <b className="text-tx font-semibold">Your key is pending.</b> It is waiting for{" "}
          {state.pr ? `#${state.pr}` : "its enrolment pull request"} to merge; you can read
          everything and sign nothing.
        </>
      );
    case "not-enrolled":
      return (
        <>
          <b className="text-tx font-semibold">Your key is not enrolled in this repository.</b> A
          teammate merges the one-line pull request that adds it to{" "}
          <code className="font-mono text-xs">.nod/allowed_signers</code>; until then you can read
          everything and sign nothing.
        </>
      );
    case "bad-key-file":
      return (
        <>
          <b className="text-tx font-semibold">nod cannot read your key file.</b> It is damaged,
          from a newer nod, or changed while <code className="font-mono text-xs">nod serve</code>{" "}
          ran. Nothing was signed. Run <code className="font-mono text-xs">nod key show</code> in a
          terminal to see what is wrong.
        </>
      );
    default:
      return null;
  }
}

export function failureOf(error: unknown): Failure {
  const e = error as { code?: Failure["code"]; message?: string };
  return { code: e.code ?? "internal", message: e.message ?? "Something went wrong." };
}

const CHIP =
  "border-line2 text-tx2 flex h-[30px] items-center gap-2 rounded-lg border px-2.5 text-[13px]";

/**
 * The lock chip. Unlocked: a countdown, and a click locks. Locked: a click
 * opens a small popover to unlock (the same rules as in the dialog). No key
 * or a pending key: quiet, with a popover that says what to do.
 */
export function LockChip({ signer, actions }: { signer: SignerState | null; actions: Actions }) {
  const now = useNow(SECOND);
  const [open, setOpen] = useState(false);
  const ready = readiness(signer);

  if (signer?.state === "unlocked" && ready.state === "unlocked")
    return (
      <button
        type="button"
        onClick={() => void actions.lock().catch(() => {})}
        className={cn(CHIP, "border-ok bg-ok-bg text-ok hover:bg-[#4cc38a26]")}
        title={
          signer.once
            ? "Unlocked for one batch. Click to lock now."
            : "Signing locks on its own when this ends. Click to lock now."
        }
        aria-label={`Signing unlocked, ${countdown(signer.until, now)} left. Lock now`}
      >
        <LockOpen className="size-3.5" />
        <span>Unlocked</span>
        <b className="font-mono font-medium tabular-nums">{countdown(signer.until, now)}</b>
        <span className="text-tx2 border-line2 border-l pl-2">Lock</span>
      </button>
    );

  const label =
    ready.state === "no-key"
      ? "No key"
      : ready.state === "pending"
        ? `Key pending${ready.pr ? ` #${ready.pr}` : ""}`
        : ready.state === "not-enrolled"
          ? "Key not enrolled"
          : "Locked";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(CHIP, "hover:text-tx", ready.state !== "locked" && "text-tx3 border-line")}
        title={ready.state === "locked" ? "Signing is locked. Click to unlock." : undefined}
      >
        <Lock className="size-3.5" />
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-[380px] p-4">
        {ready.state === "locked" ? (
          <UnlockForm actions={actions} onDone={() => setOpen(false)} />
        ) : (
          <p className="text-tx2 m-0 text-[13px] leading-[1.55]">{cannotSignText(ready)}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

function UnlockForm({ actions, onDone }: { actions: Actions; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const passphrase = takePassphrase(ref);
    setFilled(false);
    if (!passphrase) return;
    setBusy(true);
    setError(null);
    try {
      await actions.unlock(passphrase, { minutes: DEFAULT_UNLOCK_MINUTES });
      onDone();
    } catch (err) {
      setError(failureOf(err));
      setBusy(false);
      requestAnimationFrame(() => ref.current?.focus());
    }
  };
  if (error?.code === "bad-key-file")
    return (
      <p className="text-tx2 m-0 text-[13px] leading-[1.55]">
        {cannotSignText({ state: "bad-key-file" })}
      </p>
    );
  return (
    <form onSubmit={(e) => void submit(e)}>
      <label htmlFor="chip-passphrase" className="text-tx3 mb-2 block text-[12.5px]">
        Passphrase for your signing key
      </label>
      <PassphraseField
        id="chip-passphrase"
        inputRef={ref}
        error={error ? unlockErrorText(error) : null}
        disabled={busy}
        onFilled={setFilled}
      />
      <div className="mt-3 flex items-center gap-2.5">
        <span className="text-tx3 text-xs whitespace-nowrap">
          The key never leaves this machine.
        </span>
        <span className="flex-1" />
        <button
          type="submit"
          disabled={!filled || busy}
          className="bg-need border-need text-on-need h-8 rounded-lg border px-3.5 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50"
        >
          {busy ? "Unlocking…" : `Unlock for ${DEFAULT_UNLOCK_MINUTES} min`}
        </button>
      </div>
    </form>
  );
}
