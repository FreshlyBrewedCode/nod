/**
 * Times as the dashboard writes them. Pure: `now` and the viewer's UTC offset
 * come in as arguments (the shared clock in `hooks/use-clock.ts` supplies
 * them), so every string is testable.
 */

import { bucketOf, startOfDay } from "../../shared/attention";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The runtime's own offset from UTC at `at`, in minutes (UTC+1 → 60). */
export function localOffset(at: number): number {
  return -new Date(at).getTimezoneOffset();
}

/**
 * A row's age: "now", "6m", "2h", "1d". Minutes below an hour, hours
 * (rounded) below a day, then days.
 */
export function ago(at: number, now: number): string {
  const min = Math.max(0, Math.round((now - at) / MIN));
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** For sentences: "12 minutes", "5 hours", "2 days" (whole units, rounded down). */
export function duration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / MIN));
  if (min < 60) return plural(Math.max(1, min), "minute");
  const hours = Math.floor(min / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The viewer's wall clock at `at`: "19:05". */
export function clockTime(at: number, utcOffsetMinutes: number): string {
  const local = new Date(at + utcOffsetMinutes * MIN);
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function weekday(at: number, utcOffsetMinutes: number): string {
  return WEEKDAYS[new Date(at + utcOffsetMinutes * MIN).getUTCDay()]!;
}

function date(at: number, utcOffsetMinutes: number): string {
  const local = new Date(at + utcOffsetMinutes * MIN);
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]}`;
}

/**
 * The chronological view's time column, by the bucket it falls in: an age
 * today ("6m", "1h"), the clock yesterday ("19:05"), the weekday this week
 * ("Mon"), else the date ("16 Nov").
 */
export function whenText(at: number, now: number, utcOffsetMinutes: number): string {
  switch (bucketOf(at, { now, utcOffsetMinutes })) {
    case "hour":
    case "today":
      return ago(at, now);
    case "yesterday":
      return clockTime(at, utcOffsetMinutes);
    case "week":
      return weekday(at, utcOffsetMinutes);
    case "older":
      return date(at, utcOffsetMinutes);
  }
}

/**
 * A point in time for a sentence: "today 09:10", "yesterday 17:42",
 * "Mon 17:42", "16 Nov".
 */
export function sinceText(at: number, now: number, utcOffsetMinutes: number): string {
  const today = startOfDay(now, utcOffsetMinutes);
  const clock = clockTime(at, utcOffsetMinutes);
  if (at >= today) return `today ${clock}`;
  if (at >= today - DAY) return `yesterday ${clock}`;
  if (at >= today - 6 * DAY) return `${weekday(at, utcOffsetMinutes)} ${clock}`;
  return date(at, utcOffsetMinutes);
}

/** The lock chip's countdown: "14:48", "1:00:00"; "0:00" once it is due. */
export function countdown(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = pad(s % 60);
  return h > 0 ? `${h}:${pad(m)}:${rest}` : `${m}:${rest}`;
}
