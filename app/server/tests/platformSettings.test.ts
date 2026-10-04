import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  platformSetting: { upsert: vi.fn(), update: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: {} }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { logger } = await import('../src/config/logger.js');
const { invalidateSettingsCache, getSettings, resolveUploadLimits, updateSettings } =
  await import('../src/services/platformSettings.service.js');
const { ACCEPTED_EXTENSIONS, ACCEPTED_MIME_TYPES } = await import(
  '../src/constants/uploads.js'
);

logger.level = 'silent';

const MB = 1024 * 1024;

const OWNER = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'owner@example.com' };
const MEMBER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'member@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

/** The seeded singleton, with the defaults section 12.3 documents. */
const settingsRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'singleton',
  maxUploadFileSizeBytes: 10 * MB,
  maxUploadFilesPerRequest: 10,
  maxUploadTotalBytes: 50 * MB,
  maxChunksPerSource: 5000,
  maxChunksPerBot: 0,
  aiServiceMaxFileSizeBytes: 100 * MB,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  ...overrides,
});

/** Give the caller a platform role, as `authenticate` and `requirePlatformOwner` read it. */
const signInAs = (user: { id: string; email: string }, platformRole: 'USER' | 'PLATFORM_OWNER'): void => {
  prismaMock.user.findUnique.mockResolvedValue({ id: user.id, platformRole });
};

/**
 * The stored row, mutable so the mocks behave like a database rather than a fixed return.
 *
 * This matters for the cache tests: a write that invalidates the cache is only *observably*
 * correct if the next read sees the written value. If `upsert` kept returning the seeded
 * row, the test would pass on a broken implementation that never invalidated anything.
 */
let stored: ReturnType<typeof settingsRow>;

beforeEach(() => {
  vi.clearAllMocks();
  // The cache is module-level, so it outlives a test unless it is dropped. Clearing
  // `vi.fn` call history is not enough — a warm cache would make the next test read a
  // value no test set up.
  invalidateSettingsCache();

  stored = settingsRow();

  prismaMock.platformSetting.upsert.mockImplementation(async () => stored);
  prismaMock.platformSetting.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      stored = { ...stored, ...data };
      return stored;
    }
  );
});

