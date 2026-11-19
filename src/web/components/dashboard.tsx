/**
 * The dashboard: the top bar, the list (by attention or chronological) with
 * its resizable detail panel, the board with its overlay drawer, the
 * selection bar and the keyboard. Owns the shared state (focus, selection,
 * open clusters, the panel and the drawer) and hands it to rows and cards
 * through `useDashboard`.
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
  mergedOnTheirOwn,
  oldestWaitingSince,
  selectable,
  shortName,
  stateBoardView,
  type Column,
  type ColumnKind,
  type StateColumnId,
} from "../../shared/attention";
import type { PrView, SetupStatus, SignerState, Snapshot, Welcome } from "../../shared/protocol";
import type { Actions } from "@/hooks/use-connection";
import { MINUTE, useNow, useUtcOffset } from "@/hooks/use-clock";
import { DashboardContext, useDashboard, type DashboardState } from "@/hooks/use-dashboard";
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
import { isLinkRoute, viewOf, type Route, type View } from "@/lib/route";
import { selectionReducer } from "@/lib/selection";
import { keyNoteOf } from "@/lib/wording";
import {
  STORAGE_KEYS,
  browserStorage,
  markOpened,
  readJson,
  readOpened,
  writeJson,
} from "@/lib/storage";
import { clockTime, duration, sinceText } from "@/lib/time";
import { BatchProvider, useBatch } from "./batch-dialog";
import { Board, BoardBar, type BoardColumnView, type GroupBy } from "./board";
import { DetailPanel } from "./detail-panel";
import { Legend } from "./legend";
import { LinkLanding } from "./link-landing";
import { BucketSection, EmptyLane, LaneHeader, LaneSection } from "./lists";
import { SelectionBar } from "./selection-bar";
import { SubBar } from "./sub-bar";
import { Logo, Me, Segmented, ShortcutsHelp, TopBarShell } from "./top-bar";
import { LockChip } from "./unlock";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";

export interface DashboardProps {
  readonly snapshot: Snapshot;
  readonly welcome: Welcome | null;
  readonly signer: SignerState | null;
  readonly setup: SetupStatus | null;
  readonly status: Status;
  readonly actions: Actions;
  readonly route: Route;
  readonly go: (route: Route, options?: { replace?: boolean }) => void;
}

export function Dashboard(props: DashboardProps) {
  return (
    <BatchProvider snapshot={props.snapshot} signer={props.signer} actions={props.actions}>
      <DashboardInner {...props} />
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
  setup,
  status,
  actions,
  route,
  go,
}: DashboardProps) {
  const { openBatch } = useBatch();
  const now = useNow(MINUTE);
  const utcOffsetMinutes = useUtcOffset();
  const view: View = viewOf(route);
  const me = snapshot.me;

  // -- FYI acks leave the lane at once; the next snapshot confirms ---------
  // Kept until the snapshot says so (an ack that failed is dropped again).
  const [acking, setAcking] = useState<ReadonlySet<number>>(new Set());
  const prs = useMemo(
    () =>
      acking.size
        ? snapshot.prs.map((p) => (acking.has(p.number) ? { ...p, fyiForMe: false } : p))
        : snapshot.prs,
    [snapshot.prs, acking],
  );
  const ackFyi = useCallback(
    (pr: number) => {
      setAcking((a) => new Set(a).add(pr));
      actions.ackFyi(pr).catch(() => setAcking((a) => new Set([...a].filter((n) => n !== pr))));
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
  const [group, setGroup] = useState<GroupBy>(() =>
    readJson(browserStorage(), STORAGE_KEYS.board) === "state" ? "state" : "wait",
  );
  const chooseGroup = (g: GroupBy) => {
    writeJson(browserStorage(), STORAGE_KEYS.board, g);
    setGroup(g);
  };
  const keyNote = keyNoteOf(signer);
  const columns = useMemo(
    () => (view === "board" ? boardColumns(prs, group, snapshot, now, keyNote) : []),
    [view, prs, group, snapshot, now, keyNote],
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
  const listPanelOpen = prefs.open && !onBoard;
  const panelWidth = clampPanelWidth(prefs.width, windowWidth);
  // The board's drawer: not remembered, it opens on a card (r3 `10`).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const panelOpen = onBoard ? drawerOpen : listPanelOpen;
  const setPanelOpen = useCallback(
    (open: boolean) =>
      onBoard ? setDrawerOpen(open) : setPrefs((p) => (p.open === open ? p : { ...p, open })),
    [onBoard],
  );
  // Leaving the board closes its drawer.
  if (!onBoard && drawerOpen) setDrawerOpen(false);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [dragging]);

  // -- focus -------------------------------------------------------------------
  // `pr`: the last PR that had focus; the panel keeps it while a cluster has focus.
  const [focusState, setFocusState] = useState<{ key: FocusKey | null; pr: number | null }>({
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
  const shownPr = panelPr === null ? null : (prs.find((p) => p.number === panelPr) ?? null);

  // "Opened in the UI", per PR, for the batch dialog's "not opened" mark.
  const shownNumber = shownPr?.number ?? null;
  useEffect(() => {
    if (!panelOpen || shownNumber === null) return;
    const storage = browserStorage();
    const opened = readOpened(readJson(storage, STORAGE_KEYS.opened));
    writeJson(
      storage,
      STORAGE_KEYS.opened,
      markOpened(opened, snapshot.repo, shownNumber, Date.now()),
    );
  }, [panelOpen, shownNumber, snapshot.repo]);

  // Closing the drawer gives the DOM focus back to its card.
  const wasDrawerOpen = useRef(false);
  useEffect(() => {
    if (wasDrawerOpen.current && !drawerOpen && focus)
      document.querySelector<HTMLElement>(`[data-key="${focus}"]`)?.focus({ preventScroll: true });
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen, focus]);

  // -- selection -----------------------------------------------------------------
  const [selection, dispatch] = useReducer(selectionReducer, []);
  const selectableNumbers = useMemo(
    () => prs.filter((p) => selectable(p)).map((p) => p.number),
    [prs],
  );
  useEffect(() => dispatch({ t: "keep", prs: selectableNumbers }), [selectableNumbers]);
  const toggleSelected = useCallback(
    (pr: number) => {
      if (selectableNumbers.includes(pr)) dispatch({ t: "toggle", pr });
    },
    [selectableNumbers],
  );

  // -- a deep link shows its landing; "Open" there shows the PR in the list --
  const landing = isLinkRoute(route) ? route : null;
  const openInList = useCallback(
    (pr: number) => {
      setFocusState({ key: prKey(pr), pr });
      setPrefs((p) => ({ ...p, open: true }));
      scrollOnFocus.current = true;
      go({ view: "list" });
    },
    [go],
  );

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
  const latest = useRef({ view, keys, columnKeys, focus, panelOpen, selection, prs, onLanding });
  useLayoutEffect(() => {
    latest.current = { view, keys, columnKeys, focus, panelOpen, selection, prs, onLanding };
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
      // The landing of a deep link has no rows to move through.
      if (s.onLanding) return;
      const board = s.view === "board";
      const focusedPr = prOfKey(s.focus);
      const pr = focusedPr === null ? null : s.prs.find((p) => p.number === focusedPr);
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
          if (pr && selectable(pr)) dispatch({ t: "toggle", pr: pr.number });
          return;
        case "s":
          if (s.selection.length) return openBatch(s.selection);
          if (pr?.ask) return openBatch([pr.number]);
          return;
        case "e":
          if (pr?.fyiForMe) ackFyi(pr.number);
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
  const dismissLegend = () => {
    writeJson(browserStorage(), STORAGE_KEYS.legend, "dismissed");
    setLegendDismissed(true);
  };
  const showLegend = !legendDismissed && (firstRun || setup?.state === "pending");

  const since = useLastVisit(now);
  const state: DashboardState = {
    snapshot,
    me,
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

  const list = (
    <div className="h-full overflow-auto" id="list-scroll">
      {!firstRun && (
        <SubBar
          view={view === "chrono" ? "chrono" : "list"}
          onView={(v) => go({ view: v })}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen(!panelOpen)}
        />
      )}
      <main className="mx-auto max-w-[1000px] px-6 pt-[22px] pb-[110px]">
        {showLegend && <Legend onDismiss={dismissLegend} />}
        <KeyNote signer={signer} setup={setup} onSetup={() => go({ view: "setup" })} />
        {view === "chrono" && !firstRun ? (
          buckets.map((b) => <BucketSection key={b.id} bucket={b} />)
        ) : firstRun ? (
          <FirstRunLanes unclassified={snapshot.unclassified.length} repo={snapshot.repo} />
        ) : (
          <>
            {needs.count > 0 && merged > 0 && (
              <p className="text-tx3 m-0 mb-[22px] text-[13px]">
                Since {sinceText(since, now, utcOffsetMinutes)}: {merged} merged on their own.
              </p>
            )}
            <LaneSection
              lane={needs}
              hint={needsHint}
              empty={
                <>
                  <b className="text-tx font-semibold">Nothing needs you.</b> No agent is waiting on
                  your signature.
                </>
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

  return (
    <DashboardContext.Provider value={state}>
      <div className="flex h-full flex-col">
        <TopBarShell>
          <Logo />
          <span className="text-tx3 text-[13px]">{snapshot.repo}</span>
          <Segmented
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
            <span className="text-tx3 text-[12.5px]" title="nod serve --fake">
              fake data
            </span>
          )}
          <ShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          <LockChip signer={signer} actions={actions} />
          <Me login={me} people={snapshot.people} onSetup={() => go({ view: "setup" })} />
        </TopBarShell>
        {status !== "open" && (
          <div className="bg-need-bg text-need border-line border-b px-5 py-1.5 text-[12.5px]">
            Reconnecting to nod serve… What you see is from{" "}
            {snapshot.sync.at ? clockTime(snapshot.sync.at, utcOffsetMinutes) : "earlier"}.
          </div>
        )}
        {landing ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <LinkLanding
              route={landing}
              snapshot={{ ...snapshot, prs }}
              signer={signer}
              onOpen={openInList}
              onList={() => go({ view: "list" })}
            />
          </div>
        ) : onBoard ? (
          <>
            <BoardBar group={group} onGroup={chooseGroup} />
            <Board columns={columns} onBackground={() => setDrawerOpen(false)} />
            {drawerOpen && (
              <>
                <div
                  aria-hidden
                  className="pointer-events-none fixed inset-x-0 top-[52px] bottom-0 z-20 bg-[#05070b88]"
                />
                <div className="border-line2 shadow-float fixed top-[52px] right-0 bottom-0 z-20 w-[540px] max-w-full border-l">
                  <DetailPanel pr={shownPr} width={540} onClose={() => setDrawerOpen(false)} />
                </div>
              </>
            )}
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
        <SelectionBar />
      </div>
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
        <section key={lane} className="mb-[34px]" aria-label={title}>
          <LaneHeader lane={lane} title={title} count={0} />
          <EmptyLane>{text}</EmptyLane>
        </section>
      ))}
      {unclassified > 0 && (
        <p className="text-tx3 text-[12.5px] leading-[1.55]">
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

/** The board's columns, by Waiting on (r3 `09`) or by State (r2 `05`), with their asides. */
function boardColumns(
  prs: ReadonlyArray<PrView>,
  group: GroupBy,
  snapshot: Snapshot,
  now: number,
  keyNote: string | null,
): ReadonlyArray<BoardColumnView> {
  const merged = prs.filter((p) => p.mergedAt !== null);
  const doneAside =
    merged.length && merged.every((p) => now - p.mergedAt! <= DAY) ? "last 24h" : "last 7 days";
  if (group === "state")
    return stateBoardView(prs).map((c) => ({
      id: `state:${c.id}`,
      title: c.title,
      count: c.count,
      you: c.id === "signature" && !keyNote,
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
    // Without a key that can sign it is a muted column: nothing in it is actionable yet.
    you: c.kind === "me" && !c.note,
    aside:
      c.kind === "me" ? (
        <SignColumn column={c} />
      ) : c.kind === "done" ? (
        doneAside
      ) : c.kind === "person" || c.kind === "anyone" ? (
        oldestWait(c, now)
      ) : null,
    items: c.items,
    footer: alsoText(c, prs, snapshot),
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

/** "also #485, after you": PRs in another column that wait on this one later. */
function alsoText(column: Column, prs: ReadonlyArray<PrView>, snapshot: Snapshot): string | null {
  if (!column.also.length) return null;
  const after = column.also.map((n) => {
    const first = prs.find((p) => p.number === n)?.waitingOn[0];
    const who =
      !first || first.kind === "me"
        ? "you"
        : first.kind === "person"
          ? first.login.toLowerCase() === snapshot.me.toLowerCase()
            ? "you"
            : shortName(first.login, snapshot.people)
          : "the agent";
    return `#${n}, after ${who}`;
  });
  return `also ${after.join("; ")}`;
}

/** "Sign…" on my column: the batch dialog with the column's selection, or the whole column. */
function SignColumn({ column }: { column: Column }) {
  const { openBatch, selection } = useDashboard();
  const mine = prsOf(column).filter((p) => p.ask);
  if (!mine.length) return null;
  const picked = selection.filter((n) => mine.some((p) => p.number === n));
  const numbers = picked.length ? picked : mine.map((p) => p.number);
  return (
    <button
      type="button"
      onClick={() => openBatch(numbers)}
      title={picked.length ? "Sign the selected ones (s)" : "Sign everything in this column"}
      className="bg-need border-need text-on-need inline-flex h-[26px] items-center rounded-lg border px-2.5 text-xs font-semibold"
    >
      {picked.length ? `Sign ${picked.length}…` : "Sign…"}
    </button>
  );
}

/**
 * The pending-key note (r3 `17`): my key waits for the PR that enrols it, or
 * is not enrolled at all. Read everything, sign nothing, until it merges.
 */
function KeyNote({
  signer,
  setup,
  onSetup,
}: {
  signer: SignerState | null;
  setup: SetupStatus | null;
  onSetup: () => void;
}) {
  if (!signer) return null;
  const box =
    "border-line2 text-tx2 mb-[26px] rounded-[10px] border border-dashed px-3.5 py-2.5 text-[13px] leading-[1.55]";
  const link = "underline underline-offset-2 hover:text-tx";
  if (signer.state === "no-key")
    return (
      <div className={box} role="note">
        <b className="text-tx font-semibold">You have no signing key yet.</b> You can read
        everything; to nod, create a key and enrol it in this repository.{" "}
        <button type="button" className={link} onClick={onSetup}>
          Create it
        </button>
      </div>
    );
  const enrolment = signer.key.enrolment;
  if (enrolment.state === "active") return null;
  if (enrolment.state === "not-enrolled")
    return (
      <div className={box} role="note">
        <b className="text-tx font-semibold">Your key is not enrolled.</b> Until a pull request adds
        it to <code className="font-mono text-xs">.nod/allowed_signers</code> you can read
        everything and sign nothing.{" "}
        <button type="button" className={link} onClick={onSetup}>
          Enrol it
        </button>
      </div>
    );
  const pr = enrolment.pr;
  const viaSetup = pr !== null && setup?.setupPr?.number === pr.number;
  return (
    <div className={box} role="note">
      <b className="text-tx font-semibold">Your key is pending.</b>{" "}
      {viaSetup
        ? `Setup PR #${pr.number} adds the policy, the verifier and your public key. Until it merges nothing is gated and your signatures do not count yet.`
        : `${pr ? `Enrolment PR #${pr.number}` : "A pull request"} adds your public key to .nod/allowed_signers, and a teammate has to nod it. Until it merges you can read everything and your signatures do not count yet.`}{" "}
      {pr && (
        <a href={pr.url} target="_blank" rel="noreferrer" className={link}>
          Open #{pr.number}
        </a>
      )}
    </div>
  );
}
