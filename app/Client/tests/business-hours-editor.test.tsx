import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BusinessHoursEditor } from '@/app/dashboard/bots/[botId]/_components/business-hours-editor';
import type { BusinessHours } from '@/lib/api/botConfig';

/**
 * Checkpoint 6 — the business-hours editor (§14.3, §16.1).
 *
 * The editor must never let the owner assemble a schedule the server will reject: a window
 * that ends before it starts, or two windows on the same day. Both surface inline.
 */
const value: BusinessHours = {
  timezone: 'UTC',
  windows: [{ day: 'MON', start: '09:00', end: '17:00' }],
  afterHoursBehavior: 'MESSAGE_AND_ESCALATE',
  afterHoursMessage: null,
};

describe('BusinessHoursEditor', () => {
  it('enabling hours produces a valid starter schedule', () => {
    const onChange = vi.fn();
    render(<BusinessHoursEditor value={null} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Enable business hours'));

    const next = onChange.mock.calls[0][0] as BusinessHours;
    expect(next.windows.length).toBeGreaterThan(0);
    expect(next.timezone).toBeTruthy();
  });

  it('disabling hours clears them', () => {
    const onChange = vi.fn();
    render(<BusinessHoursEditor value={value} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Enable business hours'));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('flags a window that ends before it starts', () => {
    render(
      <BusinessHoursEditor
        value={{ ...value, windows: [{ day: 'MON', start: '17:00', end: '09:00' }] }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText(/start before it ends/i)).toBeInTheDocument();
  });

  it('flags two windows on the same day', () => {
    render(
      <BusinessHoursEditor
        value={{
          ...value,
          windows: [
            { day: 'MON', start: '09:00', end: '12:00' },
            { day: 'MON', start: '13:00', end: '17:00' },
          ],
        }}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText(/one window per day/i)).toBeInTheDocument();
  });
});