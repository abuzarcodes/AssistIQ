import { describe, it, expect } from 'vitest';
import { evaluateBusinessHours } from '../src/services/businessHours.js';
import type { BusinessHours, BusinessHoursWindow } from '../src/types/botConfig.types.js';

/**
 * Checkpoint 5 — the pure business-hours evaluator (§14.3, §23.1).
 *
 * Every branch is exercised without a clock, including the boundaries that are easy to get
 * wrong and invisible when wrong: start-inclusive/end-exclusive, a timezone that is not UTC,
 * and both DST transitions. A timezone bug here escalates the wrong customers at the wrong
 * hour and nobody notices until someone complains.
 */

const hours = (
  windows: BusinessHoursWindow[],
  overrides: Partial<BusinessHours> = {}
): BusinessHours => ({
  timezone: 'UTC',
  windows,
  afterHoursBehavior: 'MESSAGE_AND_ESCALATE',
  afterHoursMessage: null,
  ...overrides,
});

const mon = (start: string, end: string): BusinessHoursWindow => ({ day: 'MON', start, end });
const sun = (start: string, end: string): BusinessHoursWindow => ({ day: 'SUN', start, end });

describe('evaluateBusinessHours — the no-hours default', () => {
  it('treats absent hours as always open', () => {
    expect(evaluateBusinessHours(null, new Date('2026-07-06T03:00:00Z'))).toEqual({ open: true });
  });

  it('treats an empty window list as always open', () => {
    expect(evaluateBusinessHours(hours([]), new Date('2026-07-06T03:00:00Z'))).toEqual({
      open: true,
    });
  });
});

describe('evaluateBusinessHours — inside and outside', () => {
  // 2026-07-06 is a Monday; Europe/Berlin is UTC+2 (CEST) in July.
  const berlinMonday = () =>
    hours([mon('09:00', '17:00')], { timezone: 'Europe/Berlin' });

  it('is open in the middle of a window', () => {
    expect(evaluateBusinessHours(berlinMonday(), new Date('2026-07-06T12:00:00Z'))).toEqual({
      open: true,
    });
  });

  it('is open at the start minute (start is inclusive)', () => {
    // 07:00Z is 09:00 in Berlin.
    expect(evaluateBusinessHours(berlinMonday(), new Date('2026-07-06T07:00:00Z'))).toEqual({
      open: true,
    });
  });

  it('is closed at the end minute (end is exclusive)', () => {
    // 15:00Z is 17:00 in Berlin.
    expect(evaluateBusinessHours(berlinMonday(), new Date('2026-07-06T15:00:00Z')).open).toBe(
      false
    );
  });

  it('reports the next open time when closed before the window', () => {
    const result = evaluateBusinessHours(berlinMonday(), new Date('2026-07-06T06:59:00Z'));
    expect(result.open).toBe(false);
    expect(result.nextOpenAt).toBe('2026-07-06T07:00:00.000Z');
  });

  it('reports the next day’s open time when the window has passed', () => {
    // Monday 18:00 Berlin — the Monday window is over.
    const result = evaluateBusinessHours(berlinMonday(), new Date('2026-07-06T16:00:00Z'));
    expect(result.open).toBe(false);
    // The only window is Monday, so the next open is the following Monday.
    expect(result.nextOpenAt).toBe('2026-07-13T07:00:00.000Z');
  });

  it('is closed on a day with no window', () => {
    // 2026-07-07 is a Tuesday; the config only opens Mondays.
    expect(evaluateBusinessHours(berlinMonday(), new Date('2026-07-07T12:00:00Z')).open).toBe(
      false
    );
  });
});

describe('evaluateBusinessHours — timezone offsets', () => {
  it('uses the configured zone, not the server’s', () => {
    // 2026-01-05 is a Monday. New York is UTC-5 in January, so 14:00Z is 09:00 local.
    const newYork = hours([mon('09:00', '17:00')], { timezone: 'America/New_York' });
    expect(evaluateBusinessHours(newYork, new Date('2026-01-05T14:00:00Z')).open).toBe(true);
    // 15:00Z is 10:00 local — still open; 13:00Z is 08:00 local — closed.
    expect(evaluateBusinessHours(newYork, new Date('2026-01-05T13:00:00Z')).open).toBe(false);
  });
});

describe('evaluateBusinessHours — DST transitions', () => {
  it('stays open across the spring-forward gap', () => {
    // 2026-03-08 is the US spring-forward Sunday: 02:00 local jumps to 03:00.
    const newYork = hours([sun('01:00', '04:00')], { timezone: 'America/New_York' });
    // 06:00Z = 01:00 EST (open); 07:00Z = 03:00 EDT (still open, 02:00 never existed).
    expect(evaluateBusinessHours(newYork, new Date('2026-03-08T06:00:00Z')).open).toBe(true);
    expect(evaluateBusinessHours(newYork, new Date('2026-03-08T07:00:00Z')).open).toBe(true);
    // 08:00Z = 04:00 EDT — closed.
    expect(evaluateBusinessHours(newYork, new Date('2026-03-08T08:00:00Z')).open).toBe(false);
  });

  it('stays open across the fall-back repeat hour', () => {
    // 2026-11-01 is the US fall-back Sunday: 02:00 EDT becomes 01:00 EST.
    const newYork = hours([sun('01:00', '04:00')], { timezone: 'America/New_York' });
    // 05:00Z = 01:00 EDT, 06:00Z = 01:00 EST (the repeated hour), both open.
    expect(evaluateBusinessHours(newYork, new Date('2026-11-01T05:00:00Z')).open).toBe(true);
    expect(evaluateBusinessHours(newYork, new Date('2026-11-01T06:00:00Z')).open).toBe(true);
    // 09:00Z = 04:00 EST — closed.
    expect(evaluateBusinessHours(newYork, new Date('2026-11-01T09:00:00Z')).open).toBe(false);
  });
});