/**
 * Deep links on another device (ADR 0005 §7, `lib/forward.ts`):
 *
 * - `ForwardConfirm`, the page `#/forward?to=…` opens on the hosted UI: it
 *   names the host in large type, says what remembering it means, and its
 *   default is not to remember.
 * - `ForwardOffer`, on a deep link's landing when this browser is not paired
 *   and remembers a host: "Open on <host>", one tap per link, and a way to
 *   forget the host.
 * - `PasteLink`, in a home-screen app that is not paired: it has no address
 *   bar, so the device link is pasted.
 */

import { useState, type ReactNode } from "react";

import { useArmed } from "@/hooks/use-armed";
import type { ForwardState } from "@/hooks/use-forward";
import { pastedHostLink } from "@/lib/connection";
import { confirmOf, forwardUrl, hostOf, hostParts, type Offer } from "@/lib/forward";
import { cn } from "@/lib/utils";
import { Footer, GHOST, PRIMARY } from "./onboarding";
import { Logo, TopBarShell } from "./top-bar";

/** A secondary button with a visible edge: the choice that is not the default. */
const OUTLINE = cn(
  GHOST,
  "border-line2 hover:border-tx3 disabled:hover:border-line2 disabled:hover:text-tx2",
);
const LINK = "underline underline-offset-2 hover:text-tx2";

/**
 * A host with line breaks after its dots and before its port, never inside a
 * label: a hyphen is the only other place a browser breaks a name, so it
 * stays glued to the character after it (`hostParts`). Only a label wider
 * than the whole line breaks, anywhere, so nothing is cut. All of it stays
 * inline text, so it reads and copies as the host.
 */
export function Host({ origin }: { origin: string }) {
  return (
    <span className="[overflow-wrap:anywhere]">
      {hostParts(hostOf(origin)).map((label, i) => (
        <span key={i}>
          {i > 0 && <wbr />}
          {label.map((piece, j) =>
            piece.glued ? (
              <span key={j} className="whitespace-nowrap">
                {piece.text}
              </span>
            ) : (
              piece.text
            ),
          )}
        </span>
      ))}
    </span>
  );
}

/** The host, spelled out whole, in a size nobody skims past. */
export function HostName({ origin, className }: { origin: string; className?: string }) {
  return (
    <div
      className={cn(
        "bg-bg border-line2 text-tx rounded-lg border px-3.5 py-3 font-mono text-[17px] leading-[1.35] font-semibold phone:text-[16px]",
        className,
      )}
    >
      <span className="text-tx3 font-normal">https://</span>
      <wbr />
      <Host origin={origin} />
    </div>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="pt-safe pb-safe px-safe flex min-h-full flex-col">
      <TopBarShell>
        <Logo />
      </TopBarShell>
      <main
        className="mx-auto mt-24 w-full max-w-[560px] px-6 pb-10 phone:mt-6 phone:px-4"
        aria-live="polite"
      >
        <div className="border-line bg-panel rounded-2xl border px-9 py-8 phone:px-5 phone:py-6">
          {children}
        </div>
      </main>
    </div>
  );
}

const H1 = "m-0 mb-3 text-[22px] font-bold tracking-[-0.01em]";
const P = "text-tx2 m-0 mt-3";

const since = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * `#/forward?to=…` on a page that forwards. Nothing is stored before the
 * user taps "Remember"; "Don't remember" is the default (focused, the
 * prominent button), and leaving stores nothing either.
 *
 * Mounted with `key={to}` (`app.tsx`): a fragment change that names another
 * host is a new page, with nothing tapped yet. "Remember" takes a tap only
 * once the page has been visible for a second (`useArmed`). The page after
 * it shows the host read back from storage, never the fragment's.
 */
