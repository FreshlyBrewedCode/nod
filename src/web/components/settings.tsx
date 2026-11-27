/**
 * The settings page (`#/settings`, `#/settings/<section>`; concept C.8,
 * D.7): a calm page in r3's language with a section nav on the left (a row
 * of tabs on a phone, once there is more than one section) and the section
 * on the right. Reached from the avatar menu.
 *
 * This version has one section, **Repositories**: the repos `nod serve`
 * reads, with each one's host, step of the ladder and my key there; its next
 * step (the same offers as the card above the list, every repo's, none put
 * away) and a way to its ladder (`#/setup/<repo>`, where the steps are
 * done); adding (with suggestions) and removing. A `fixed` list (`nod serve
 * --dir`) is shown read-only, with why and what to run instead.
 *
 * **App** (ADR 0008 §10, §11): installing the app where this browser can
 * (the browser's own dialog, or how it is done here, or the app's address
 * when this page is not the app), what it does without `nod serve`, and the
 * switch for the badge on its icon (the tab title always counts).
 *
 * **Signing** (`settings-signing.tsx`), **Server** (`settings-server.tsx`:
 * version, channel, updates with their notes, the service) and **Other
 * device** (`settings-device.tsx`), #54. The Server entry in the nav has a
 * dot while an update waits, and the top bar carries the update's pill
 * everywhere but there. Inbox comes with epic B.
 *
 * Adding a section: its id in `SETTINGS_SECTIONS` (`lib/route.ts`), its
 * words in `SECTIONS` (`lib/settings.ts`) and its page in `SECTION_PAGES`
 * below. A section is listed only once it has something in it.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  Account,
  AppState,
  RepoInfo,
  RepoKey,
  RepoList,
  SignerState,
} from "../../shared/protocol";
import type { Actions } from "@/hooks/use-connection";
import type { UpdateView } from "@/hooks/use-update";
import { serverNeedsLook } from "@/lib/update";
import { keyStateOf, offerWords, offersOf, type Rung } from "@/lib/onboarding";
import { SETTINGS_SECTIONS, type SettingsSection } from "@/lib/route";
import { SECTIONS, badgeLine, repoFacts, repoListError } from "@/lib/settings";
import { useBadgeOn } from "@/hooks/use-badge";
import { useInstall } from "@/hooks/use-install";
import { installHelp, installStateOf } from "@/lib/app";
import { canBadge, titleFor, type BadgeApi } from "@/lib/badge";
import { isStandalone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import { AddRepo, SMALL_BUTTON } from "./add-repo";
import { CommandBox, ENFORCE_COMMAND, NoteBox, useRequest } from "./onboarding";
import { CARD, Code, H2, Heading, LINE, QUIET } from "./settings-bits";
import { DeviceSection } from "./settings-device";
import { ServerSection } from "./settings-server";
import { SigningSection } from "./settings-signing";
import { Logo, TopBarShell, UpdatePill } from "./top-bar";

export interface SettingsPageProps {
  readonly section: SettingsSection;
  /** The `gh` account: the offers are mine. */
  readonly me: Account | null;
  readonly repos: ReadonlyArray<RepoInfo>;
  readonly repoList: RepoList;
  /** My key; null before the server said. */
  readonly signer: SignerState | null;
  readonly actions: Actions;
  readonly onSection: (section: SettingsSection) => void;
  /** A repo's ladder (`#/setup/<repo>[/<step>]`). */
  readonly onSetup: (repo: RepoKey, step?: Rung) => void;
  /** Back to the dashboard; null while there is none (an empty list). */
  readonly onLeave: (() => void) | null;
  /** The page is the app `nod serve` serves (`isServedApp`). */
  readonly servedApp: boolean;
  /** The app's address, `http://127.0.0.1:<port>`, for a page that is not the app. */
  readonly appAddress: string;
  /** My tier 1 rows now (the badge); null before a snapshot. */
  readonly badge: number | null;
  /** The app: version, channel, updates, the service; null from an older server. */
  readonly app: AppState | null;
  /** The update's indicator and "updated to x" (`useUpdate`). */
  readonly update: UpdateView;
}

