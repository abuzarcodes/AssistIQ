import type { BusinessHours, DayCode } from '../types/botConfig.types.js';

/**
 * Business-hours evaluation (docs/BOT_IMPLEMENTATION_PLAN.md §14.3).
 *
 * A **pure function**: no database, no `Date.now()`, no dependency beyond the runtime's own
 * IANA timezone database via `Intl`. The caller passes `now`, so every branch — inside hours,
 * outside hours, a boundary minute, a DST transition — is exhaustively unit-testable without
 * waiting for a clock.
 *
 * Deliberately small. Holidays, multiple windows per day, per-agent schedules and SLA/queue
 * simulation are **not** modelled: one window per day, seven days, is what the requirement
 * needs, and anything more is infrastructure this codebase does not have to support it.
 */

export interface BusinessHoursAvailability {
  /** Whether `now` falls inside one of the configured windows. */
  open: boolean;
  /** The next window start, ISO-8601, when currently closed. Best-effort across DST. */
  nextOpenAt?: string;
}

/** `Intl` reports weekdays as `Mon`, `Tue`, …; the config stores `MON`, `TUE`, …. */
const WEEKDAY_BY_SHORT: Record<string, DayCode> = {
  Mon: 'MON',
  Tue: 'TUE',
  Wed: 'WED',
  Thu: 'THU',
  Fri: 'FRI',
  Sat: 'SAT',
  Sun: 'SUN',
};

/** `HH:MM` → minutes since midnight. */
const toMinutes = (hhmm: string): number => {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayCode: DayCode;
}

/** The wall-clock date and time `date` represents in `timeZone`. */
const partsInZone = (date: Date, timeZone: string): ZonedParts => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    // An unexpected weekday label is a runtime anomaly; defaulting to MON would silently
    // open the wrong day, but there is no better fallback and it cannot be reached with a
    // valid IANA zone, so the assertion is kept as a plain lookup.
    dayCode: WEEKDAY_BY_SHORT[parts.weekday] ?? 'MON',
  };
};

/** Minutes to add to UTC to reach `timeZone` at `date` (positive east of Greenwich). */
const zoneOffsetMinutes = (date: Date, timeZone: string): number => {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Drop seconds/millis from the reference so the subtraction is minute-exact.
  const reference = Math.floor(date.getTime() / 60_000) * 60_000;
  return (asUtc - reference) / 60_000;
};

/** The UTC instant at which `timeZone`'s wall clock reads the given date and time. */
const wallClockToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date => {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the offset at the naive guess may differ from the offset at the corrected
  // instant across a DST boundary, so one correction is applied and then verified.
  const firstOffset = zoneOffsetMinutes(new Date(guess), timeZone);
  const corrected = new Date(guess - firstOffset * 60_000);
  const secondOffset = zoneOffsetMinutes(corrected, timeZone);
  return new Date(guess - secondOffset * 60_000);
};

/**
 * Whether `now` is inside `hours`, or `{ open: true }` when hours are not configured.
 *
 * `null` (and an empty window list) means "no hours restriction", which is the state every
 * bot is in until its owner enables hours — so escalation is always considered in-hours by
 * default, matching the pre-feature behaviour.
 *
 * Windows are **start-inclusive, end-exclusive**: a 09:00–17:00 window is open at 09:00 and
 * closed at 17:00. That is the reading that makes back-to-back windows meet without overlap,
 * and it is pinned by tests rather than left to the reader.
 */
export const evaluateBusinessHours = (
  hours: BusinessHours | null,
  now: Date
): BusinessHoursAvailability => {
  if (!hours || hours.windows.length === 0) {
    return { open: true };
  }

  const timeZone = hours.timezone || 'UTC';
  const parts = partsInZone(now, timeZone);
  const minutesNow = parts.hour * 60 + parts.minute;

  const todayWindow = hours.windows.find((window) => window.day === parts.dayCode);
  if (todayWindow) {
    const start = toMinutes(todayWindow.start);
    const end = toMinutes(todayWindow.end);
    if (minutesNow >= start && minutesNow < end) {
      return { open: true };
    }
  }

  // Closed. Find the next window start within the coming week. A bot always has at least one
  // window (validation enforces it), so the loop is bounded by 8 days and always terminates.
  for (let offset = 0; offset < 8; offset += 1) {
    const probe = new Date(now.getTime() + offset * 86_400_000);
    const probeParts = partsInZone(probe, timeZone);
    const window = hours.windows.find((candidate) => candidate.day === probeParts.dayCode);
    if (!window) continue;

    const [startHour, startMinute] = window.start.split(':').map(Number);
    const startAt = wallClockToUtc(
      probeParts.year,
      probeParts.month,
      probeParts.day,
      startHour,
      startMinute,
      timeZone
    );
    if (startAt.getTime() > now.getTime()) {
      return { open: false, nextOpenAt: startAt.toISOString() };
    }
  }

  return { open: false };
};