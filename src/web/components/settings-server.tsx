/**
 * Settings → Server (ADR 0008 §8, §9, §12): the version `nod serve` runs,
 * the channel, the update with its release notes and the Update button (one
 * click, and a confirmation: it is the code that will hold the signing key),
 * how nod was installed and the command, and the background service with
 * "Run nod in the background" and where its output goes.
 *
 * The other device's side reads all of it and changes nothing: no buttons
 * that change the machine, and a line that says where they are.
 */

import { useEffect, useState } from "react";

import type { Account, AppState, GhLogin, UpdateChannel } from "../../shared/protocol";
import type { Actions } from "@/hooks/use-connection";
import { MINUTE, useNow } from "@/hooks/use-clock";
import type { UpdateView } from "@/hooks/use-update";
import type { Updated } from "@/lib/update";
import { CHANNEL_WORDS, releasedLine, serviceLine, updateLine } from "@/lib/update";
import { cn } from "@/lib/utils";
import { SMALL_BUTTON } from "./add-repo";
import { Markdown } from "./markdown";
import { ghLine, isServiceNod } from "@/lib/onboarding";
import { CommandBox, ErrorNote, NoteBox, PRIMARY, Words, useRequest } from "./onboarding";
import {
  CARD,
  Code,
  DANGER,
  Fact,
  Facts,
  H2,
  Heading,
  LINE,
  LongCode,
  NOTE,
  QUIET,
} from "./settings-bits";
import { Segmented } from "./top-bar";

export interface ServerSectionProps {
  readonly app: AppState | null;
  readonly update: UpdateView;
  readonly actions: Actions;
  /** What this nod serve sees of `gh`; null from an older server. */
  readonly gh?: GhLogin | null;
  readonly me?: Account | null;
}

const METHOD_NAMES = { npm: "npm", bun: "bun", pnpm: "pnpm", yarn: "yarn" } as const;

/** Where the other device's buttons are. */
function ElsewhereNote({ what }: { what: string }) {
  return (
    <NoteBox className="mt-3">
      <b>{what} on the machine nod runs on.</b> This device reads the state; open nod on that
      machine to change it.
    </NoteBox>
  );
}

