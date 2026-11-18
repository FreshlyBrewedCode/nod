/**
 * The dashboard: the top bar, the list (by attention or chronological) with
 * its resizable detail panel, the board placeholder, the selection bar and
 * the keyboard. Owns the list's state (focus, selection, open clusters, the
 * panel) and hands it to rows through `useDashboard`.
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
  chronologicalView,
  mergedOnTheirOwn,
  oldestWaitingSince,
  selectable,
  type Item,
} from "../../shared/attention";
import type { SetupStatus, SignerState, Snapshot, Welcome } from "../../shared/protocol";
import type { Actions } from "@/hooks/use-connection";
import { MINUTE, useNow, useUtcOffset } from "@/hooks/use-clock";
import { DashboardContext, type DashboardState } from "@/hooks/use-dashboard";
import type { Status } from "@/lib/connection";
import { clusterKey, moveFocus, prKey, prOfKey, reconcileFocus, type FocusKey } from "@/lib/focus";
import { clampPanelWidth, panelMax, PANEL_MIN, readPanelPrefs, type PanelPrefs } from "@/lib/panel";
import { viewOf, type Route, type View } from "@/lib/route";
import { selectionReducer } from "@/lib/selection";
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
import { DetailPanel } from "./detail-panel";
import { Legend } from "./legend";
import { BucketSection, EmptyLane, LaneHeader, LaneSection } from "./lists";
import { SelectionBar } from "./selection-bar";
import { SubBar } from "./sub-bar";
import { LockChip, Logo, Me, Segmented, ShortcutsHelp, TopBarShell } from "./top-bar";
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
    <BatchProvider prs={props.snapshot.prs}>
      <DashboardInner {...props} />
    </BatchProvider>
  );
}

const DAY = 24 * 60 * MINUTE;

/** The visible rows in screen order, the rows of open clusters included. */
function rowKeys(items: ReadonlyArray<Item>, expanded: ReadonlySet<string>): FocusKey[] {
  return items.flatMap((item) =>
    item.kind === "pr"
      ? [prKey(item.pr.number)]
      : [
          clusterKey(item.id),
          ...(expanded.has(item.id) ? item.prs.map((p) => prKey(p.number)) : []),
        ],
  );
}

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
  const keys = useMemo(() => {
    if (view === "board") return [];
    const items =
      view === "chrono" ? buckets.flatMap((b) => b.items) : lanes.flatMap((l) => l.items);
    return rowKeys(items, expanded);
  }, [view, lanes, buckets, expanded]);

  // -- the panel -----------------------------------------------------------------
  const windowWidth = useWindowWidth();
  const [prefs, setPrefs] = useState<PanelPrefs>(() =>
    readPanelPrefs(readJson(browserStorage(), STORAGE_KEYS.panel)),
  );
  useEffect(() => {
    const t = setTimeout(() => writeJson(browserStorage(), STORAGE_KEYS.panel, prefs), 200);
    return () => clearTimeout(t);
  }, [prefs]);
  const panelOpen = prefs.open && view !== "board";
  const panelWidth = clampPanelWidth(prefs.width, windowWidth);
  const setPanelOpen = useCallback((open: boolean) => setPrefs((p) => ({ ...p, open })), []);
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
  const focus = focusState.key ?? (panelOpen ? (keys[0] ?? null) : null);
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

  // -- a deep link focuses its PR and opens the panel, then the URL is the list's --
  const [linked, setLinked] = useState<Route | null>(null);
  if (route.view === "pr" && route !== linked) {
    setLinked(route);
    if (route.repo.toLowerCase() === snapshot.repo.toLowerCase()) {
      setFocusState({ key: prKey(route.number), pr: route.number });
      setPrefs((p) => ({ ...p, open: true }));
    }
  }
  useEffect(() => {
    if (route.view !== "pr") return;
    scrollOnFocus.current = true;
    go({ view: "list" }, { replace: true });
  }, [route, go]);

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
  const latest = useRef({ view, keys, focus, panelOpen, selection, prs });
  useLayoutEffect(() => {
    latest.current = { view, keys, focus, panelOpen, selection, prs };
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
      if (s.view === "board") return;
      const focusedPr = prOfKey(s.focus);
      const pr = focusedPr === null ? null : s.prs.find((p) => p.number === focusedPr);
      const move = (delta: number) => {
        e.preventDefault();
        scrollOnFocus.current = true;
        setFocus(moveFocus(s.keys, s.focus, delta));
      };
      switch (e.key) {
        case "j":
        case "ArrowDown":
          return move(1);
        case "k":
        case "ArrowUp":
          return move(-1);
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
        {/* SLOT: the pending-key note (onboarding task): "Your key is pending. Setup PR #494 …" */}
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
          <LockChip signer={signer} onLock={() => void actions.lock().catch(() => {})} />
          <Me login={me} people={snapshot.people} />
        </TopBarShell>
        {status !== "open" && (
          <div className="bg-need-bg text-need border-line border-b px-5 py-1.5 text-[12.5px]">
            Reconnecting to nod serve… What you see is from{" "}
            {snapshot.sync.at ? clockTime(snapshot.sync.at, utcOffsetMinutes) : "earlier"}.
          </div>
        )}
        {view === "board" ? (
          <BoardPlaceholder />
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel id="list" minSize="30%">
              {list}
            </ResizablePanel>
            {panelOpen && (
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

function BoardPlaceholder() {
  return (
    <main className="mx-auto mt-24 max-w-[520px] px-6 text-center">
      <div className="border-line2 text-tx3 rounded-xl border border-dashed px-[18px] py-[22px]">
        <b className="text-tx font-semibold">The board comes next.</b> Columns by who each pull
        request waits on. Until then, the list has everything:{" "}
        <span className="font-mono">g l</span>.
      </div>
    </main>
  );
}
