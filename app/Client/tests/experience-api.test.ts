import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getExperience,
  updateExperience,
  publishExperience,
  unpublishExperience,
  listExperienceVersions,
  getExperienceVersion,
  rollbackExperienceVersion,
} from '@/lib/api/experience';
import {
  listDeployments,
  updateDeployment,
  getDeploymentSnippet,
  getDeploymentAnalytics,
  listDeploymentDomains,
  addDeploymentDomain,
  removeDeploymentDomain,
} from '@/lib/api/deployments';

/**
 * CP-8.1 / CP-8.2 — the Experience Studio API clients.
 *
 * These are thin, but their paths and verbs are the contract with the server and
 * a wrong one fails silently at runtime. Each test asserts the exact request the
 * backend routes expect, plus the optimistic-concurrency token on a draft save.
 */

const BASE = 'http://localhost:5000/api/v1';
const BOT = '11111111-1111-1111-1111-111111111111';
const VERSION = '22222222-2222-2222-2222-222222222222';
const DEPLOYMENT = '33333333-3333-3333-3333-333333333333';
const DOMAIN = '44444444-4444-4444-4444-444444444444';

const fetchMock = vi.fn();

function respond(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ success: status < 400, data }),
  });
}

function lastCall() {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return {
    url: call[0] as string,
    options: (call[1] ?? {}) as RequestInit,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('experience API', () => {
  it('reads the draft with GET /bots/:botId/experience', async () => {
    fetchMock.mockReturnValueOnce(respond({ id: 'exp-1', version: 3 }));

    await expect(getExperience(BOT)).resolves.toMatchObject({ version: 3 });
    expect(lastCall().url).toBe(`${BASE}/bots/${BOT}/experience`);
    expect(lastCall().options.method).toBe('GET');
  });

  it('saves a partial draft with PATCH and the expected version', async () => {
    fetchMock.mockReturnValueOnce(respond({ version: 4 }));

    await updateExperience(BOT, {
      displayName: 'Ada',
      expectedVersion: 3,
    });

    const { url, options } = lastCall();
    expect(url).toBe(`${BASE}/bots/${BOT}/experience`);
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({
      displayName: 'Ada',
      expectedVersion: 3,
    });
  });

  it('publishes and unpublishes with POST', async () => {
    fetchMock.mockReturnValueOnce(respond({ version: 5 }));
    await publishExperience(BOT, 4);
    expect(lastCall().url).toBe(`${BASE}/bots/${BOT}/experience/publish`);
    expect(lastCall().options.method).toBe('POST');
    expect(JSON.parse(lastCall().options.body as string)).toEqual({
      expectedVersion: 4,
    });

    fetchMock.mockReturnValueOnce(respond({ version: 5 }));
    await unpublishExperience(BOT);
    expect(lastCall().url).toBe(`${BASE}/bots/${BOT}/experience/unpublish`);
    expect(lastCall().options.method).toBe('POST');
  });

  it('lists, reads and rolls back versions', async () => {
    fetchMock.mockReturnValueOnce(respond([]));
    await listExperienceVersions(BOT);
    expect(lastCall().url).toBe(`${BASE}/bots/${BOT}/experience/versions`);

    fetchMock.mockReturnValueOnce(respond({ id: VERSION }));
    await getExperienceVersion(BOT, VERSION);
    expect(lastCall().url).toBe(
      `${BASE}/bots/${BOT}/experience/versions/${VERSION}`,
    );

    fetchMock.mockReturnValueOnce(respond({ version: 6 }));
    await rollbackExperienceVersion(BOT, VERSION);
    expect(lastCall().url).toBe(
      `${BASE}/bots/${BOT}/experience/versions/${VERSION}/rollback`,
    );
    expect(lastCall().options.method).toBe('POST');
  });
});

describe('deployment API', () => {
  it('lists deployments for a bot', async () => {
    fetchMock.mockReturnValueOnce(respond([]));
    await listDeployments(BOT);
    expect(lastCall().url).toBe(`${BASE}/bots/${BOT}/deployments`);
  });

  it('updates a deployment with PATCH', async () => {
    fetchMock.mockReturnValueOnce(respond({ id: DEPLOYMENT }));
    await updateDeployment(BOT, DEPLOYMENT, {
      enabled: false,
      expectedVersion: 2,
    });

    expect(lastCall().url).toBe(
      `${BASE}/bots/${BOT}/deployments/${DEPLOYMENT}`,
    );
    expect(lastCall().options.method).toBe('PATCH');
    expect(JSON.parse(lastCall().options.body as string)).toEqual({
      enabled: false,
      expectedVersion: 2,
    });
  });

  it('reads the installation snippet', async () => {
    fetchMock.mockReturnValueOnce(respond({ snippet: '<script>' }));
    await getDeploymentSnippet(BOT, DEPLOYMENT);
    expect(lastCall().url).toBe(
      `${BASE}/bots/${BOT}/deployments/${DEPLOYMENT}/snippet`,
    );
  });

  it('passes the analytics date range as query parameters', async () => {
    fetchMock.mockReturnValueOnce(respond({ metrics: {} }));
    await getDeploymentAnalytics(BOT, DEPLOYMENT, {
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });

    expect(lastCall().url).toBe(
      `${BASE}/bots/${BOT}/deployments/${DEPLOYMENT}/analytics?startDate=2026-10-01&endDate=2026-10-31`,
    );
  });

  it('manages the domain allowlist', async () => {
    fetchMock.mockReturnValueOnce(respond([]));
    await listDeploymentDomains(BOT, DEPLOYMENT);
    expect(lastCall().url).toBe(
      `${BASE}/bots/${BOT}/deployments/${DEPLOYMENT}/domains`,
    );

    fetchMock.mockReturnValueOnce(respond({ id: DOMAIN }));
    await addDeploymentDomain(BOT, DEPLOYMENT, 'example.com');
    expect(lastCall().options.method).toBe('POST');
    expect(JSON.parse(lastCall().options.body as string)).toEqual({
      domain: 'example.com',
    });

    fetchMock.mockReturnValueOnce(respond({ success: true }));
    await removeDeploymentDomain(BOT, DEPLOYMENT, DOMAIN);
    expect(lastCall().url).toBe(
      `${BASE}/bots/${BOT}/deployments/${DEPLOYMENT}/domains/${DOMAIN}`,
    );
    expect(lastCall().options.method).toBe('DELETE');
  });
});
