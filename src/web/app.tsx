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
 * - onboarding (`components/onboarding.tsx`) while the setup or the key is
 *   not ready, until "Go to the dashboard"; and again at `#/setup`;
 * - the dashboard once a snapshot is in (a deep link shows its landing there).
 *   A socket that drops keeps it: the last view stays, with a hint
 *   (`lib/reconnect.ts`), not the page for "not running".
 */

import { useState } from "react";

import { ClockProvider } from "@/hooks/use-clock";
import { ConnectionProvider, useConnection } from "@/hooks/use-connection";
import { useForward } from "@/hooks/use-forward";
import { useRoute } from "@/hooks/use-route";
import { githubOf } from "@/lib/deep-link";
import { offerFor } from "@/lib/forward";
import { isFramed } from "@/lib/guard";
import { progressOf } from "@/lib/onboarding";
import { isStandalone } from "@/lib/phone";
import { isLinkRoute } from "@/lib/route";
import { STORAGE_KEYS, browserStorage, readJson, writeJson } from "@/lib/storage";
import { Dashboard } from "./components/dashboard";
import { ForwardConfirm } from "./components/forward";
import { ConnectionPage, FramedPage, FullPage, type Unpaired } from "./components/full-page";
import { UnpairedLanding } from "./components/link-landing";
import { Onboarding } from "./components/onboarding";

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
  // Onboarding, once shown, stays until "Go to the dashboard": the key turns
  // pending in step 3, and step 4 still follows.
  const [inFlow, setInFlow] = useState(false);
  // "Look around first": the dashboard although something is not ready. Only
  // the key can wait (read everything, sign nothing): that choice is kept per
  // repo, as the dashboard's key note leads back. A repo that is not set up
  // asks again next time.
  const [skipped, setSkipped] = useState(false);
  const [keySkipped, setKeySkipped] = useState(() =>
    readJson(browserStorage(), STORAGE_KEYS.keySkipped),
  );

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

  const progress =
    welcome && setup && signer ? progressOf({ me: welcome.me, setup, signer }) : null;
  const onlyKey =
    !!progress && progress.signedIn && (progress.setup === "ready" || progress.setup === "pending");
  const needed =
    !!progress?.needed && !skipped && !(onlyKey && keySkipped === setup?.repo && !!setup?.repo);
  if (needed && !inFlow) setInFlow(true);
  if (welcome && setup && signer && (needed || inFlow || route.view === "setup"))
    return (
      <Onboarding
        me={welcome.me}
        github={githubOf(welcome)}
        setup={setup}
        signer={signer}
        people={snapshot?.people ?? []}
        actions={actions}
        reopened={route.view === "setup" && !inFlow}
        canLeave={snapshot !== null}
        onDone={() => {
          setInFlow(false);
          if (progress?.needed) {
            setSkipped(true);
            if (onlyKey && setup.repo) {
              writeJson(browserStorage(), STORAGE_KEYS.keySkipped, setup.repo);
              setKeySkipped(setup.repo);
            }
          }
          if (route.view === "setup") go({ view: "list" });
        }}
      />
    );

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
