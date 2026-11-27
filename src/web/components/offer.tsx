/**
 * The offer card above the list: the next step of the ladder for this repo
 * and me (ADR 0006), calm and dismissible, one at a time (`cardOf` in
 * `lib/onboarding.ts`). It replaces the old "no signing key yet" note: a
 * step to take leads to the setup page, a step that waits on its pull
 * request links to it. "Not now" puts it away for this browser.
 *
 * It takes one repo's setup and my signer, not the app's state, so a page
 * for many repos (epic C) can show one per repo.
 */

import type { SetupStatus, SignerState } from "../../shared/protocol";
import { keyStateOf, offerWords, type Offer } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { CommandBox, ENFORCE_COMMAND } from "./onboarding";

const BUTTON =
  "border-line2 bg-panel2 text-tx hover:border-tx3 inline-flex h-8 items-center justify-center rounded-lg border px-3.5 text-[13px] font-semibold whitespace-nowrap phone:h-11";
const QUIET =
  "text-tx3 hover:text-tx2 inline-flex h-8 items-center justify-center px-2 text-[13px] phone:h-11";

const Mono = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono fs-code">{children}</code>
);

export function OfferCard({
  offer,
  setup,
  signer,
  onTake,
  onDismiss,
  className,
}: {
  offer: Offer;
  /** The repo's setup. */
  setup: SetupStatus;
  /** My key and its enrolment in the repo. */
  signer: SignerState;
  /** Opens the setup page on the offer's step. */
  onTake: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  const key = keyStateOf(signer);
  const words = offerWords(offer, key);
  const repo = setup.repo ?? "this repository";
  const pr = offer.pr;
  // My key rides in the setup PR when I opened it with one.
  const adds =
    key === "pending"
      ? "It adds the policy, the verifier and your public key"
      : "It adds the policy and the verifier";

  const body =
    offer.rung === "shared-policy" ? (
      offer.phase === "offer" ? (
        <>
          Today only your nod sorts these pull requests. One setup PR adds a policy and a verifier
          to {repo}: then every pull request is classified the same way for everyone, and its{" "}
          <Mono>nod</Mono> check never blocks a merge.
        </>
      ) : (
        <>
          {adds}, and merges the usual way. Once it has, every pull request is classified the same
          way for everyone. Nothing is gated.
        </>
      )
    ) : offer.rung === "signing" ? (
      offer.phase === "offer" ? (
        key === "none" ? (
          <>
            GitHub does not let you approve your own pull request; a nod can attest it. With a
            signing key enrolled in {repo} you nod your agents’ work and your teammates’. Approving
            on GitHub keeps working without one.
          </>
        ) : (
          <>
            Your signing key is on this machine, not enrolled in {repo} yet. A one-line pull request
            adds it, and a teammate nods it. Until then you approve on GitHub.
          </>
        )
      ) : (
        <>
          {pr ? `Pull request #${pr.number}` : "A pull request"} adds it to{" "}
          <Mono>.nod/allowed_signers</Mono>, and a teammate has to nod it. Until it merges you
          approve on GitHub as before.
        </>
      )
    ) : (
      <>
        The <Mono>nod</Mono> check says what each pull request needs and blocks nothing yet.
        Requiring it is one command, for an admin, in a clone of the repository:
      </>
    );

  return (
    <section
      aria-label={words.title}
      className={cn(
        "border-line2 bg-panel mb-[26px] rounded-xl border px-[18px] py-4 phone:mx-4 phone:mt-4 phone:mb-0 phone:px-4",
        className,
      )}
    >
      <p className="text-tx3 m-0 mb-1 text-[11px] font-semibold tracking-[0.08em] uppercase">
        {offer.phase === "waiting" ? "On its way" : "Next step · optional"}
      </p>
      <h3 className="m-0 mb-1 text-[15px] font-bold">{words.title}</h3>
      <p className="text-tx2 m-0 text-[13px] leading-[1.55]">{body}</p>
      {offer.rung === "enforced" && (
        <div className="mt-3 max-w-[420px] phone:max-w-none">
          <CommandBox command={ENFORCE_COMMAND} />
        </div>
      )}
      <div className="mt-3.5 flex flex-wrap items-center gap-2 phone:gap-1">
        {words.action ? (
          <button type="button" className={BUTTON} onClick={onTake}>
            {words.action}
          </button>
        ) : pr ? (
          <a href={pr.url} target="_blank" rel="noreferrer" className={BUTTON}>
            Open #{pr.number} ↗
          </a>
        ) : null}
        {!words.action && (
          <button type="button" className={QUIET} onClick={onTake}>
            Details
          </button>
        )}
        <button type="button" className={QUIET} onClick={onDismiss}>
          Not now
        </button>
      </div>
    </section>
  );
}
