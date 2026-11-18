/**
 * The web app root: the connection to `nod serve`, the shared clock, the
 * route, and what to show for the connection's state. A calm full page
 * while there is nothing to show; the dashboard once a snapshot is in.
 */

import { ClockProvider } from "@/hooks/use-clock";
import { ConnectionProvider, useConnection } from "@/hooks/use-connection";
import { useRoute } from "@/hooks/use-route";
import { Dashboard } from "./components/dashboard";
import { ConnectionPage, FullPage } from "./components/full-page";

export function App() {
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
  if (status !== "open") return <ConnectionPage status={status} reconnects={reconnects} />;
  // Connected, no snapshot: onboarding's ground (a later task).
  if (welcome && !welcome.me)
    return (
      <FullPage title="Sign in to GitHub first" command="gh auth login">
        <p>
          nod uses the GitHub login you already have. Sign in with <code>gh</code>, then restart{" "}
          <code className="font-mono">nod serve</code>.
        </p>
      </FullPage>
    );
  if (setup && (setup.state === "none" || setup.state === "missing"))
    return (
      <FullPage title="This repository is not set up yet">
        <p>
          {setup.repo
            ? `${setup.repo} has no nod policy and verifier yet.`
            : "nod serve has no repository picked yet."}{" "}
          The setup steps come in a later version of this page.
        </p>
      </FullPage>
    );
  return <FullPage title="Reading GitHub…" />;
}
