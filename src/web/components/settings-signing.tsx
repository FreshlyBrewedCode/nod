/**
 * Settings → Signing: my one key (where it is, its fingerprint, its public
 * line), its lock (the lock chip itself, with its unlock popover, and how
 * the window works), and its enrolment in each repository with the next
 * action there. Creating a key and the setup PR stay on the ladder's
 * Signing step (`components/onboarding.tsx`), where they are built: this
 * section leads there instead of copying them.
 */

import type { ReactNode } from "react";

import type { Account, RepoInfo, RepoKey, SignerState } from "../../shared/protocol";
import { DEFAULT_UNLOCK_MINUTES, MAX_UNLOCK_MINUTES } from "../../shared/protocol";
import type { Actions } from "@/hooks/use-connection";
import { SECOND, useNow } from "@/hooks/use-clock";
import type { Rung } from "@/lib/onboarding";
import { shortFingerprint, shortPath, signerLine } from "@/lib/onboarding";
import { bestEnrolment } from "@/lib/repos";
import { keyWords } from "@/lib/settings";
import { countdown } from "@/lib/time";
import { cn } from "@/lib/utils";
import { SMALL_BUTTON } from "./add-repo";
import { ErrorNote, PRIMARY, useRequest } from "./onboarding";
import { CARD, Code, Fact, Facts, H2, Heading, LINE, LongCode, NOTE, QUIET } from "./settings-bits";
import { LockChip } from "./unlock";

export interface SigningSectionProps {
  readonly me: Account | null;
  readonly repos: ReadonlyArray<RepoInfo>;
  readonly signer: SignerState | null;
  readonly actions: Actions;
  readonly onSetup: (repo: RepoKey, step?: Rung) => void;
  /** This page is the other device's (its unlock window is its own). */
  readonly otherSide: boolean;
}