/** Each section's page, by id: adding a section is one entry here (and its id and words). */
const SECTION_PAGES: Readonly<Record<SettingsSection, (props: SettingsPageProps) => ReactNode>> = {
  repositories: (props) => <Repositories {...props} />,
  signing: (props) => (
    <SigningSection {...props} otherSide={props.app ? !props.app.mayChange : false} />
  ),
  app: (props) => <AppSection {...props} />,
  server: (props) => (
    <ServerSection app={props.app} update={props.update} actions={props.actions} />
  ),
  "other-device": (props) => <DeviceSection app={props.app} actions={props.actions} />,
};

export function SettingsPage(props: SettingsPageProps) {
  const { section, onSection, onLeave, app, update } = props;
  return (
    <div className="pt-safe pb-safe px-safe flex min-h-full flex-col">
      <TopBarShell>
        <Logo />
        <span className="text-tx3 min-w-0 truncate text-[13px]">Settings</span>
        <span className="flex-1" />
        {section !== "server" && (
          <UpdatePill indicator={update.indicator} onOpen={() => onSection("server")} />
        )}
        {onLeave && (
          <button
            type="button"
            onClick={onLeave}
            className="text-tx3 hover:text-tx2 fs-note flex-none phone:min-h-11"
          >
            <span className="phone:hidden">Back to the dashboard</span>
            <span className="hidden phone:inline">Dashboard</span>
          </button>
        )}
      </TopBarShell>
      <div className="mx-auto my-12 grid w-full max-w-[940px] grid-cols-[200px_1fr] gap-11 px-6 phone:my-4 phone:grid-cols-1 phone:gap-4 phone:px-4">
        <SettingsNav
          section={section}
          onSection={onSection}
          marked={serverNeedsLook(app) ? "server" : null}
        />
        <main className="min-w-0" aria-labelledby="settings-title">
          {SECTION_PAGES[section](props)}
        </main>
      </div>
    </div>
  );
}

/**
 * The sections, in order: a list on the left; on a phone a row of tabs above
 * the section, and nothing while there is only one (its heading says it).
 */
