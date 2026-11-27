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
 * - `gh` not logged in, or an empty repo list: a calm page each
 *   (`components/onboarding.tsx`, `components/add-repo.tsx`). Nothing else
 *   gates (ADR 0006): no setup, no key;
 * - the settings page at `#/settings` and `#/settings/<section>`
 *   (`components/settings.tsx`), an empty list too;
 * - the setup page at `#/setup` and `#/setup/<step>`: the ladder, where the
 *   steps the dashboard offers are done; with several repos, of the repo
 *   in the route (`#/setup/<repo>/<step>`), else of the first with an offer;
 * - the dashboard once a snapshot is in (a deep link shows its landing there).
 *   A socket that drops keeps it: the last view stays, with a hint
 *   (`lib/reconnect.ts`), not the page for "not running".
 */

import { ClockProvider } from "@/hooks/use-clock";
import { ConnectionProvider, useConnection } from "@/hooks/use-connection";
import { useForward } from "@/hooks/use-forward";
import { useRoute } from "@/hooks/use-route";
import { offerFor } from "@/lib/forward";
import { isFramed } from "@/lib/guard";
import { landingOf, setupRepoOf, setupRungOf } from "@/lib/onboarding";
import { githubOfRepo } from "@/lib/repos";
import { isStandalone } from "@/lib/phone";
import { isLinkRoute } from "@/lib/route";
import { Dashboard } from "./components/dashboard";
import { ForwardConfirm } from "./components/forward";
import { ConnectionPage, FramedPage, FullPage, type Unpaired } from "./components/full-page";
import { UnpairedLanding } from "./components/link-landing";
import { AddRepoPage } from "./components/add-repo";
import { SetupPage, SignInPage } from "./components/onboarding";
import { SettingsPage } from "./components/settings";
import { sectionOf } from "@/lib/settings";

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
  const { status, welcome, snapshot, signer, repos, actions, reconnects } = useConnection();
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
    return (
      <ConnectionPage
        status={status}
        reconnects={reconnects}
        unpaired={unpaired}
        serverProtocol={welcome?.protocol ?? null}
      />
    );

  if (welcome && repos) {
    const landing = landingOf({ me: welcome.me, repos });
    if (landing === "sign-in") return <SignInPage github={githubOfRepo(repos, repos[0]?.key)} />;
    if (route.view === "settings")
      return (
        <SettingsPage
          section={sectionOf(route.section)}
          me={welcome.me}
          repos={repos}
          repoList={welcome.repoList}
          signer={signer}
          actions={actions}
          onSection={(section) => go({ view: "settings", section }, { replace: true })}
          onSetup={(repo, step) =>
            go({ view: "setup", ...(repos.length > 1 && { repo }), ...(step && { step }) })
          }
          onLeave={repos.length > 0 ? () => go({ view: "list" }) : null}
        />
      );
    if (landing === "add-repo") return <AddRepoPage actions={actions} />;
  }
  if (welcome && repos && signer && route.view === "setup") {
    const ladder = setupRepoOf(
      repos.map((repo) => ({ me: welcome.me, repo, signer })),
      route.repo ?? null,
    );
    if (ladder) {
      const asked = route.repo ? { repo: route.repo } : {};
      return (
        <SetupPage
          {...ladder}
          // Another repo is another page: its own steps' state.
          key={ladder.repo.key}
          repos={repos}
          people={snapshot?.people ?? []}
          actions={actions}
          step={setupRungOf(ladder, route.step ?? null)}
          onStep={(step) => go({ view: "setup", ...asked, step }, { replace: true })}
          onRepos={() => go({ view: "settings", section: "repositories" })}
          onLeave={snapshot ? () => go({ view: "list" }) : null}
        />
      );
    }
  }

  if (snapshot)
    return (
      <Dashboard
        snapshot={snapshot}
        welcome={welcome}
        signer={signer}
        repos={repos ?? []}
        status={status}
        actions={actions}
        route={route}
        go={go}
      />
    );
  return <FullPage title="Reading GitHub…" />;
}
