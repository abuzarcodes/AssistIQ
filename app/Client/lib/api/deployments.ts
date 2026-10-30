import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api-client';
import type { DeploymentFormat, DeploymentStatus } from './experience';

/**
 * Deployment management API — the live state of a bot's three delivery formats.
 *
 * Kept separate from `experience.ts` so a screen that only manages deployments
 * does not have to import the whole draft surface (and vice versa). Types that
 * are genuinely shared (`DeploymentFormat`, `DeploymentStatus`) live with the
 * experience draft because that is where the lifecycle begins.
 */

export interface DeploymentDomain {
  id: string;
  deploymentId: string;
  domain: string;
  createdAt: string;
}

export interface Deployment {
  id: string;
  experienceId: string;
  botId: string;
  workspaceId: string;
  format: DeploymentFormat;
  status: DeploymentStatus;
  slug: string | null;
  enabled: boolean;
  unpublishedAt: string | null;
  publishEpoch: number;
  domains: DeploymentDomain[];
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentUpdateInput {
  enabled?: boolean;
  slug?: string;
  expectedVersion?: number;
}

export interface DeploymentSnippet {
  deploymentId: string;
  format: DeploymentFormat;
  snippet: string;
  url: string;
}

export interface DeploymentMetrics {
  pageViews: number;
  chatStarts: number;
  conversationsCreated: number;
  aiResolved: number;
  humanHandoff: number;
  conversationsResolved: number;
}

export interface AnalyticsPeriod {
  startDate: string;
  endDate: string;
}

export interface DeploymentAnalytics {
  deploymentId: string;
  format: DeploymentFormat;
  period: AnalyticsPeriod;
  metrics: DeploymentMetrics;
}

export interface DeploymentSummaryMetrics {
  deploymentId: string;
  format: DeploymentFormat;
  botId: string;
  metrics: DeploymentMetrics;
}

export interface WorkspaceAnalytics {
  workspaceId: string;
  period: AnalyticsPeriod;
  deployments: DeploymentSummaryMetrics[];
  totals: DeploymentMetrics;
}

export interface AnalyticsRange {
  /** ISO date/time. The server defaults to the last 30 days when omitted. */
  startDate?: string;
  endDate?: string;
}

function rangeQuery(range?: AnalyticsRange): string {
  if (!range?.startDate && !range?.endDate) return '';
  const query = new URLSearchParams();
  if (range.startDate) query.set('startDate', range.startDate);
  if (range.endDate) query.set('endDate', range.endDate);
  return `?${query.toString()}`;
}

/** GET /bots/:botId/deployments — every format's current deployment state. */
export function listDeployments(botId: string) {
  return apiGet<Deployment[]>(`/bots/${botId}/deployments`);
}

/** PATCH /bots/:botId/deployments/:deploymentId — enable/disable or rename the slug. */
export function updateDeployment(
  botId: string,
  deploymentId: string,
  input: DeploymentUpdateInput,
) {
  return apiPatch<Deployment>(
    `/bots/${botId}/deployments/${deploymentId}`,
    input,
  );
}

/** GET /bots/:botId/deployments/:deploymentId/snippet — install code or public URL. */
export function getDeploymentSnippet(botId: string, deploymentId: string) {
  return apiGet<DeploymentSnippet>(
    `/bots/${botId}/deployments/${deploymentId}/snippet`,
  );
}

/** GET /bots/:botId/deployments/:deploymentId/analytics — attributed metrics. */
export function getDeploymentAnalytics(
  botId: string,
  deploymentId: string,
  range?: AnalyticsRange,
) {
  return apiGet<DeploymentAnalytics>(
    `/bots/${botId}/deployments/${deploymentId}/analytics${rangeQuery(range)}`,
  );
}

/** GET /workspaces/:workspaceId/analytics/deployments — per-deployment breakdown. */
export function getWorkspaceDeploymentAnalytics(
  workspaceId: string,
  range?: AnalyticsRange,
) {
  return apiGet<WorkspaceAnalytics>(
    `/workspaces/${workspaceId}/analytics/deployments${rangeQuery(range)}`,
  );
}

/** GET /bots/:botId/deployments/:deploymentId/domains — allowlisted hostnames. */
export function listDeploymentDomains(botId: string, deploymentId: string) {
  return apiGet<DeploymentDomain[]>(
    `/bots/${botId}/deployments/${deploymentId}/domains`,
  );
}

/** POST /bots/:botId/deployments/:deploymentId/domains — add one hostname. */
export function addDeploymentDomain(
  botId: string,
  deploymentId: string,
  domain: string,
) {
  return apiPost<DeploymentDomain>(
    `/bots/${botId}/deployments/${deploymentId}/domains`,
    { domain },
  );
}

/** DELETE /bots/:botId/deployments/:deploymentId/domains/:domainId — remove one. */
export function removeDeploymentDomain(
  botId: string,
  deploymentId: string,
  domainId: string,
) {
  return apiDelete<{ success: boolean }>(
    `/bots/${botId}/deployments/${deploymentId}/domains/${domainId}`,
  );
}