export function ServerSection({ app, update, actions, gh = null, me = null }: ServerSectionProps) {
  // "Updated to x" is shown here while the section is open, then put away.
  // (also when it happens while the section is open: the restart reconnects under it).
  const [updated, setUpdated] = useState<Updated | null>(update.updated);
  const { forget } = update;
  const news = update.updated;
  if (news && news.to !== updated?.to) setUpdated(news);
  useEffect(() => {
    if (news) forget();
  }, [news, forget]);

  if (!app)
    return (
      <>
        <Heading title="Server">
          This <Code>nod serve</Code> does not say which version it runs or how it updates: it is
          older than this page.
        </Heading>
      </>
    );
  return (
    <>
      <Heading title="Server">
        <Code>nod serve</Code> runs on this machine: which version, where its updates come from, and
        whether it keeps running in the background.
      </Heading>
      <VersionCard app={app} actions={actions} updated={updated} />
      <UpdateCard app={app} actions={actions} updated={updated} />
      <ServiceCard app={app} actions={actions} />
      {gh && <GitHubCard gh={gh} me={me} service={isServiceNod(gh, app)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// what this nod serve sees of gh: what tells a service's environment from the terminal's

function GitHubCard({ gh, me, service }: { gh: GhLogin; me: Account | null; service: boolean }) {
  return (
    <section aria-labelledby="github-title" className={CARD}>
      <h2 id="github-title" className={H2}>
        GitHub
      </h2>
      <p className={LINE}>
        <Words text={ghLine(gh, me)} />
      </p>
      <Facts className="border-line mt-3 border-t pt-2">
        <Fact label="gh">
          {gh.path ? <LongCode>{gh.path}</LongCode> : "not found on nod serve’s PATH"}
        </Fact>
        {gh.detail && (
          <Fact label={gh.state === "unreachable" ? "GitHub said" : "gh said"}>
            <LongCode>{gh.detail}</LongCode>
          </Fact>
        )}
      </Facts>
      {service && (
        <p className={cn(NOTE, "mt-2")}>
          This <Code>nod serve</Code> is the background service: it runs with the environment{" "}
          <Code>nod service install</Code> gave it, not your terminal’s. After a change to{" "}
          <Code>gh</Code> or your PATH, run <Code>nod service install</Code> again in a terminal
          where <Code>gh auth status</Code> works.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// the version, the check, the channel, the install method

function VersionCard({
  app,
  actions,
  updated,
}: {
  app: AppState;
  actions: Actions;
  updated: Updated | null;
}) {
  const now = useNow(MINUTE);
  const check = useRequest();
  const channel = useRequest();
  const checking = app.update.status === "checking" || check.busy !== null;
  const { install } = app;
  const installing = app.update.installation.status === "installing";
  return (
    <section aria-labelledby="version-title" className={CARD}>
      <div className="flex items-start gap-3 phone:flex-col phone:gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="version-title" className={H2}>
            {app.version ? `nod ${app.version}` : "A development build"}
          </h2>
          <p className={LINE} aria-live="polite">
            {updateLine(app, now)}
          </p>
        </div>
        <button
          type="button"
          className={cn(SMALL_BUTTON, "phone:self-stretch")}
          disabled={checking}
          onClick={() => void check.run("check", () => actions.request("check-update", {}))}
        >
          {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      {updated && (
        <output className="block text-ok m-0 mt-2 text-[13.5px] font-semibold">
          ✓ Updated to {updated.to}
          {updated.from ? ` from ${updated.from}` : ""}.
        </output>
      )}
      {app.development && (
        <p className={cn(NOTE, "mt-2")}>
          A checkout of nod updates with <Code>git pull</Code>; nothing here installs it. Checking
          shows what the channel has, for information.
        </p>
      )}

      <div className="border-line mt-4 border-t pt-3.5">
        <div className="flex items-center gap-3 phone:flex-col phone:items-stretch phone:gap-2">
          <span className="text-tx text-[13.5px] font-semibold">Channel</span>
          {app.mayChange ? (
            <Segmented<UpdateChannel>
              label="Channel"
              value={app.channel}
              fill
              options={(["stable", "next"] as const).map((c) => ({
                value: c,
                label: CHANNEL_WORDS[c].label,
                disabled: installing || channel.busy !== null,
              }))}
              onChange={(c) =>
                void channel.run(c, () => actions.request("set-channel", { channel: c }))
              }
            />
          ) : (
            <span className="text-tx2 text-[13.5px]">{CHANNEL_WORDS[app.channel].label}</span>
          )}
        </div>
        <p className={cn(NOTE, "mt-1.5")}>
          {CHANNEL_WORDS[app.channel].label}: {CHANNEL_WORDS[app.channel].line}. Switching checks
          the other channel at once; what it offers installs only with your click, an older version
          too.
        </p>
        <ErrorNote failure={channel.failure} lead="The channel did not change." />
      </div>

      <Facts className="border-line mt-3 border-t pt-2">
        <Fact label="Installed with">
          {install.method
            ? METHOD_NAMES[install.method]
            : app.development
              ? "a checkout (git)"
              : "nod does not know"}
        </Fact>
        {install.command && (
          <Fact label="Updates run">
            <LongCode>{install.command}</LongCode>
          </Fact>
        )}
      </Facts>
      <ErrorNote failure={check.failure} lead="The check did not run." />
    </section>
  );
}

// ---------------------------------------------------------------------------
// the update: its notes, the button, what happens after the click

function UpdateCard({
  app,
  actions,
  updated,
}: {
  app: AppState;
  actions: Actions;
  updated: Updated | null;
}) {
  const now = useNow(MINUTE);
  const [confirm, setConfirm] = useState(false);
  const run = useRequest();
  const { update, install } = app;
  const { latest, kind, installation, after } = update;
  const offered = latest && kind ? latest : null;
  // Just updated: the notes of what runs now.
  const shown = offered ?? (updated && latest?.version === updated.to ? latest : null);
  if (!shown && installation.status === "idle") return null;
  const downgrade = kind === "downgrade";
  const busy = installation.status === "installing";
  const finished = installation.status === "installed";

  return (
    <section aria-labelledby="update-title" className={CARD}>
      {shown && (
        <>
          <div className="flex items-baseline gap-2 phone:flex-col phone:gap-0">
            <h2 id="update-title" className={cn(H2, "flex-1")}>
              {offered
                ? downgrade
                  ? `${shown.version}, the newest on ${app.channel}`
                  : `What’s new in ${shown.version}`
                : `What’s new in ${shown.version}, which runs now`}
            </h2>
            <span className={NOTE}>
              {releasedLine(shown.publishedAt, now)}
              {shown.url && (
                <>
                  {" · "}
                  <a
                    href={shown.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:text-tx2 underline underline-offset-2"
                  >
                    on GitHub ↗
                  </a>
                </>
              )}
            </span>
          </div>
          {downgrade && (
            <p className={cn(LINE, "mt-1")}>
              It is older than {app.version}: the {app.channel} channel has nothing newer yet.
              Installing it goes back; your key and settings stay as they are.
            </p>
          )}
          <section
            className="bg-bg border-line mt-3 max-h-[420px] overflow-y-auto rounded-[10px] border px-4 py-3.5 phone:max-h-none"
            aria-label={`Release notes of ${shown.version}`}
          >
            {shown.notes.trim() ? (
              <Markdown source={shown.notes} />
            ) : (
              <p className={NOTE}>This release has no notes.</p>
            )}
          </section>
        </>
      )}
      {!shown && (
        <h2 id="update-title" className={H2}>
          The update
        </h2>
      )}

      <div className="mt-4">
        {busy ? (
          <output className={cn("block", LINE)}>
            <b className="text-tx font-semibold">Installing {installation.version}</b> with{" "}
            {install.method ?? "the package manager"}… This takes a minute or two; the page stays as
            it is meanwhile.
          </output>
        ) : finished && after?.state === "restarting" ? (
          <output className={cn("block", LINE)}>
            <b className="text-ok font-semibold">✓ {installation.version} is installed.</b> The
            service restarts nod now; this page reconnects to the new version by itself.
          </output>
        ) : finished && after?.state === "restart-by-hand" ? (
          <>
            <output className={cn("block", LINE, "mb-2.5")}>
              <b className="text-ok font-semibold">✓ {installation.version} is installed.</b> This{" "}
              <Code>nod serve</Code> was started by hand, so it cannot restart itself: stop it
              (Ctrl-C in its terminal) and start it again, and this page reconnects.
            </output>
            <CommandBox command={after.command} />
            <p className={cn(NOTE, "mt-2")}>
              Run in the background, nod restarts by itself after an update (below).
            </p>
          </>
        ) : finished && after?.state === "restart-failed" ? (
          <>
            <p
              role="alert"
              className="bg-bad-bg m-0 rounded-lg px-3 py-2.5 text-[13px] leading-[1.55]"
            >
              <b className="text-bad">
                {installation.version} is installed, but the service did not restart.
              </b>{" "}
              {after.error}
            </p>
            <p className={cn(LINE, "mt-2.5 mb-2")}>Restart it yourself:</p>
            <CommandBox
              command={
                app.service.manager === "launchd"
                  ? "launchctl kickstart -k gui/$(id -u)/de.frebreco.nod"
                  : "systemctl --user restart nod.service"
              }
            />
          </>
        ) : null}

        {installation.status === "failed" && (
          <div role="alert">
            <p className="bg-bad-bg m-0 rounded-lg px-3 py-2.5 text-[13px] leading-[1.55]">
              <b className="text-bad">{installation.error ?? "The install failed."}</b> Nothing
              changed: nod {app.version} still runs.
            </p>
            {installation.output && (
              <pre className="bg-bg border-line text-tx2 mt-2.5 max-h-[180px] overflow-auto rounded-lg border px-3 py-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap [overflow-wrap:anywhere]">
                {installation.output}
              </pre>
            )}
            {install.command && (
              <>
                <p className={cn(LINE, "mt-2.5 mb-2")}>
                  To install it by hand, in a terminal (with the rights the package manager needs):
                </p>
                <CommandBox command={install.command} />
              </>
            )}
          </div>
        )}

        {offered && !busy && !finished && (
          <div className="mt-3 first:mt-0">
            <UpdateButton
              app={app}
              version={offered.version}
              downgrade={downgrade}
              confirm={confirm}
              setConfirm={setConfirm}
              run={run}
              actions={actions}
              again={installation.status === "failed"}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function UpdateButton({
  app,
  version,
  downgrade,
  confirm,
  setConfirm,
  run,
  actions,
  again,
}: {
  app: AppState;
  version: string;
  downgrade: boolean;
  confirm: boolean;
  setConfirm: (on: boolean) => void;
  run: ReturnType<typeof useRequest>;
  actions: Actions;
  again: boolean;
}) {
  const { install } = app;
  if (!app.mayChange) return <ElsewhereNote what="Updates are installed" />;
  if (app.development) return null;
  if (!install.method)
    return (
      <>
        <p className={cn(LINE, "mb-2.5")}>
          nod does not know how it was installed, so it does not install updates itself. Run the
          command of the package manager you installed it with, then restart <Code>nod serve</Code>:
        </p>
        <div className="flex flex-col gap-2">
          {install.commands.map((command) => (
            <CommandBox key={command} command={command} />
          ))}
        </div>
      </>
    );
  const restarts = app.service.thisNod;
  const label = downgrade
    ? `Go back to ${version}`
    : again
      ? `Try ${version} again`
      : `Update to ${version}`;
  return (
    <>
      {!confirm ? (
        <div className="flex items-center gap-3 phone:flex-col phone:items-stretch">
          <button type="button" className={PRIMARY} onClick={() => setConfirm(true)}>
            {label}
          </button>
          <span className={NOTE}>
            {restarts
              ? "nod restarts by itself afterwards, through the service."
              : "Then you restart nod serve; nod shows the command."}
          </span>
        </div>
      ) : (
        <div className="border-need bg-need-bg rounded-[10px] border px-4 py-3.5">
          <p className="text-tx m-0 text-[13.5px] leading-[1.55]">
            <b>Install nod {version}?</b> It is the code that will hold your signing key, so it
            installs only now that you ask. nod runs:
          </p>
          <div className="mt-2.5">
            <CommandBox command={install.command ?? ""} />
          </div>
          <ErrorNote failure={run.failure} lead="Nothing was installed." />
          <div className="mt-3 flex items-center gap-2 phone:flex-col-reverse phone:items-stretch">
            <button
              type="button"
              className={PRIMARY}
              disabled={run.busy !== null}
              onClick={() =>
                void run
                  .run("install", () => actions.request("install-update", { version }))
                  .then((ok) => ok && setConfirm(false))
              }
            >
              {run.busy ? "Starting…" : `Install ${version}`}
            </button>
            <button type="button" className={QUIET} onClick={() => setConfirm(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// the background service

function ServiceCard({ app, actions }: { app: AppState; actions: Actions }) {
  const { service } = app;
  const setUp = useRequest();
  const remove = useRequest();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const installed = service.state === "running" || service.state === "stopped";
  const busy = service.busy !== null || setUp.busy !== null || remove.busy !== null;
  const args = service.args.join(" ");

  return (
    <section aria-labelledby="service-title" className={CARD}>
      <h2 id="service-title" className={H2}>
        In the background
      </h2>
      <p className={LINE}>{serviceLine(service)}</p>
      {service.handOver && (
        <output className="block text-ok m-0 mt-2 text-[13.5px] font-semibold">
          ✓ Set up. This nod serve stops now and the service takes over on the same port; this page
          reconnects to it in a few seconds.
        </output>
      )}
      {(installed || service.thisNod) && (
        <Facts>
          {service.unitPath && (
            <Fact label="Unit">
              <LongCode>{service.unitPath}</LongCode>
            </Fact>
          )}
          {service.command && (
            <Fact label="Runs">
              <span className="font-mono fs-code">{service.command}</span>
            </Fact>
          )}
          {service.logs && (
            <Fact label="Its output">
              <span className="font-mono fs-code">{service.logs}</span>
            </Fact>
          )}
        </Facts>
      )}
      {!service.thisNod && service.state !== "unsupported" && (
        <p className={cn(NOTE, "mt-2")}>
          This nod serve writes to the terminal it was started in, and stops with it.
        </p>
      )}

      {!app.mayChange ? (
        service.state !== "unsupported" && <ElsewhereNote what="The service is set up" />
      ) : service.state === "unsupported" ? null : (
        <>
          {!service.thisNod && !service.handOver && (
            <div className="border-line mt-4 border-t pt-3.5">
              <div className="flex items-center gap-3 phone:flex-col phone:items-stretch">
                <button
                  type="button"
                  className={SMALL_BUTTON}
                  disabled={busy}
                  onClick={() =>
                    void setUp.run("install", () => actions.request("service-install", {}))
                  }
                >
                  {service.busy === "installing"
                    ? "Setting it up…"
                    : installed
                      ? "Set it up again from this nod serve"
                      : "Run nod in the background"}
                </button>
              </div>
              <p className={cn(NOTE, "mt-2.5")}>
                It starts at login, restarts when it fails, and runs this nod
                {args ? (
                  <>
                    {" "}
                    with this nod serve’s options, <LongCode>{args}</LongCode>
                  </>
                ) : (
                  " with the same options as now"
                )}
                . <b className="text-tx2 font-semibold">This nod serve then stops</b>, so the
                service can take its port; the page stays paired and reconnects by itself. In a
                terminal: <Code>nod service install</Code>.
              </p>
            </div>
          )}
          {installed && (
            <div className="border-line mt-4 border-t pt-3.5">
              {!confirmRemove ? (
                <button
                  type="button"
                  className={cn(QUIET, "-ml-2.5")}
                  disabled={busy}
                  aria-expanded={false}
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove the service…
                </button>
              ) : (
                <div className="bg-bg border-line2 rounded-[10px] border px-3.5 py-3 text-[13px] leading-[1.55]">
                  <p className="text-tx2 m-0">
                    Stop the service and remove it?{" "}
                    {service.thisNod
                      ? "This nod serve is the service, so nod stops now: start it again in a terminal with "
                      : "nod then runs only while a terminal runs it: "}
                    <Code>nod serve</Code>.
                  </p>
                  <ErrorNote failure={remove.failure} lead="The service stays." />
                  <div className="mt-2.5 flex items-center gap-2 phone:flex-col-reverse phone:items-stretch">
                    <button
                      type="button"
                      className={DANGER}
                      disabled={busy}
                      onClick={() =>
                        void remove
                          .run("remove", () => actions.request("service-uninstall", {}))
                          .then((ok) => ok && setConfirmRemove(false))
                      }
                    >
                      {service.busy === "uninstalling" ? "Removing…" : "Remove the service"}
                    </button>
                    <button type="button" className={QUIET} onClick={() => setConfirmRemove(false)}>
                      Keep it
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {service.error && !setUp.failure && !remove.failure && (
        <p role="alert" className="text-bad m-0 mt-2 fs-note">
          <Words text={service.error} />
        </p>
      )}
      <ErrorNote failure={setUp.failure} lead="The service is not set up." />
    </section>
  );
}
