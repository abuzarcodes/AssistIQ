'use client';

import { useEffect, useState } from 'react';
import { RadioGroup } from '@/components/ui/radio-group';
import {
  getDeploymentAnalytics,
  type AnalyticsRange,
  type DeploymentAnalytics,
  type DeploymentMetrics,
} from '@/lib/api/deployments';
import type { ExperienceDeployment } from '@/lib/api/experience';

interface ExperienceAnalyticsTabProps {
  botId: string;
  deployments: ExperienceDeployment[];
}

type AnalyticsRangeId = '7d' | '30d' | 'all';

const RANGE_OPTIONS: { value: AnalyticsRangeId; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

/**
 * Map the range control onto the analytics query. The server defaults an empty
 * range to the last 30 days, so "Last 30 days" sends nothing and the other two
 * send explicit bounds.
 */
function rangeToQuery(range: AnalyticsRangeId): AnalyticsRange {
  if (range === '7d') {
    const end = new Date();
    return {
      startDate: new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      endDate: end.toISOString(),
    };
  }
  if (range === 'all') {
    return { startDate: '2020-01-01T00:00:00.000Z' };
  }
  return {};
}

const METRIC_CARDS: {
  key: keyof DeploymentMetrics;
  label: string;
  hint: string;
}[] = [
  { key: 'pageViews', label: 'Page views', hint: 'Hosted and embed loads' },
  { key: 'chatStarts', label: 'Chat starts', hint: 'First message sent' },
  { key: 'conversationsCreated', label: 'Conversations', hint: 'Sessions opened' },
  { key: 'aiResolved', label: 'AI resolved', hint: 'Answered without handoff' },
  { key: 'humanHandoff', label: 'Human handoffs', hint: 'Escalated to support' },
  { key: 'conversationsResolved', label: 'Resolved', hint: 'Marked resolved' },
];

function formatDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
}

function formatName(format: string): string {
  if (format === 'HOSTED_PAGE') return 'Hosted page';
  if (format === 'WIDGET') return 'Widget';
  if (format === 'IFRAME') return 'Iframe';
  return format;
}

/**
 * The Analytics tab (CP-13.6 – CP-13.8).
 *
 * Totals are summed from the per-deployment breakdown, so the cards and the
 * table can never disagree — both render the same fetched rows. Zeros are real
 * zeros: a quiet deployment reads "No activity in this period yet", never a
 * placeholder chart. Preview and test traffic never reaches these endpoints,
 * so nothing here needs filtering out.
 */
export function ExperienceAnalyticsTab({
  botId,
  deployments,
}: ExperienceAnalyticsTabProps) {
  const [range, setRange] = useState<AnalyticsRangeId>('30d');
  const [rows, setRows] = useState<DeploymentAnalytics[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Mount and range fetch: the tab remounts on every open.
  useEffect(() => {
    let active = true;
    const query = rangeToQuery(range);

    void (async () => {
      try {
        const results = await Promise.all(
          deployments.map((deployment) =>
            getDeploymentAnalytics(botId, deployment.id, query),
          ),
        );
        if (active) {
          setRows(results);
          setFailed(false);
        }
      } catch {
        if (active) {
          setRows(null);
          setFailed(true);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [botId, deployments, range]);

  const totals: DeploymentMetrics = {
    pageViews: 0,
    chatStarts: 0,
    conversationsCreated: 0,
    aiResolved: 0,
    humanHandoff: 0,
    conversationsResolved: 0,
  };
  for (const row of rows ?? []) {
    (Object.keys(totals) as (keyof DeploymentMetrics)[]).forEach((key) => {
      totals[key] += row.metrics[key];
    });
  }

  const period = rows?.[0]?.period;
  const allZero =
    rows !== null &&
    (Object.keys(totals) as (keyof DeploymentMetrics)[]).every(
      (key) => totals[key] === 0,
    );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <RadioGroup<AnalyticsRangeId>
          name="experience-analytics-range"
          label="Date range"
          value={range}
          options={RANGE_OPTIONS}
          onChange={setRange}
        />
        {period && (
          <p className="text-xs text-muted-foreground">
            {`${formatDay(period.startDate)} – ${formatDay(period.endDate)}`}
          </p>
        )}
      </div>

      {failed ? (
        <p role="alert" className="mt-6 text-xs text-destructive">
          Could not load analytics. Reopening this tab tries again.
        </p>
      ) : rows === null ? (
        <div
          role="status"
          aria-label="Loading analytics"
          className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <span
              key={index}
              className="block h-20 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      ) : deployments.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No deployments yet. Analytics appear once a format is deployed.
        </p>
      ) : allZero ? (
        <p className="mt-6 rounded-xl border border-border bg-card px-4 py-6 text-center text-[13px] text-muted-foreground">
          No activity in this period yet. Metrics appear here once visitors
          start chatting through a live deployment.
        </p>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {METRIC_CARDS.map((card) => (
              <div
                key={card.key}
                className="rounded-xl border border-border bg-card px-4 py-3"
              >
                <dt className="text-xs text-muted-foreground">{card.label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                  {totals[card.key].toLocaleString()}
                </dd>
                <dd className="mt-0.5 text-[11px] text-muted-foreground">
                  {card.hint}
                </dd>
              </div>
            ))}
          </dl>

          <h3 className="mt-8 text-sm font-semibold text-foreground">
            By deployment
          </h3>
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] border-collapse bg-card text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Deployment
                  </th>
                  {METRIC_CARDS.map((card) => (
                    <th
                      key={card.key}
                      scope="col"
                      className="px-3 py-2 text-right font-medium tabular-nums"
                    >
                      {card.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.deploymentId}
                    className="border-b border-border last:border-0"
                  >
                    <th
                      scope="row"
                      className="px-3 py-2 text-left font-medium text-foreground"
                    >
                      {formatName(row.format)}
                    </th>
                    {METRIC_CARDS.map((card) => (
                      <td
                        key={card.key}
                        className="px-3 py-2 text-right tabular-nums text-foreground"
                      >
                        {row.metrics[card.key].toLocaleString()}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