describe('GET /api/v1/platform/settings', () => {
  it('creates the singleton if it is absent and returns the current values', async () => {
    signInAs(OWNER, 'PLATFORM_OWNER');

    const res = await request(app)
      .get('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      maxUploadFileSizeBytes: 10 * MB,
      maxUploadFilesPerRequest: 10,
      maxUploadTotalBytes: 50 * MB,
      maxChunksPerSource: 5000,
      maxChunksPerBot: 0,
      aiServiceMaxFileSizeBytes: 100 * MB,
    });

    // Upsert-on-read, not a bare findUnique: a database whose seed never ran must not be
    // able to produce a "no limits configured" state.
    expect(prismaMock.platformSetting.upsert).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      update: {},
      create: { id: 'singleton' },
    });
  });

  it('is 403 for a signed-in user who is not a platform owner', async () => {
    signInAs(MEMBER, 'USER');

    const res = await request(app)
      .get('/api/v1/platform/settings')
      .set('Authorization', authHeader(MEMBER));

    expect(res.status).toBe(403);
    // The guard is the mount's, so a route added to this namespace cannot ship unguarded.
    expect(prismaMock.platformSetting.upsert).not.toHaveBeenCalled();
  });

  it('is 403 for a workspace OWNER, whose role grants nothing platform-wide', async () => {
    signInAs(MEMBER, 'USER');
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'm',
      userId: MEMBER.id,
      workspaceId: WORKSPACE_ID,
      role: 'OWNER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get('/api/v1/platform/settings')
      .set('Authorization', authHeader(MEMBER));

    expect(res.status).toBe(403);
  });

  it('is 401 without a token', async () => {
    const res = await request(app).get('/api/v1/platform/settings');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/v1/platform/settings', () => {
  it('changes only the supplied fields', async () => {
    signInAs(OWNER, 'PLATFORM_OWNER');

    const res = await request(app)
      .patch('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER))
      .send({ maxUploadFilesPerRequest: 25 });

    expect(res.status).toBe(200);
    // Partial, not a replace: the other five fields are absent from the write, so two
    // operators patching different settings cannot clobber each other.
    expect(prismaMock.platformSetting.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { maxUploadFilesPerRequest: 25 },
    });
  });

  it('rejects an empty body rather than treating it as a no-op', async () => {
    signInAs(OWNER, 'PLATFORM_OWNER');

    const res = await request(app)
      .patch('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER))
      .send({});

    expect(res.status).toBe(400);
    expect(prismaMock.platformSetting.update).not.toHaveBeenCalled();
  });

  it('rejects a value outside its range', async () => {
    signInAs(OWNER, 'PLATFORM_OWNER');

    const tooManyFiles = await request(app)
      .patch('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER))
      .send({ maxUploadFilesPerRequest: 0 });

    expect(tooManyFiles.status).toBe(400);

    const tooLargeAFile = await request(app)
      .patch('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER))
      .send({ maxUploadFileSizeBytes: 200 * MB });

    expect(tooLargeAFile.status).toBe(400);
    expect(prismaMock.platformSetting.update).not.toHaveBeenCalled();
  });

  it('rejects a patch that would put the combined limit below the per-file limit', async () => {
    signInAs(OWNER, 'PLATFORM_OWNER');

    const res = await request(app)
      .patch('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER))
      .send({ maxUploadTotalBytes: 5 * MB });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxUploadTotalBytes.*maxUploadFileSizeBytes/);
    // Nothing is written when the merged result is self-contradictory.
    expect(prismaMock.platformSetting.update).not.toHaveBeenCalled();
  });

  it('rejects a patch that would put the AI backstop below the per-file limit', async () => {
    signInAs(OWNER, 'PLATFORM_OWNER');

    const res = await request(app)
      .patch('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER))
      .send({ aiServiceMaxFileSizeBytes: 5 * MB });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aiServiceMaxFileSizeBytes.*maxUploadFileSizeBytes/);
    expect(prismaMock.platformSetting.update).not.toHaveBeenCalled();
  });

  it('validates the merge against a fresh read, not a stale cache', async () => {
    signInAs(OWNER, 'PLATFORM_OWNER');

    // Warm the cache with a row that would make the patch below look valid...
    await getSettings();
    expect(prismaMock.platformSetting.upsert).toHaveBeenCalledTimes(1);

    // ...then change the stored row behind its back, as another instance's PATCH would.
    stored = settingsRow({ maxUploadFileSizeBytes: 40 * MB });

    const res = await request(app)
      .patch('/api/v1/platform/settings')
      .set('Authorization', authHeader(OWNER))
      .send({ maxUploadTotalBytes: 20 * MB });

    // 20 MB >= the cached 10 MB per-file limit, but < the stored 40 MB — so validating
    // against the cache would persist a row where no allowed file could be uploaded.
    expect(res.status).toBe(400);
    expect(prismaMock.platformSetting.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.platformSetting.update).not.toHaveBeenCalled();
  });
});

describe('settings cache', () => {
  it('serves a repeated read from the cache rather than querying again', async () => {
    await getSettings();
    await getSettings();

    expect(prismaMock.platformSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it('makes a successful write visible on the very next read', async () => {
    await getSettings();

    await updateSettings({ maxUploadFilesPerRequest: 7 });

    // Read through the resolver, which is the path every enforcement point uses.
    const limits = await resolveUploadLimits(WORKSPACE_ID);
    expect(limits.maxFilesPerRequest).toBe(7);
  });

  it('converges on a value another instance wrote once the TTL passes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await getSettings();

      // Stand in for a second API instance: the row changes, this instance's cache does not.
      stored = settingsRow({ maxUploadFilesPerRequest: 3 });

      const withinTtl = await resolveUploadLimits(WORKSPACE_ID);
      expect(withinTtl.maxFilesPerRequest).toBe(10);

      vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));

      const afterTtl = await resolveUploadLimits(WORKSPACE_ID);
      expect(afterTtl.maxFilesPerRequest).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveUploadLimits', () => {
  it('returns the stored settings as the effective limits', async () => {
    stored = settingsRow({
      maxUploadFileSizeBytes: 2 * MB,
      maxUploadFilesPerRequest: 4,
      maxUploadTotalBytes: 6 * MB,
      maxChunksPerSource: 100,
      maxChunksPerBot: 500,
    });

    const limits = await resolveUploadLimits(WORKSPACE_ID);

    expect(limits).toEqual({
      maxFileSizeBytes: 2 * MB,
      maxFilesPerRequest: 4,
      maxTotalBytes: 6 * MB,
      maxChunksPerSource: 100,
      maxChunksPerBot: 500,
      acceptedMimeTypes: [...ACCEPTED_MIME_TYPES],
      acceptedExtensions: [...ACCEPTED_EXTENSIONS],
    });
  });

  it('carries the accepted types from the constants, and does not leak the AI backstop', async () => {
    const limits = await resolveUploadLimits(WORKSPACE_ID);

    expect(limits.acceptedMimeTypes).toEqual([...ACCEPTED_MIME_TYPES]);
    expect(limits.acceptedExtensions).toEqual([...ACCEPTED_EXTENSIONS]);

    // `aiServiceMaxFileSizeBytes` is an internal backstop, not a limit this tier
    // advertises. It must not travel on the object a workspace member can fetch.
    expect(limits).not.toHaveProperty('aiServiceMaxFileSizeBytes');
  });
});
