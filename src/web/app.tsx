/**
 * The web app root: the connection to `nod serve`, the shared clock, the
 * route, and what to show for the connection's state:
 *
 * - inside another page's frame: a bare page that refuses (`lib/guard.ts`),
 *   before the connection or the fragment is looked at;
 * - `#/forward?to=…` on the hosted UI (or a page on this machine): the
 *   confirmation that remembers where this browser's nod is (ADR 0005 §7),
 *   paired or not;
 * - not paired: a calm full page; for a deep link, its landing that says
 *   what to do and keeps the link across the pairing, or offers to open it
 *   on the remembered named host;
 * - `gh` not logged in, or no repo picked yet (the fake's `fresh` only): a
 *   calm page each (`components/onboarding.tsx`). Nothing else gates (ADR
 *   0006): no setup, no key;
 * - the setup page at `#/setup` and `#/setup/<step>`: the ladder, where the
 *   steps the dashboard offers are done;
 * - the dashboard once a snapshot is in (a deep link shows its landing there).
 *   A socket that drops keeps it: the last view stays, with a hint
 *   (`lib/reconnect.ts`), not the page for "not running".
 */

import { ClockProvider } from "@/hooks/use-clock";
import { ConnectionProvider, useConnection } from "@/hooks/use-connection";
import { useForward } from "@/hooks/use-forward";
import { useRoute } from "@/hooks/use-route";
import { githubOf } from "@/lib/deep-link";
import { offerFor } from "@/lib/forward";
import { isFramed } from "@/lib/guard";
import { landingOf, setupRungOf } from "@/lib/onboarding";
import { isStandalone } from "@/lib/phone";
import { isLinkRoute } from "@/lib/route";
import { Dashboard } from "./components/dashboard";
import { ForwardConfirm } from "./components/forward";
import { ConnectionPage, FramedPage, FullPage, type Unpaired } from "./components/full-page";
import { UnpairedLanding } from "./components/link-landing";
import { PickRepoPage, SetupPage, SignInPage } from "./components/onboarding";

export function App() {
  // Never inside another page: not paired, nothing remembered, no passphrase field.
  if (isFramed(window)) return <FramedPage />;
  return (
    <ConnectionProvider>
      <ClockProvider>
        <Gate />
      </ClockProvider>
    </ConnectionProvider>
  );
}

function Gate() {
  const { status, welcome, snapshot, signer, setup, actions, reconnects } = useConnection();
  const [route, go] = useRoute();
  const forward = useForward();
  const linkRoute = isLinkRoute(route) ? route : null;
  const unpaired: Unpaired = {
    offer: offerFor({
      paired: status !== "unpaired",
      page: window.location,
      forward: forward.forward,
      route: linkRoute,
    }),
    onForget: forward.forget,
    // The named host's own page: it pairs only from the device link.
    host: forward.here ? null : window.location.host,
    standalone: isStandalone(window),
  };

  if (route.view === "forward" && forward.here)
    return (
      <ForwardConfirm
        // Another host is another page: nothing tapped, not armed (ADR 0005 §7).
        key={`to:${route.to}`}
        given={route.to}
        forward={forward}
        paired={status !== "unpaired"}
        onLeave={() => go({ view: "list" }, { replace: true })}
      />
    );
  if (status === "unpaired" && linkRoute)
    return <UnpairedLanding route={linkRoute} unpaired={unpaired} />;
  // A drop keeps the last view (the dashboard says so after a moment); a
  // refused pairing or another protocol is no drop and gets its page.
  if ((!snapshot && status !== "open") || status === "refused" || status === "outdated")
    return <ConnectionPage status={status} reconnects={reconnects} unpaired={unpaired} />;

  if (welcome && setup) {
    const landing = landingOf({ me: welcome.me, setup });
    if (landing === "sign-in") return <SignInPage github={githubOf(welcome)} />;
    if (landing === "pick-repo" && welcome.me)
      return <PickRepoPage me={welcome.me} setup={setup} actions={actions} />;
  }
  if (welcome && setup && signer && route.view === "setup") {
    const ladder = { me: welcome.me, setup, signer };
    return (
      <SetupPage
        {...ladder}
        github={githubOf(welcome)}
        people={snapshot?.people ?? []}
        actions={actions}
        step={setupRungOf(ladder, route.step ?? null)}
        onStep={(step) => go({ view: "setup", step }, { replace: true })}
        onLeave={snapshot ? () => go({ view: "list" }) : null}
      />
    );
  }

  if (snapshot)
    return (
      <Dashboard
        snapshot={snapshot}
        welcome={welcome}
        signer={signer}
        setup={setup}
        status={status}
        actions={actions}
        route={route}
        go={go}
      />
    );
  return <FullPage title="Reading GitHub…" />;
}
