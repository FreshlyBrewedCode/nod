/**
 * The dashboard: the top bar, the list (by attention or chronological) with
 * its resizable detail panel, the board with its overlay drawer, the
 * selection bar and the keyboard. Owns the shared state (focus, selection,
 * open clusters, the panel and the drawer) and hands it to rows and cards
 * through `useDashboard`. Above the list, the offer card: the next step of
 * the ladder (`offer.tsx`); the avatar menu lists every step offered.
 *
 * Many repos (ADR 0007): one inbox of every repo's PRs, each row with its
 * repo chip once there is more than one (`chipsOf`); a PR is its id
 * (`<repo>#<n>`) for focus, selection and the batch. With one repo the top
 * bar names it and nothing else changes. With several, the repo filter
 * (`repo-filter.tsx`, remembered per browser) narrows the list, the board
 * and the selection to one repo, and the board can group by repository.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  attentionView,
  boardView,
  chronologicalView,
  inRepo,
  mergedOnTheirOwn,
  oldestWaitingSince,
  repoBoardView,
  selectable,
  shortName,
  stateBoardView,
  type Column,
  type ColumnKind,
  type StateColumnId,
} from "../../shared/attention";
import type {
  PrId,
  PrView,
  RepoInfo,
  RepoKey,
  SignerState,
  Snapshot,
  Welcome,
} from "../../shared/protocol";
import { idOf, sameRepo } from "../../shared/repo-key";
import type { Actions } from "@/hooks/use-connection";
import { MINUTE, useNow, useUtcOffset } from "@/hooks/use-clock";
import { useReconnectNotice } from "@/hooks/use-reconnect-notice";
import { DashboardContext, useDashboard, type DashboardState } from "@/hooks/use-dashboard";
import { useBackStop } from "@/hooks/use-back-stop";
import { useIsPhone } from "@/hooks/use-is-phone";
import { canSignWith, findPr } from "@/lib/batch";
import {
  bestEnrolment,
  chipsOf,
  enrolmentIn,
  githubOfRepo,
  loginIn,
  readRepoFilter,
  repoOf,
} from "@/lib/repos";
import { forwardSetupUrl } from "@/lib/forward";
import type { Status } from "@/lib/connection";
import {
  itemKeys,
  moveBoardFocus,
  moveFocus,
  prKey,
  prOfKey,
  reconcileFocus,
  type BoardMove,
  type FocusKey,
} from "@/lib/focus";
import { clampPanelWidth, panelMax, PANEL_MIN, readPanelPrefs, type PanelPrefs } from "@/lib/panel";
import { needsYouOrder } from "@/lib/next";
import {
  cardOf,
  dismiss,
  keyStateOf,
  offerKeyOf,
  offerWords,
  offersOf,
  readDismissed,
  RUNG_NAMES,
  type Rung,
  type ServerState,
} from "@/lib/onboarding";
import { isLinkRoute, viewFor, type Route, type View } from "@/lib/route";
import { selectionReducer } from "@/lib/selection";
import { actWord, keyNoteOf } from "@/lib/wording";
import {
  STORAGE_KEYS,
  browserStorage,
  markOpened,
  readGroup,
  readJson,
  readOpened,
  writeJson,
} from "@/lib/storage";
import { clockTime, duration, sinceText } from "@/lib/time";
import { BatchProvider, useBatch } from "./batch-dialog";
import { Board, BoardBar, type BoardColumnView, type GroupBy } from "./board";
import { DetailPage } from "./detail-page";
import { DetailPanel } from "./detail-panel";
import { Legend } from "./legend";
import { LinkLanding } from "./link-landing";
import { OfferCard } from "./offer";
import { RepoFilter } from "./repo-filter";
import { BucketSection, EmptyLane, LaneHeader, LaneSection } from "./lists";
import { SelectionBar } from "./selection-bar";
import { SubBar } from "./sub-bar";
import { Logo, Me, Segmented, ShortcutsHelp, TopBarShell } from "./top-bar";
import { LockChip } from "./unlock";
import { cn } from "@/lib/utils";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";

export interface DashboardProps {
  readonly snapshot: Snapshot;
  readonly welcome: Welcome | null;
  readonly signer: SignerState | null;
  /** The repos, with their setup and my enrolment (ADR 0007). */
  readonly repos: ReadonlyArray<RepoInfo>;
  readonly status: Status;
  readonly actions: Actions;
  readonly route: Route;
  readonly go: (route: Route, options?: { replace?: boolean }) => void;
  /** The page is the app `nod serve` serves (ADR 0008, `isServedApp`). */
  readonly servedApp?: boolean;
}

