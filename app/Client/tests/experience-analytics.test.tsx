import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExperienceAnalyticsTab } from '@/app/w/[workspaceId]/bots/[botId]/experience/_components/experience-analytics-tab';
import type { ExperienceDeployment } from '@/lib/api/experience';
import type { DeploymentAnalytics } from '@/lib/api/deployments';

/**
 * CP-13.6 – CP-13.8 — the analytics dashboard.
 *
 * Totals are summed from the same per-deployment rows the table renders, so
 * the cards and the breakdown agree by construction. Ranges refetch with the
 * right bounds, zeros read as quiet (not broken), and failures stay inline.
 */

vi.mock('@/lib/api/deployments', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api/deployments')>();
  return {
    ...original,
    getDeploymentAnalytics: vi.fn(),
  };
});

const api = await import('@/lib/api/deployments');

function deployment(
  id: string,
  format: ExperienceDeployment['format'],
): ExperienceDeployment {
  return {
    id,
    experienceId: 'exp-1',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    format,
    status: 'PUBLISHED',
    slug: null,
    enabled: true,
    unpublishedAt: null,
    publishEpoch: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

const DEPLOYMENTS = [
  deployment('dep-hosted', 'HOSTED_PAGE'),
  deployment('dep-widget', 'WIDGET'),
];

function row(
  deploymentId: string,
  format: DeploymentAnalytics['format'],
  metrics: Partial<DeploymentAnalytics['metrics']> = {},
): DeploymentAnalytics {
  return {
    deploymentId,
    format,
    period: { startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-31T00:00:00.000Z' },
    metrics: {
      pageViews: 0,
      chatStarts: 0,
      conversationsCreated: 0,
      aiResolved: 0,
      humanHandoff: 0,
      conversationsResolved: 0,
      ...metrics,
    },
  };
}

const renderTab = () =>
  render(<ExperienceAnalyticsTab botId="bot-1" deployments={DEPLOYMENTS} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getDeploymentAnalytics).mockImplementation(
    async (_botId, deploymentId) => {
      if (deploymentId === 'dep-hosted') {
        return row('dep-hosted', 'HOSTED_PAGE', {
          pageViews: 120,
          chatStarts: 40,
          conversationsCreated: 40,
          aiResolved: 30,
          humanHandoff: 5,
          conversationsResolved: 32,
        });
      }
      return row('dep-widget', 'WIDGET', {
        pageViews: 80,
        chatStarts: 20,
        conversationsCreated: 25,
        aiResolved: 15,
        humanHandoff: 3,
        conversationsResolved: 16,
      });
    },
  );
});

describe('Experience Analytics tab', () => {
  it('sums per-deployment rows into the metric cards', async () => {
    renderTab();

    expect(await screen.findByText('200')).toBeInTheDocument();
    expect(screen.getByText('60')).toBeInTheDocument();
    expect(screen.getByText('65')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('48')).toBeInTheDocument();
  });

  it('breaks metrics down by deployment format', async () => {
    renderTab();

    const table = await screen.findByRole('table');
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Hosted page' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Widget' })).toBeInTheDocument();
    expect(screen.getByText('Oct 1, 2026 – Oct 31, 2026')).toBeInTheDocument();
  });

  it('refetches with bounds when the range changes', async () => {
    renderTab();
    await screen.findByText('200');

    fireEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }));

    await waitFor(() => {
      const calls = vi.mocked(api.getDeploymentAnalytics).mock.calls;
      const last = calls[calls.length - 1];
      expect(last?.[2]).toMatchObject({ endDate: expect.any(String) });
      expect(last?.[2]?.startDate).not.toBe('2020-01-01T00:00:00.000Z');
    });

    fireEvent.click(screen.getByRole('radio', { name: 'All time' }));
    await waitFor(() => {
      const calls = vi.mocked(api.getDeploymentAnalytics).mock.calls;
      const last = calls[calls.length - 1];
      expect(last?.[2]).toEqual({ startDate: '2020-01-01T00:00:00.000Z' });
    });
  });

  it('reads zeros as quiet, not broken', async () => {
    vi.mocked(api.getDeploymentAnalytics).mockResolvedValue(
      row('dep-hosted', 'HOSTED_PAGE'),
    );
    render(
      <ExperienceAnalyticsTab
        botId="bot-1"
        deployments={[deployment('dep-hosted', 'HOSTED_PAGE')]}
      />,
    );

    expect(
      await screen.findByText(/No activity in this period yet/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('surfaces a failed load inline', async () => {
    vi.mocked(api.getDeploymentAnalytics).mockRejectedValueOnce(
      new Error('down'),
    );
    renderTab();

    expect(await screen.findByText(/Could not load analytics/)).toBeInTheDocument();
  });
});