function SettingsNav({
  section,
  onSection,
  marked,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  /** The section with something waiting (an update): a dot. */
  marked: SettingsSection | null;
}) {
  // A phone's row of tabs scrolls: the open one is in view.
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [section]);
  return (
    <nav aria-label="Settings" className={cn(SETTINGS_SECTIONS.length < 2 && "phone:hidden")}>
      <h2 className="text-tx3 m-0 mt-1.5 mb-1 text-[11px] font-semibold tracking-[0.08em] uppercase phone:sr-only">
        Settings
      </h2>
      <ul className="m-0 list-none p-0 phone:flex phone:gap-1 phone:overflow-x-auto">
        {SETTINGS_SECTIONS.map((id) => {
          const on = id === section;
          return (
            <li key={id} className="phone:flex-none">
              <button
                type="button"
                ref={on ? current : undefined}
                aria-current={on ? "page" : undefined}
                onClick={() => onSection(id)}
                className={cn(
                  "hover:text-tx w-full py-1.5 text-left phone:min-h-11 phone:rounded-lg phone:px-3",
                  on ? "text-tx font-semibold phone:bg-panel2" : "text-tx3",
                )}
              >
                <span className="flex items-center gap-1.5 text-[13.5px]">
                  {SECTIONS[id].title}
                  {marked === id && (
                    <>
                      <i aria-hidden className="bg-need size-1.5 flex-none rounded-full" />
                      <span className="sr-only">: something waits</span>
                    </>
                  )}
                </span>
                <span className="text-tx3 block fs-note font-normal phone:hidden">
                  {SECTIONS[id].line}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Repositories

function Repositories({ me, repos, repoList, signer, actions, onSetup }: SettingsPageProps) {
  const fixed = repoList === "fixed";
  return (
    <>
      <Heading title={SECTIONS.repositories.title}>
        nod reads the pull requests of these repositories into one inbox. Each one is at its own
        step of the ladder; reading it changes nothing in it.
      </Heading>
      {fixed && (
        <NoteBox className="mb-4">
          <b>This list is fixed.</b> <Code>nod serve</Code> reads one clone: the one{" "}
          <Code>--dir</Code> names, or the clone it was started in. To read several repositories,
          add them with <Code>nod repo add owner/name</Code> and start <Code>nod serve</Code>{" "}
          without <Code>--dir</Code>; then this list changes here too.
        </NoteBox>
      )}
      {repos.length > 0 ? (
        <ul
          aria-label="Repositories nod reads"
          className="border-line bg-panel divide-line m-0 list-none divide-y overflow-hidden rounded-xl border p-0"
        >
          {repos.map((repo) => (
            <RepoRow
              key={repo.key}
              repo={repo}
              me={me}
              signer={signer}
              fixed={fixed}
              last={repos.length === 1}
              actions={actions}
              onSetup={onSetup}
            />
          ))}
        </ul>
      ) : (
        <p className="border-line2 text-tx2 m-0 rounded-xl border border-dashed px-5 py-4 text-[13px]">
          No repository yet. Add the first one below.
        </p>
      )}
      {!fixed && (
        <section
          aria-labelledby="add-repo-title"
          className="border-line bg-panel mt-6 rounded-xl border px-5 pt-4 pb-5 phone:px-4"
        >
          <h2 id="add-repo-title" className="m-0 mb-3 text-[15px] font-bold">
            Add a repository
          </h2>
          <AddRepo actions={actions} />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// App

function AppSection({ servedApp, appAddress, badge }: SettingsPageProps) {
  const install = useInstall();
  const [badgeOn, setBadgeOn] = useBadgeOn();
  const state = installStateOf({
    standalone: isStandalone(window),
    installed: install.installed,
    prompt: install.available,
    servedApp,
  });
  const help = installHelp(navigator.userAgent);
  const iconBadge = canBadge(navigator as BadgeApi);
  return (
    <>
      <Heading title={SECTIONS.app.title}>
        nod is an app <Code>nod serve</Code> serves on this machine, so it always matches the
        server. Installed, it has its own window, opens even when <Code>nod serve</Code> is not
        running (it says so and waits), and shows on its icon how much needs you.
      </Heading>

      <section aria-labelledby="install-title" className={CARD}>
        <h2 id="install-title" className={H2}>
          Install
        </h2>
        {state === "running" && (
          <p className={LINE}>
            This window is the installed app. Open it from your dock, launcher or home screen.
          </p>
        )}
        {state === "installed" && (
          <p className={LINE}>Installed. Open it from your dock, launcher or home screen.</p>
        )}
        {state === "prompt" && (
          <>
            <p className={cn(LINE, "mb-3")}>This browser can install nod as an app.</p>
            <button type="button" className={SMALL_BUTTON} onClick={() => void install.install()}>
              Install app
            </button>
          </>
        )}
        {state === "manual" && (
          <p className={LINE}>
            <b className="text-tx font-semibold">{help.browser}:</b> {help.how}
          </p>
        )}
        {state === "elsewhere" && (
          <>
            <p className={cn(LINE, "mb-3")}>
              This page is not the app: it is a page that talks to <Code>nod serve</Code> from
              elsewhere. The app is at this address, which the link <Code>nod serve</Code> prints
              opens and pairs:
            </p>
            <CommandBox command={`${appAddress}/`} />
          </>
        )}
      </section>

      <section aria-labelledby="badge-title" className={CARD}>
        <h2 id="badge-title" className={H2}>
          Badge
        </h2>
        <p className={cn(LINE, "mb-3")}>
          The number of pull requests that need you most (the prominent rows, in every repository)
          shows in the tab’s title, like <Code>{titleFor(3)}</Code>, and on the app’s icon.{" "}
          {badgeLine(badge)}
        </p>
        <label className="text-tx flex items-center gap-2.5 text-[13.5px] phone:min-h-11">
          <input
            type="checkbox"
            checked={badgeOn}
            onChange={(event) => setBadgeOn(event.target.checked)}
            className="accent-need size-4"
          />
          Show the count on the app’s icon
        </label>
        <p className="text-tx3 fs-note m-0 mt-2 leading-[1.55]">
          {iconBadge
            ? "It changes while the app runs, minimized too; nod sends no notifications."
            : "This browser shows no badge on an app’s icon; the tab’s title still counts."}{" "}
          This choice is kept in this browser only.
        </p>
      </section>
    </>
  );
}

/**
 * One repo: its key, its host, step and my key there; its next step of the
 * ladder with the offer's action (the enforced step's command in place);
 * the way to its ladder; and Remove, asked once more before it is done.
 */
function RepoRow({
  repo,
  me,
  signer,
  fixed,
  last,
  actions,
  onSetup,
}: {
  repo: RepoInfo;
  me: Account | null;
  signer: SignerState | null;
  fixed: boolean;
  /** The only repo of the list: removing it leaves the list empty. */
  last: boolean;
  actions: Actions;
  onSetup: (repo: RepoKey, step?: Rung) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const remove = useRequest();
  const offer = signer ? (offersOf({ me, repo, signer })[0] ?? null) : null;
  const words = offer && signer ? offerWords(offer, keyStateOf(signer, repo.enrolment)) : null;

  return (
    <li className="px-5 py-4 phone:px-4" aria-label={repo.key}>
      <div className="flex items-start gap-3 phone:flex-col phone:gap-1">
        <div className="min-w-0 flex-1">
          <b className="block font-mono text-[13.5px] font-medium [overflow-wrap:anywhere]">
            {repo.key}
          </b>
          <span className="text-tx3 block fs-note leading-[1.55]">{repoFacts(repo, signer)}</span>
        </div>
        <div className="-mr-2 flex flex-none items-center phone:-ml-2.5 phone:mr-0">
          <button
            type="button"
            className={QUIET}
            onClick={() => onSetup(repo.key)}
            aria-label={`The ladder of ${repo.key}`}
          >
            The ladder ›
          </button>
          {!fixed && (
            <button
              type="button"
              className={QUIET}
              aria-expanded={confirm}
              onClick={() => setConfirm(!confirm)}
              aria-label={`Remove ${repo.key}`}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {offer && words && (
        <div className="border-line2 mt-3 rounded-[10px] border border-dashed px-3.5 py-3">
          <div className="flex items-center gap-3 phone:flex-col phone:items-stretch">
            <div className="min-w-0 flex-1 text-[13px] leading-[1.5]">
              <span className="text-tx3 block text-[11px] font-semibold tracking-[0.08em] uppercase">
                {offer.phase === "waiting" ? "On its way" : "Next step · optional"}
              </span>
              <b className="block font-semibold">{words.title}</b>
              <span className="text-tx3 fs-note">{words.line}</span>
            </div>
            {words.action ? (
              <button
                type="button"
                className={SMALL_BUTTON}
                onClick={() => onSetup(repo.key, offer.rung)}
              >
                {words.action}
              </button>
            ) : offer.pr ? (
              <a href={offer.pr.url} target="_blank" rel="noreferrer" className={SMALL_BUTTON}>
                Open #{offer.pr.number} ↗
              </a>
            ) : null}
          </div>
          {offer.rung === "enforced" && (
            <div className="mt-2.5">
              <CommandBox command={ENFORCE_COMMAND} />
            </div>
          )}
        </div>
      )}
      {confirm && (
        <div className="bg-bg border-line2 mt-3 rounded-[10px] border px-3.5 py-3 text-[13px] leading-[1.55]">
          <p className="text-tx2 m-0 [overflow-wrap:anywhere]">
            Stop reading <span className="text-tx font-mono">{repo.key}</span>? Its pull requests
            leave your inbox. Nothing changes in the repository, and you can add it again.
            {last && " It is the only one: the list is empty then."}
          </p>
          {remove.failure && (
            <p role="alert" className="text-bad m-0 mt-2 fs-note">
              {repoListError(remove.failure)}
            </p>
          )}
          <div className="mt-2.5 flex items-center gap-2 phone:flex-col-reverse phone:items-stretch">
            <button
              type="button"
              disabled={remove.busy !== null}
              onClick={() =>
                void remove.run("remove", () => actions.request("remove-repo", { repo: repo.key }))
              }
              className="border-bad text-bad hover:bg-bad-bg inline-flex h-8 items-center justify-center rounded-lg border px-3.5 text-[13px] font-semibold disabled:opacity-50 phone:h-11"
            >
              {remove.busy ? "Removing…" : `Remove ${repo.name.split("/")[1] ?? repo.name}`}
            </button>
            <button type="button" className={QUIET} onClick={() => setConfirm(false)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
