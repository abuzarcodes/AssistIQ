import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast } from '@/components/ui/toast';
import { Tabs } from '@/components/ui/tabs';

/**
 * CP11 — shared feedback and tab semantics.
 *
 * Toasts are the app's only global announcement channel, so their live-region roles are
 * part of the contract. Tabs are used in knowledge and AI Lab; roving focus plus
 * Arrow/Home/End navigation keeps them usable without a mouse.
 */

function ToastTrigger({ variant }: { variant: 'success' | 'error' }) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() => toast(variant === 'error' ? 'Something failed' : 'Saved', variant)}
    >
      Show {variant}
    </button>
  );
}

describe('ToastProvider live regions', () => {
  it('announces success in a status region and dismisses it', () => {
    render(
      <ToastProvider>
        <ToastTrigger variant="success" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show success' }));

    expect(
      screen.getByRole('region', { name: 'Notifications' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Saved');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('announces errors in an alert region', () => {
    render(
      <ToastProvider>
        <ToastTrigger variant="error" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show error' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Something failed');
  });
});

describe('Tabs semantics', () => {
  const tabs = [
    { id: 'one', label: 'One', content: <p>Panel one</p> },
    { id: 'two', label: 'Two', content: <p>Panel two</p> },
    { id: 'three', label: 'Three', content: <p>Panel three</p> },
  ];

  it('wires tablist, tabs and panel together', () => {
    render(<Tabs tabs={tabs} defaultTab="one" ariaLabel="Sections" />);

    const tabList = screen.getByRole('tablist', { name: 'Sections' });
    const tabButtons = screen.getAllByRole('tab');
    const panel = screen.getByRole('tabpanel');

    expect(tabList).toBeInTheDocument();
    expect(tabButtons).toHaveLength(3);
    expect(tabButtons[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabButtons[0]).toHaveAttribute('tabindex', '0');
    expect(tabButtons[1]).toHaveAttribute('tabindex', '-1');
    expect(panel).toHaveTextContent('Panel one');
    expect(panel).toHaveAttribute('aria-labelledby', tabButtons[0].id);
  });

  it('moves selection and focus with Arrow, Home and End', () => {
    render(<Tabs tabs={tabs} defaultTab="one" ariaLabel="Sections" />);

    const first = screen.getByRole('tab', { name: 'One' });
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowRight' });

    let current = screen.getByRole('tab', { name: 'Two' });
    expect(current).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(current);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel two');

    fireEvent.keyDown(current, { key: 'End' });

    current = screen.getByRole('tab', { name: 'Three' });
    expect(current).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(current);

    fireEvent.keyDown(current, { key: 'Home' });

    current = screen.getByRole('tab', { name: 'One' });
    expect(current).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(current);
  });
});