export function SigningSection(props: SigningSectionProps) {
  const { me, repos, signer, actions, onSetup, otherSide } = props;
  const now = useNow(SECOND);
  const first = repos[0];
  return (
    <>
      <Heading title="Signing">
        A nod is signed with one SSH key that lives encrypted on this machine and is unlocked only
        for a while. Each repository decides on its own whether it trusts the key.
      </Heading>

      <section aria-labelledby="key-title" className={CARD}>
        <h2 id="key-title" className={H2}>
          Your key
        </h2>
        {!signer ? (
          <p className={LINE}>Waiting for nod serve…</p>
        ) : signer.state === "no-key" ? (
          <>
            <p className={cn(LINE, "mb-3")}>
              You have no signing key yet. Without one you approve on GitHub, as before; a key adds
              nods, which can attest your own agent’s pull requests.
            </p>
            {first && (
              <button
                type="button"
                className={PRIMARY}
                onClick={() => onSetup(first.key, "signing")}
              >
                Create a key
              </button>
            )}
            <p className={cn(NOTE, "mt-2.5")}>
              On the ladder’s Signing step; or in a terminal, <Code>nod key create</Code>.
            </p>
          </>
        ) : (
          <>
            <Facts>
              <Fact label="Fingerprint">
                <span className="font-mono fs-code">
                  {shortFingerprint(signer.key.fingerprint)}
                </span>
              </Fact>
              <Fact label="Kept in">
                <LongCode>{shortPath(signer.key.location)}</LongCode>, encrypted with your
                passphrase
              </Fact>
            </Facts>
            <span className="bg-bg border-line text-tx2 mt-2 block rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-[1.5] break-all">
              {signerLine(me?.login ?? "you", signer.key.publicKey)}
            </span>
            <p className={cn(NOTE, "mt-2")}>
              This line is what a repository’s <Code>.nod/allowed_signers</Code> holds. To replace
              the key: <Code>nod key create --replace</Code> in a terminal.
            </p>
          </>
        )}
      </section>

      {signer && signer.state !== "no-key" && (
        <section aria-labelledby="lock-title" className={CARD}>
          <div className="flex items-start gap-3 phone:flex-col phone:gap-2">
            <div className="min-w-0 flex-1">
              <h2 id="lock-title" className={H2}>
                The lock
              </h2>
              <p className={LINE}>
                {signer.state === "unlocked"
                  ? `Unlocked${signer.once ? " for one batch" : ""}: it locks on its own in ${countdown(signer.until, now)}.`
                  : "Locked: nothing can be signed until you unlock it with your passphrase."}
              </p>
            </div>
            <LockChip signer={signer} enrolment={bestEnrolment(repos)} actions={actions} />
          </div>
          <p className={cn(NOTE, "mt-2.5")}>
            Unlocking keeps the key in <Code>nod serve</Code>’s memory for {DEFAULT_UNLOCK_MINUTES}{" "}
            minutes (at most {MAX_UNLOCK_MINUTES}), or for one batch; then it is forgotten.{" "}
            {otherSide
              ? "This device has its own window: an unlock here does not unlock the machine’s page, nor the other way round."
              : "Another device has its own window: an unlock here does not unlock it."}
          </p>
        </section>
      )}

      <section aria-labelledby="enrol-title" className={CARD}>
        <h2 id="enrol-title" className={H2}>
          Where your key signs
        </h2>
        <p className={cn(LINE, "mb-2")}>
          Each repository trusts the keys in its <Code>.nod/allowed_signers</Code>. Adding yours is
          a one-line pull request a teammate signs off.
        </p>
        {repos.length === 0 ? (
          <p className={NOTE}>No repository yet.</p>
        ) : (
          <ul
            aria-label="Your key in each repository"
            className="border-line divide-line m-0 list-none divide-y overflow-hidden rounded-[10px] border p-0"
          >
            {repos.map((repo) => (
              <EnrolRow
                key={repo.key}
                repo={repo}
                signer={signer}
                actions={actions}
                onSetup={onSetup}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function EnrolRow({
  repo,
  signer,
  actions,
  onSetup,
}: {
  repo: RepoInfo;
  signer: SignerState | null;
  actions: Actions;
  onSetup: (repo: RepoKey, step?: Rung) => void;
}) {
  const open = useRequest();
  const hasKey = signer !== null && signer.state !== "no-key";
  const enrolment = repo.enrolment;
  // Not set up yet: the key goes in with the setup PR, on the ladder.
  const viaSetup = repo.setup.state !== "ready";
  let action: ReactNode = null;
  if (hasKey && enrolment?.state === "pending" && enrolment.pr)
    action = (
      <a href={enrolment.pr.url} target="_blank" rel="noreferrer" className={SMALL_BUTTON}>
        Open #{enrolment.pr.number} ↗
      </a>
    );
  else if (hasKey && enrolment?.state !== "active" && enrolment?.state !== "pending")
    action = viaSetup ? (
      <button type="button" className={QUIET} onClick={() => onSetup(repo.key, "signing")}>
        With the setup PR ›
      </button>
    ) : (
      <button
        type="button"
        className={SMALL_BUTTON}
        disabled={open.busy !== null}
        onClick={() =>
          void open.run("enrol", () => actions.request("open-enrol-pr", { repo: repo.key }))
        }
      >
        {open.busy ? "Opening…" : "Open the enrolment PR"}
      </button>
    );
  return (
    <li className="px-3.5 py-3" aria-label={repo.key}>
      <div className="flex items-center gap-3 phone:flex-col phone:items-stretch phone:gap-1.5">
        <div className="min-w-0 flex-1">
          <b className="block font-mono text-[13px] font-medium [overflow-wrap:anywhere]">
            {repo.key}
          </b>
          <span
            className={cn(
              "fs-note block leading-[1.55]",
              enrolment?.state === "active" ? "text-ok" : "text-tx3",
            )}
          >
            {keyWords(signer, enrolment)}
          </span>
        </div>
        {action}
      </div>
      <ErrorNote failure={open.failure} lead="Could not open the enrolment PR." />
    </li>
  );
}