export function Dashboard(props: DashboardProps) {
  // "Open the last one" on the sign sheet (above the dashboard) shows a PR's page, which is
  // the dashboard's: the dashboard registers how.
  const openPr = useRef<(pr: PrId) => void>(() => {});
  return (
    <BatchProvider
      snapshot={props.snapshot}
      repos={props.repos}
      signer={props.signer}
      actions={props.actions}
      onOpenPr={(pr) => openPr.current(pr)}
    >
      <DashboardInner {...props} openPrRef={openPr} />
    </BatchProvider>
  );
}

const DAY = 24 * 60 * MINUTE;

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** The last visit, read once: "Since yesterday 17:42: …". Saved when the page goes away. */
function useLastVisit(now: number): number {
  const [since] = useState(() => {
    const stored = readJson(browserStorage(), STORAGE_KEYS.lastVisit);
    return typeof stored === "number" && stored < Date.now() ? stored : null;
  });
  useEffect(() => {
    const save = () => writeJson(browserStorage(), STORAGE_KEYS.lastVisit, Date.now());
    const onVisibility = () => document.visibilityState === "hidden" && save();
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return since ?? now - DAY;
}

function DashboardInner({
  snapshot,
  welcome,
  signer,
  repos,
  status,
  actions,
  route,
  go,
  servedApp = false,
  openPrRef,
}: DashboardProps & { openPrRef: { current: (pr: PrId) => void } }) {
  const { openBatch } = useBatch();
  const notice = useReconnectNotice(status === "open");
  const now = useNow(MINUTE);
  const utcOffsetMinutes = useUtcOffset();
  // The board is off on a phone: a route to it shows the list (the route itself stays valid).
  const phone = useIsPhone();
  const view: View = viewFor(route, phone);
  const me = snapshot.me;
  const chips = useMemo(() => chipsOf(repos), [repos]);
  const many = repos.length > 1;

  // -- the repo filter: one repo, or all; remembered per browser ---------------
  const [filterAsked, setFilterAsked] = useState<unknown>(() =>
    readJson(browserStorage(), STORAGE_KEYS.repoFilter),
  );
  // A repo the list no longer has (or one repo only) is no filter: all.
  const filter = readRepoFilter(filterAsked, repos);
  const chooseFilter = useCallback((repo: RepoKey | null) => {
    writeJson(browserStorage(), STORAGE_KEYS.repoFilter, repo);
    setFilterAsked(repo);
  }, []);

  // -- FYI acks leave the lane at once; the next snapshot confirms ---------
  // Kept until the snapshot says so (an ack that failed is dropped again).
  const [acking, setAcking] = useState<ReadonlySet<PrId>>(new Set());
  const allPrs = useMemo(
    () =>
      acking.size
        ? snapshot.prs.map((p) => (acking.has(idOf(p)) ? { ...p, fyiForMe: false } : p))
        : snapshot.prs,
    [snapshot.prs, acking],
  );
  // What the list, the board and the selection show: the filter's repo, or all.
  const prs = useMemo(() => inRepo(allPrs, filter), [allPrs, filter]);
  const needsByRepo = useMemo(() => {
    const counts = new Map<RepoKey, number>();
    for (const r of repos) counts.set(r.key, inRepo(allPrs, r.key).filter((p) => p.needsMe).length);
    return counts;
  }, [allPrs, repos]);
  const ackFyi = useCallback(
    (pr: PrView) => {
      const id = idOf(pr);
      setAcking((a) => new Set(a).add(id));
      actions
        .ackFyi({ repo: pr.repo, pr: pr.number })
        .catch(() => setAcking((a) => new Set([...a].filter((n) => n !== id))));
    },
    [actions],
  );

  // -- what is on screen -----------------------------------------------------
  const lanes = useMemo(() => attentionView(prs), [prs]);
  const buckets = useMemo(
    () => chronologicalView(prs, { now, utcOffsetMinutes }),
    [prs, now, utcOffsetMinutes],
  );
  const firstRun = snapshot.prs.length === 0;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleCluster = useCallback(
    (id: string) =>
      setExpanded((e) => {
        const next = new Set(e);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );

  // -- the board ----------------------------------------------------------------
  const [groupAsked, setGroup] = useState<unknown>(() =>
    readJson(browserStorage(), STORAGE_KEYS.board),
  );
  // "Repository" only while there are several: with one, the board's own.
  const group: GroupBy = readGroup(groupAsked, many);
  const chooseGroup = (g: GroupBy) => {
    writeJson(browserStorage(), STORAGE_KEYS.board, g);
    setGroup(g);
  };
  // The inbox step asks for no key: what waits on me there is a review on GitHub.
  const inbox = repos.length > 0 && repos.every((r) => r.setup.step === "inbox");
  // One key for every repo: the "You" column is muted only when it signs in none of them.
  const keyNote = inbox ? null : keyNoteOf(signer, bestEnrolment(repos));
  const columns = useMemo(
    () =>
      view === "board"
        ? boardColumns(prs, group, snapshot, now, keyNote, chips, repos, filter)
        : [],
    [view, prs, group, snapshot, now, keyNote, chips, repos, filter],
  );
  const columnKeys = useMemo(
    () => columns.map((c) => itemKeys(c.items, expanded)),
    [columns, expanded],
  );

  const keys = useMemo(() => {
    if (view === "board") return columnKeys.flat();
    const items =
      view === "chrono" ? buckets.flatMap((b) => b.items) : lanes.flatMap((l) => l.items);
    return itemKeys(items, expanded);
  }, [view, lanes, buckets, expanded, columnKeys]);

  // -- the panel -----------------------------------------------------------------
  const windowWidth = useWindowWidth();
  const [prefs, setPrefs] = useState<PanelPrefs>(() =>
    readPanelPrefs(readJson(browserStorage(), STORAGE_KEYS.panel)),
  );
  useEffect(() => {
    const t = setTimeout(() => writeJson(browserStorage(), STORAGE_KEYS.panel, prefs), 200);
    return () => clearTimeout(t);
  }, [prefs]);
  const onBoard = view === "board";
  // The board's drawer, and a phone's panel over the list: not remembered, they open on
  // a card or a row (r3 `10`). Beside the list the panel is remembered.
  const overlay = onBoard || phone;
  const listPanelOpen = prefs.open && !overlay;
  const panelWidth = clampPanelWidth(prefs.width, windowWidth);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const panelOpen = overlay ? drawerOpen : listPanelOpen;
  const setPanelOpen = useCallback(
    (open: boolean) =>
      overlay ? setDrawerOpen(open) : setPrefs((p) => (p.open === open ? p : { ...p, open })),
    [overlay],
  );
  // Leaving the board (or the phone) closes its drawer.
  if (!overlay && drawerOpen) setDrawerOpen(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragging]);

  // -- focus -------------------------------------------------------------------
  // `pr`: the last PR that had focus; the panel keeps it while a cluster has focus.
  const [focusState, setFocusState] = useState<{ key: FocusKey | null; pr: PrId | null }>({
    key: null,
    pr: null,
  });
  const setFocus = useCallback(
    (key: FocusKey | null) => setFocusState((f) => ({ key, pr: prOfKey(key) ?? f.pr })),
    [],
  );
  // An open panel with nothing focused (remembered from last time) takes the first row.
  const focus = focusState.key ?? (listPanelOpen ? (keys[0] ?? null) : null);
  const scrollOnFocus = useRef(false);
  const lastKeys = useRef(keys);
  useEffect(() => {
    const before = lastKeys.current;
    lastKeys.current = keys;
    setFocusState((f) => {
      const key = reconcileFocus(before, keys, f.key);
      return key === f.key ? f : { key, pr: prOfKey(key) ?? f.pr };
    });
  }, [keys]);
  const panelPr = prOfKey(focus) ?? focusState.pr;
  const shownPr = panelPr === null ? null : (findPr(allPrs, panelPr) ?? null);
  // A phone shows the details as a full-screen page, one history entry deep: back closes it.
  const pageOpen = phone && drawerOpen && shownPr !== null && !onBoard;
  useBackStop(pageOpen, () => setDrawerOpen(false));
  const needOrder = useMemo(() => needsYouOrder(lanes[0]!.items), [lanes]);

  // "Opened in the UI", per PR, for the batch dialog's "not opened" mark.
  const shownRepo = shownPr?.repo ?? null;
  const shownNumber = shownPr?.number ?? null;
  useEffect(() => {
    if (!panelOpen || shownNumber === null || shownRepo === null) return;
    const storage = browserStorage();
    const opened = readOpened(readJson(storage, STORAGE_KEYS.opened));
    writeJson(storage, STORAGE_KEYS.opened, markOpened(opened, shownRepo, shownNumber, Date.now()));
  }, [panelOpen, shownNumber, shownRepo]);

  // Closing the drawer gives the DOM focus back to its card.
  const wasDrawerOpen = useRef(false);
  useEffect(() => {
    if (wasDrawerOpen.current && !drawerOpen && focus)
      document.querySelector<HTMLElement>(`[data-key="${focus}"]`)?.focus({ preventScroll: true });
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen, focus]);

  // -- selection -----------------------------------------------------------------
  const [selection, dispatch] = useReducer(selectionReducer, []);
  const selectableIds = useMemo(() => prs.filter((p) => selectable(p)).map(idOf), [prs]);
  useEffect(() => dispatch({ t: "keep", prs: selectableIds }), [selectableIds]);
  const toggleSelected = useCallback(
    (pr: PrId) => {
      if (selectableIds.includes(pr)) dispatch({ t: "toggle", pr });
    },
    [selectableIds],
  );

  // -- a deep link shows its landing; "Open" there shows the PR in the list --
  const landing = isLinkRoute(route) ? route : null;
  const openInList = useCallback(
    (pr: PrId) => {
      // A PR the filter hides: the list shows every repo again, so it is there.
      if (filter !== null && !prs.some((p) => idOf(p) === pr)) chooseFilter(null);
      setFocusState({ key: prKey(pr), pr });
      setPrefs((p) => ({ ...p, open: true }));
      // On a phone "Open" shows the PR's page over the list.
      if (phone) setDrawerOpen(true);
      scrollOnFocus.current = true;
      go({ view: "list" });
    },
    [go, phone, filter, prs, chooseFilter],
  );
  useLayoutEffect(() => {
    openPrRef.current = (pr) => {
      setFocusState({ key: prKey(pr), pr });
      setDrawerOpen(true);
    };
  }, [openPrRef]);

  const focusRow = useCallback(
    (key: FocusKey, options: { open?: boolean } = {}) => {
      setFocus(key);
      if (options.open && prOfKey(key) !== null) setPanelOpen(true);
    },
    [setFocus, setPanelOpen],
  );

  // Keep the focused row in view and give it the DOM focus (keyboard moves only).
  useEffect(() => {
    if (!focus || !scrollOnFocus.current) return;
    scrollOnFocus.current = false;
    const el = document.querySelector<HTMLElement>(`[data-key="${focus}"]`);
    el?.scrollIntoView({ block: "nearest" });
    el?.focus({ preventScroll: true });
  }, [focus, panelOpen]);

  // -- the keyboard ------------------------------------------------------------------
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const onLanding = landing !== null;
  const latest = useRef({
    view,
    keys,
    columnKeys,
    focus,
    panelOpen,
    selection,
    prs,
    onLanding,
    pageOpen,
  });
  useLayoutEffect(() => {
    latest.current = {
      view,
      keys,
      columnKeys,
      focus,
      panelOpen,
      selection,
      prs,
      onLanding,
      pageOpen,
    };
  });
  useEffect(() => {
    let chord = false;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[data-slot=dialog-content], [data-slot=popover-content]")) return;
      const s = latest.current;
      if (chord) {
        chord = false;
        clearTimeout(chordTimer);
        const to = { l: "list", c: "chrono", b: "board" } as const;
        const next = to[e.key as keyof typeof to];
        if (next) {
          e.preventDefault();
          go({ view: next });
        }
        return;
      }
      if (e.key === "g") {
        chord = true;
        chordTimer = setTimeout(() => (chord = false), 1500);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // A phone's detail page covers the list: only Escape (a hardware keyboard) acts.
      if (s.pageOpen) {
        if (e.key === "Escape") setPanelOpen(false);
        return;
      }
      // The landing of a deep link has no rows to move through.
      if (s.onLanding) return;
      const board = s.view === "board";
      const focusedPr = prOfKey(s.focus);
      const pr = focusedPr === null ? null : findPr(s.prs, focusedPr);
      const move = (delta: number, boardMove: BoardMove) => {
        e.preventDefault();
        scrollOnFocus.current = true;
        setFocus(
          board
            ? moveBoardFocus(s.columnKeys, s.focus, boardMove)
            : moveFocus(s.keys, s.focus, delta),
        );
      };
      switch (e.key) {
        case "j":
        case "ArrowDown":
          return move(1, "down");
        case "k":
        case "ArrowUp":
          return move(-1, "up");
        case "h":
        case "ArrowLeft":
          return board ? move(0, "left") : undefined;
        case "l":
        case "ArrowRight":
          return board ? move(0, "right") : undefined;
        case "Enter": {
          if (target?.closest("button, a")) return;
          e.preventDefault();
          if (s.focus?.startsWith("cluster:")) return toggleCluster(s.focus.slice(8));
          if (!s.focus && s.keys.length) {
            scrollOnFocus.current = true;
            setFocus(s.keys[0]!);
          }
          return setPanelOpen(true);
        }
        case "Escape":
          if (s.panelOpen) return setPanelOpen(false);
          if (s.selection.length) return dispatch({ t: "clear" });
          return;
        case "x":
          if (pr && selectable(pr)) dispatch({ t: "toggle", pr: idOf(pr) });
          return;
        case "s":
          if (s.selection.length) return openBatch(s.selection);
          if (pr?.ask) return openBatch([idOf(pr)]);
          return;
        case "e":
          if (pr?.fyiForMe) ackFyi(pr);
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(chordTimer);
    };
  }, [go, openBatch, ackFyi, setPanelOpen, setFocus, toggleCluster]);

  // -- first run ------------------------------------------------------------------
  const [legendDismissed, setLegendDismissed] = useState(
    () => readJson(browserStorage(), STORAGE_KEYS.legend) === "dismissed",
  );
  // "How this list works" in a phone's avatar menu shows it again, on top of the list.
  const [legendAsked, setLegendAsked] = useState(false);
  const dismissLegend = () => {
    writeJson(browserStorage(), STORAGE_KEYS.legend, "dismissed");
    setLegendDismissed(true);
    setLegendAsked(false);
  };
  const askLegend = () => {
    setLegendAsked(true);
    document.getElementById("list-scroll")?.scrollTo({ top: 0 });
  };
  const firstSetup = repos.length > 0 && repos.every((r) => r.setup.state === "pending");
  const showLegend = legendAsked || (!legendDismissed && (firstRun || firstSetup));

  // -- the ladder's offers: one card, every one in the avatar menu -------------
  // Per repo (ADR 0007, 11): the card is the first repo's next step; the menu lists all.
  const [dismissed, setDismissed] = useState(() =>
    readDismissed(readJson(browserStorage(), STORAGE_KEYS.offers)),
  );
  const ladders: ServerState[] =
    welcome && signer ? repos.map((repo) => ({ me: welcome.me, repo, signer })) : [];
  // With the filter on one repo, the card is that repo's next step.
  const card = cardOf(
    filter === null ? ladders : ladders.filter((l) => sameRepo(l.repo.key, filter)),
    dismissed,
  );
  const dismissCard = () => {
    if (!card) return;
    const next = dismiss(dismissed, offerKeyOf(card.repo, card.offer));
    writeJson(browserStorage(), STORAGE_KEYS.offers, next);
    setDismissed(next);
  };
  const toSetup = (rung?: Rung, repo?: RepoKey) =>
    go({ view: "setup", ...(many && repo && { repo }), ...(rung && { step: rung }) });
  const menuOffers = ladders.flatMap(({ repo }, i) =>
    offersOf(ladders[i]!).map((o) => ({
      rung: o.rung,
      ...offerWords(o, signer ? keyStateOf(signer, repo.enrolment) : "none"),
      ...(many && { repo: repo.key }),
    })),
  );

  const since = useLastVisit(now);
  const state: DashboardState = {
    snapshot,
    repos,
    chips,
    githubOf: (pr) => githubOfRepo(repos, pr.repo),
    me,
    meIn: (pr) => loginIn(repos, pr.repo, me),
    people: snapshot.people,
    focus,
    focusRow,
    selection,
    toggleSelected,
    clearSelection: () => dispatch({ t: "clear" }),
    expanded,
    toggleCluster,
    panelOpen,
    setPanelOpen,
    ackFyi,
    openBatch,
    signingIn: (pr) => canSignWith(signer, enrolmentIn(repos, pr.repo)),
  };

  const needs = lanes[0]!;
  const oldest = oldestWaitingSince(prs);
  const needsHint =
    needs.count > 1 && oldest !== null
      ? `oldest waits ${duration(now - oldest)}`
      : needs.count === 1
        ? "one left"
        : null;
  const merged = mergedOnTheirOwn(prs, since);
  const filterChip = filter === null ? null : (chips.get(filter) ?? filter);
  const repoFilter = many && (
    <RepoFilter
      repos={repos}
      chips={chips}
      value={filter}
      needs={needsByRepo}
      onChange={chooseFilter}
    />
  );

  const list = (
    <div className="h-full overflow-auto" id="list-scroll">
      {!firstRun && (
        <SubBar
          view={view === "chrono" ? "chrono" : "list"}
          onView={(v) => go({ view: v })}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen(!panelOpen)}
          filter={repoFilter}
        />
      )}
      <main
        className={cn(
          "mx-auto max-w-[1000px] px-6 pt-[22px] pb-[110px] phone:px-0 phone:pt-0",
          // Room for the selection bar, and the home indicator under it.
          selection.length
            ? "phone:pb-[calc(6rem+env(safe-area-inset-bottom))]"
            : "phone:pb-[calc(2rem+env(safe-area-inset-bottom))]",
        )}
      >
        {showLegend && <Legend onDismiss={dismissLegend} />}
        {card && signer && (
          <OfferCard
            key={offerKeyOf(card.repo, card.offer)}
            offer={card.offer}
            repo={card.repo}
            named={many}
            signer={signer}
            onTake={() => toSetup(card.offer.rung, card.repo.key)}
            onDismiss={dismissCard}
          />
        )}
        {view === "chrono" && !firstRun ? (
          buckets.map((b) => <BucketSection key={b.id} bucket={b} />)
        ) : firstRun ? (
          <FirstRunLanes
            unclassified={snapshot.unclassified.length}
            repo={repos.length === 1 ? repos[0]!.key : "your repositories"}
          />
        ) : (
          <>
            {needs.count > 0 && merged > 0 && (
              <p className="text-tx3 m-0 mb-[22px] text-[13px] phone:mb-0 phone:px-4 phone:pt-3">
                Since {sinceText(since, now, utcOffsetMinutes)}: {merged} merged on their own.
              </p>
            )}
            <LaneSection
              lane={needs}
              hint={needsHint}
              empty={
                filterChip ? (
                  <>
                    <b className="text-tx font-semibold">Nothing needs you in {filterChip}.</b>{" "}
                    {[...needsByRepo.values()].some((n) => n > 0) ? (
                      <>
                        Other repositories have something for you:{" "}
                        <button
                          type="button"
                          onClick={() => chooseFilter(null)}
                          className="text-tx2 hover:text-tx underline underline-offset-2"
                        >
                          show all
                        </button>
                        .
                      </>
                    ) : (
                      "Nothing waits on you there."
                    )}
                  </>
                ) : inbox ? (
                  <>
                    <b className="text-tx font-semibold">Nothing needs you.</b> No review is
                    requested from you, and none of your pull requests is stuck.
                  </>
                ) : (
                  <>
                    <b className="text-tx font-semibold">Nothing needs you.</b> No agent is waiting
                    on your signature.
                  </>
                )
              }
            />
            {lanes[1]!.count > 0 && <LaneSection lane={lanes[1]!} hint="no input wanted" />}
            <LaneSection
              lane={lanes[2]!}
              hint="nothing to do"
              empty="Everything that merges on its own or waits on someone else, folded."
            />
          </>
        )}
      </main>
    </div>
  );

  // The board's overlay drawer (r3 `10`). A phone has no board: its details are a page.
  const drawer = drawerOpen && !phone && (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-[52px] bottom-0 z-20 bg-[#05070b88]"
      />
      <div className="border-line2 shadow-float fixed top-[52px] right-0 bottom-0 z-20 w-[540px] max-w-full border-l phone:top-[calc(52px+env(safe-area-inset-top))] phone:w-full phone:border-l-0">
        <DetailPanel
          pr={shownPr}
          width={phone ? windowWidth : 540}
          onClose={() => setDrawerOpen(false)}
        />
      </div>
    </>
  );

  return (
    <DashboardContext.Provider value={state}>
      <div className="pt-safe px-safe flex h-full flex-col" inert={pageOpen}>
        {/* The avatar's 44 px target sits at the edge: less padding there. */}
        <TopBarShell className="phone:pr-1 phone:pl-3.5">
          <Logo />
          {/* One repo: its name, as always. Several: each row says its own (the repo chip). */}
          {repos.length === 1 && (
            <span className="text-tx3 min-w-0 truncate text-[13px]">{repos[0]!.name}</span>
          )}
          <Segmented
            className="phone:hidden"
            label="View"
            value={view === "board" ? "board" : "list"}
            options={[
              { value: "list", label: "List", title: "g l" },
              { value: "board", label: "Board", title: "g b" },
            ]}
            onChange={(v) => go({ view: v === "board" ? "board" : "list" })}
          />
          <span className="flex-1" />
          {welcome?.fake && (
            <span className="text-tx3 text-[12.5px] phone:hidden" title="nod serve --fake">
              fake data
            </span>
          )}
          <ShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          <LockChip signer={signer} enrolment={bestEnrolment(repos)} actions={actions} />
          <Me
            login={me}
            people={snapshot.people}
            offers={menuOffers}
            onSetup={toSetup}
            onSettings={() => go({ view: "settings" })}
            onLegend={askLegend}
            fake={welcome?.fake}
            linksHere={forwardSetupUrl(window.location, welcome?.version ?? null, servedApp)}
          />
        </TopBarShell>
        {notice === "quiet" && (
          <output className="text-tx3 border-line block border-b px-5 py-1 text-[12.5px]">
            Reconnecting…
          </output>
        )}
        {notice === "stale" && (
          <output className="bg-need-bg text-need border-line block border-b px-5 py-1.5 text-[12.5px]">
            nod serve is not reachable; this page reconnects on its own. What you see is from{" "}
            {snapshot.sync.at ? clockTime(snapshot.sync.at, utcOffsetMinutes) : "earlier"}.
          </output>
        )}
        {landing ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <LinkLanding
              route={landing}
              snapshot={{ ...snapshot, prs: allPrs }}
              repos={repos}
              signer={signer}
              onOpen={openInList}
              onList={() => go({ view: "list" })}
            />
          </div>
        ) : onBoard ? (
          <>
            <BoardBar group={group} onGroup={chooseGroup} byRepo={many} filter={repoFilter} />
            <Board columns={columns} onBackground={() => setDrawerOpen(false)} />
            {drawer}
          </>
        ) : phone ? (
          <>
            <div className="min-h-0 flex-1">{list}</div>
            {drawer}
          </>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel id="list" minSize="30%">
              {list}
            </ResizablePanel>
            {listPanelOpen && (
              <>
                <ResizableHandle
                  id="detail-handle"
                  aria-label="Resize the details"
                  onPointerDownCapture={() => setDragging(true)}
                >
                  {dragging && (
                    <span className="bg-need text-on-need absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-[5px] px-[7px] py-0.5 font-mono text-[11px] font-medium whitespace-nowrap">
                      {panelWidth} px
                    </span>
                  )}
                </ResizableHandle>
                <DetailSlot
                  width={panelWidth}
                  max={panelMax(windowWidth)}
                  onWidth={(width) => setPrefs((p) => (p.width === width ? p : { ...p, width }))}
                >
                  <DetailPanel
                    pr={shownPr}
                    width={panelWidth}
                    onClose={() => setPanelOpen(false)}
                  />
                </DetailSlot>
              </>
            )}
          </ResizablePanelGroup>
        )}
        {!pageOpen && <SelectionBar />}
      </div>
      {pageOpen && (
        <DetailPage
          key={idOf(shownPr)}
          pr={shownPr}
          order={needOrder}
          onClose={() => setDrawerOpen(false)}
          onOpen={(pr) => setFocus(prKey(pr))}
        />
      )}
    </DashboardContext.Provider>
  );
}

/**
 * The panel's slot in the group. It takes its width once, when it opens: a
 * `defaultSize` that changed while dragging would restart the panel and end
 * the drag.
 */
function DetailSlot({
  width,
  max,
  onWidth,
  children,
}: {
  width: number;
  max: number;
  onWidth: (width: number) => void;
  children: ReactNode;
}) {
  const [initial] = useState(width);
  return (
    <ResizablePanel
      id="detail"
      defaultSize={initial}
      minSize={PANEL_MIN}
      maxSize={max}
      groupResizeBehavior="preserve-pixel-size"
      onResize={(size) => {
        const px = Math.round(size.inPixels);
        if (px > 0) onWidth(px);
      }}
    >
      {children}
    </ResizablePanel>
  );
}

function FirstRunLanes({ unclassified, repo }: { unclassified: number; repo: string }) {
  const lanes = [
    [
      "needs",
      "Needs you",
      "Pull requests that wait for your signature appear here, the riskiest on top.",
    ],
    [
      "know",
      "Worth knowing",
      "Changes a teammate or the policy wants you to notice. No input wanted.",
    ],
    [
      "background",
      "Background",
      "Everything that merges on its own or waits on someone else, folded.",
    ],
  ] as const;
  return (
    <>
      {lanes.map(([lane, title, text]) => (
        <section key={lane} className="mb-[34px] phone:mb-0" aria-label={title}>
          <LaneHeader lane={lane} title={title} count={0} />
          <EmptyLane>{text}</EmptyLane>
        </section>
      ))}
      {unclassified > 0 && (
        <p className="text-tx3 text-[12.5px] leading-[1.55] phone:px-4">
          {unclassified} open pull request{unclassified === 1 ? "" : "s"} in {repo}{" "}
          {unclassified === 1 ? "is" : "are"} not classified yet. They show up once the verifier has
          run on them.
        </p>
      )}
    </>
  );
}

const WAIT_EMPTY: Readonly<Record<ColumnKind, string>> = {
  me: "Nothing waits on you.",
  person: "Nothing waits on them.",
  anyone: "Nothing waits on a teammate.",
  automation: "No agent or check is busy.",
  done: "Nothing merged this week.",
};

const STATE_EMPTY: Readonly<Record<StateColumnId, string>> = {
  checks: "No checks running.",
  signature: "Nothing waits for a signature.",
  merging: "Nothing merging right now.",
  done: "Nothing merged this week.",
};

/**
 * The board's columns, by Waiting on (r3 `09`), by State (r2 `05`) or by
 * Repository (ADR 0007: a column per repo of the list, or the filter's one),
 * with their asides.
 */
function boardColumns(
  prs: ReadonlyArray<PrView>,
  group: GroupBy,
  snapshot: Snapshot,
  now: number,
  keyNote: string | null,
  chips: ReadonlyMap<RepoKey, string>,
  repos: ReadonlyArray<RepoInfo>,
  filter: RepoKey | null,
): ReadonlyArray<BoardColumnView> {
  const merged = prs.filter((p) => p.mergedAt !== null);
  const doneAside =
    merged.length && merged.every((p) => now - p.mergedAt! <= DAY) ? "last 24h" : "last 7 days";
  if (group === "repo") {
    const keys = filter === null ? repos.map((r) => r.key) : [filter];
    return repoBoardView(prs, keys).map((c) => {
      const repo = repoOf(repos, c.repo);
      return {
        id: c.id,
        title: chips.get(c.repo) ?? c.repo,
        note: repo ? RUNG_NAMES[repo.setup.step] : null,
        count: c.count,
        you: false,
        aside: c.needsMe ? `${c.needsMe} need${c.needsMe === 1 ? "s" : ""} you` : null,
        items: c.items,
        footer: null,
        empty: "No pull requests here.",
      };
    });
  }
  if (group === "state")
    return stateBoardView(prs).map((c) => ({
      id: `state:${c.id}`,
      title: c.title,
      count: c.count,
      // Without a key that signs, a GitHub approval is still something I can do.
      you: c.id === "signature" && (!keyNote || prsOf(c).some((p) => p.ask)),
      aside:
        c.id === "signature"
          ? c.mine
            ? `${c.mine} yours`
            : null
          : c.id === "checks"
            ? "no human needed"
            : c.id === "merging"
              ? "agents merge"
              : doneAside,
      items: c.items,
      footer: null,
      empty: STATE_EMPTY[c.id],
    }));
  return boardView(prs, { me: snapshot.me, people: snapshot.people, keyNote }).map((c) => ({
    id: c.id,
    title: c.title,
    note: c.note,
    count: c.count,
    // Without a key that can sign it is a muted column, unless something in it asks for an approval.
    you: c.kind === "me" && (!c.note || prsOf(c).some((p) => p.ask)),
    aside:
      c.kind === "me" ? (
        <SignColumn column={c} />
      ) : c.kind === "done" ? (
        doneAside
      ) : c.kind === "person" || c.kind === "anyone" ? (
        oldestWait(c, now)
      ) : null,
    items: c.items,
    footer: alsoText(c, prs, snapshot, chips, repos),
    empty: WAIT_EMPTY[c.kind],
  }));
}

const prsOf = (column: Pick<Column, "items">): PrView[] =>
  column.items.flatMap((i) => (i.kind === "pr" ? [i.pr] : [...i.prs]));

/** "1 day": how long the oldest PR of a teammate's column has waited on them. */
function oldestWait(column: Column, now: number): string | null {
  const since = prsOf(column).flatMap((p) => (p.waitingSince === null ? [] : [p.waitingSince]));
  if (!since.length) return null;
  const ms = now - Math.min(...since);
  return ms >= 60 * MINUTE ? duration(ms) : null;
}

/** "also #485, after you": PRs in another column that wait on this one later ("ledger #57" with several repos). */
function alsoText(
  column: Column,
  prs: ReadonlyArray<PrView>,
  snapshot: Snapshot,
  chips: ReadonlyMap<RepoKey, string>,
  repos: ReadonlyArray<RepoInfo>,
): string | null {
  if (!column.also.length) return null;
  const after = column.also.map((id) => {
    const pr = findPr(prs, id);
    const first = pr?.waitingOn[0];
    const who =
      !first || first.kind === "me"
        ? "you"
        : first.kind === "person"
          ? first.login.toLowerCase() === loginIn(repos, pr?.repo, snapshot.me).toLowerCase()
            ? "you"
            : shortName(first.login, snapshot.people)
          : "the agent";
    const chip = pr ? chips.get(pr.repo) : undefined;
    return `${chip ? `${chip} ` : ""}#${pr?.number ?? id}, after ${who}`;
  });
  return `also ${after.join("; ")}`;
}

/**
 * "Sign…" on my column: the batch dialog with the column's selection, or the
 * whole column. "Approve…" when the asks are GitHub approvals (no active key).
 */
function SignColumn({ column }: { column: Column }) {
  const { openBatch, selection } = useDashboard();
  const mine = prsOf(column).filter((p) => p.ask);
  if (!mine.length) return null;
  const picked = selection.filter((id) => mine.some((p) => idOf(p) === id));
  const ids = picked.length ? picked : mine.map(idOf);
  const verb = actWord(mine) === "approve" ? "Approve" : "Sign";
  return (
    <button
      type="button"
      onClick={() => openBatch(ids)}
      title={
        picked.length
          ? `${verb} the selected ones (s)`
          : `${verb} everything in this column${verb === "Approve" ? " on GitHub" : ""}`
      }
      className="bg-need border-need text-on-need inline-flex h-[26px] items-center rounded-lg border px-2.5 text-xs font-semibold"
    >
      {picked.length ? `${verb} ${picked.length}…` : `${verb}…`}
    </button>
  );
}
