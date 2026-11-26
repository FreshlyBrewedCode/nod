/**
 * What the dashboard says while the socket is not open. A short drop (a
 * phone waking, a restart of `nod serve`) says nothing: the last view stays,
 * and the socket usually is back before anyone looks. Only a longer one gets
 * a quiet hint, and a longer one still says plainly that the view is old.
 */

export type Notice = "none" | "quiet" | "stale";

/** How long the socket has been down before each notice, in ms. */
export const NOTICE_STEPS: ReadonlyArray<{ readonly after: number; readonly notice: Notice }> = [
  { after: 1500, notice: "quiet" },
  { after: 10_000, notice: "stale" },
];

/** The notice for a socket that has not been open for `downMs` (null: it is open). */
export function noticeFor(downMs: number | null): Notice {
  if (downMs === null) return "none";
  let notice: Notice = "none";
  for (const step of NOTICE_STEPS) if (downMs >= step.after) notice = step.notice;
  return notice;
}