export function ForwardConfirm({
  given,
  forward,
  paired,
  onLeave,
}: {
  /** The route's `to`, unchecked. */
  given: string | null;
  forward: ForwardState;
  /** This browser is paired here (a desktop): links keep opening here. */
  paired: boolean;
  /** Back to the list, the route replaced. */
  onLeave: () => void;
}) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);
  const armed = useArmed();
  const confirm = confirmOf(given, forward.forward, window.location);
  /** What this browser remembers now: the finished page shows this, and only this. */
  const stored = forward.forward;
  const pairedNote = paired && (
    <p className={P}>
      This browser is also paired with <code className="font-mono">nod serve</code> on this machine.
      While it is, links keep opening here; the address is used only without a pairing.
    </p>
  );

  if (confirm.kind === "not-here" || confirm.kind === "invalid")
    return (
      <Page>
        <h1 className={H1}>This link names no address nod can open</h1>
        {confirm.kind === "invalid" && confirm.given !== null && (
          <div className="bg-bg border-line text-tx3 rounded-lg border px-3.5 py-2.5 font-mono text-[13px] break-all">
            {confirm.given}
          </div>
        )}
        <p className={P}>
          {confirm.kind === "not-here"
            ? "This page is a nod of its own; it does not forward links anywhere."
            : "nod opens links only on an https address with a host name and an optional port, like the one tailscale serve gives your machine: no IP address, no loopback, no path."}{" "}
          Nothing was remembered.
        </p>
        <Footer>
          <button type="button" className={PRIMARY} onClick={onLeave}>
            Go to nod
          </button>
        </Footer>
      </Page>
    );

  if (stored && (done || confirm.kind === "same"))
    return (
      <Page>
        <h1 className={H1}>Links from GitHub open your nod at</h1>
        <HostName origin={stored.to} />
        <p className={P}>
          A link to nod in a comment or a notification now shows “Open on{" "}
          <Host origin={stored.to} />” in this browser; tap it to go there.
          {!done && ` Remembered since ${since(stored.since)}.`}
        </p>
        {pairedNote}
        <Footer
          note={
            <button
              type="button"
              className={cn(LINK, "phone:min-h-11")}
              onClick={() => {
                forward.forget();
                onLeave();
              }}
            >
              Forget this address
            </button>
          }
        >
          <button type="button" className={OUTLINE} onClick={onLeave}>
            Done
          </button>
          <a className={PRIMARY} href={forwardUrl(stored.to, null) ?? undefined}>
            Back to your nod
          </a>
        </Footer>
      </Page>
    );

  return (
    <Page>
      <h1 className={H1}>Open nod links in this browser at this address?</h1>
      <HostName origin={confirm.to} />
      <p className={P}>
        Links to nod in pull request comments and GitHub notifications open this page, which is not
        connected to your nod. If this browser remembers the address above, such a link offers to
        open the pull request there, one tap each time.
      </p>
      {confirm.kind === "replace" && (
        <p className={P}>
          It replaces{" "}
          <b className="text-tx font-mono">
            <Host origin={confirm.was} />
          </b>
          , the address this browser remembers now.
        </p>
      )}
      <div className="border-need-line bg-need-bg text-tx2 mt-4 rounded-lg border px-3.5 py-3 text-[13.5px] leading-[1.55]">
        <b className="text-tx font-semibold">Remember it only</b> if you tapped “Open links from
        GitHub here” in your own nod a moment ago, and the address is your machine’s. Anyone can
        make a link to this page with another address, and a page there could ask for your
        passphrase.
      </div>
      {pairedNote}
      {failed && (
        <p className="text-bad m-0 mt-3 text-[13px]" role="alert">
          This browser does not let the page store anything; nothing was remembered.
        </p>
      )}
      <Footer note="Leaving this page remembers nothing.">
        <button
          type="button"
          className={OUTLINE}
          disabled={!armed}
          onClick={() => {
            if (!armed) return;
            if (forward.remember(confirm.to)) setDone(true);
            else setFailed(true);
          }}
        >
          Remember this address
        </button>
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the default is not to remember */}
        <button type="button" className={PRIMARY} autoFocus onClick={onLeave}>
          Don’t remember
        </button>
      </Footer>
    </Page>
  );
}

/**
 * The deep link's way to the remembered host: the host spelled out, one
 * button, and "Forget this address". The button is a plain link: a
 * top-level navigation to the route on the named host, nothing else.
 */
export function ForwardOffer({
  offer,
  title = "Open it in your nod",
  what,
  onForget,
  children,
}: {
  offer: Extract<Offer, { kind: "forward" }>;
  title?: string;
  /** What opens there: "#7", "these pull requests", "your nod". */
  what: string;
  onForget: () => void;
  /** More choices next to the button (the PR on GitHub). */
  children?: ReactNode;
}) {
  return (
    <>
      <h1 className="m-0 mb-1.5 text-[22px] font-bold tracking-[-0.01em]">{title}</h1>
      <p className="text-tx2 m-0 mb-3">This browser opens nod links at:</p>
      <HostName origin={offer.to} />
      <p className="text-tx3 fs-note m-0 mt-3 leading-[1.55]">
        It opens {what} there; the link carries no pairing and signs nothing. Not your machine?{" "}
        <button type="button" className={cn(LINK, "phone:min-h-11")} onClick={onForget}>
          Forget this address
        </button>
      </p>
      <Footer
        noteClass="max-w-[300px]"
        note="On the machine that runs nod serve, open the link it prints instead."
      >
        {children}
        <a className={PRIMARY} href={offer.url} referrerPolicy="no-referrer">
          <span>
            Open on <Host origin={offer.to} />
          </span>
        </a>
      </Footer>
    </>
  );
}

/**
 * Pairing inside a home-screen app: a pasted device link (or host link) for
 * this very page goes into the address's fragment, where the usual pairing
 * takes it (and drops it again).
 */
export function PasteLink() {
  const [text, setText] = useState("");
  const [wrong, setWrong] = useState(false);
  return (
    <form
      className="border-line mt-5 border-t pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        const hash = pastedHostLink(text, window.location);
        if (!hash) return setWrong(true);
        setText("");
        setWrong(false);
        window.location.hash = hash;
      }}
    >
      <label htmlFor="paste-link" className="text-tx mb-1.5 block text-[14px] font-semibold">
        Pair this app
      </label>
      <p className="text-tx3 fs-note m-0 mb-2.5 leading-[1.55]">
        A home-screen app keeps its own pairing, apart from the browser’s, and a scanned link opens
        in the browser, not here. Copy the link <code className="font-mono">nod serve</code> prints
        for this device (from the terminal, or with a scanner that copies instead of opening) and
        paste it here. Do not send it through a chat.
      </p>
      <div className="flex gap-2 phone:flex-col">
        <input
          id="paste-link"
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setWrong(false);
          }}
          placeholder="https://…/#host=…&token=…"
          aria-invalid={wrong}
          className="bg-bg border-line2 text-tx placeholder:text-tx3 h-[42px] min-w-0 flex-1 rounded-lg border px-3 font-mono text-[16px] phone:min-h-11"
        />
        <button type="submit" className={PRIMARY} disabled={!text.trim()}>
          Pair
        </button>
      </div>
      {wrong && (
        <p className="text-bad m-0 mt-2 text-[13px]" role="alert">
          That is not a link that pairs this page. Copy the whole link, for this address.
        </p>
      )}
    </form>
  );
}
