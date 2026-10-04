import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  workspaceMember: { findUnique: vi.fn(), findFirst: vi.fn() },
  bot: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  botConfiguration: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { MAX_AVATAR_BYTES } = await import('../src/constants/uploads.js');

/**
 * Bot avatars (docs/BOT_IMPLEMENTATION_PLAN.md §10.2).
 *
 * These run through the real route stack — validation, authorization, multer and the error
 * handler — because the ordering between those four is part of the contract. A unit test on
 * `avatar.service` would prove the magic-byte check works while saying nothing about whether
 * an unauthorized caller can make the server buffer a megabyte first.
 *
 * The service under test is *not* mocked: only the database is.
 */

const OWNER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const AGENT = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'agent@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const membership = (role: 'OWNER' | 'ADMIN' | 'AGENT') =>
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId: role === 'AGENT' ? AGENT.id : OWNER.id,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

/**
 * Arrange the world for one avatar request.
 *
 * `bot.findUnique` resolves the path's `:botId` to a workspace *before* membership is
 * checked — leave it unprimed and every request 404s at scope resolution, which would mask
 * whatever the test actually meant to exercise.
 */
const arrange = (role: 'OWNER' | 'AGENT' = 'OWNER') => {
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  membership(role);
  prismaMock.bot.findFirst.mockResolvedValue({
    id: BOT_ID,
    name: 'Helper',
    description: null,
    workspaceId: WORKSPACE_ID,
    aiModelId: null,
    fallbackAiModelId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    aiModel: null,
    fallbackAiModel: null,
  });
};

// ---------------------------------------------------------------------------------------
// Real image fixtures. Built from the signatures themselves rather than checked in as
// binary files: a fixture that *is* the magic number cannot drift from the sniffer.
// ---------------------------------------------------------------------------------------

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('an actual png body would follow here'),
]);

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('jfif payload'),
]);

const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('vp8 payload'),
]);

/** A text file wearing a `.png` name — the disguised upload §10.2 requires be rejected. */
const TEXT_AS_PNG = Buffer.from('this is not an image, it is just some text\n');

const post = (buffer: Buffer, filename: string, contentType: string, as = OWNER) =>
  request(app)
    .post(`/api/v1/bots/${BOT_ID}/avatar`)
    .set('Authorization', authHeader(as))
    .attach('avatar', buffer, { filename, contentType });

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------------------
// Upload — the happy path
// ---------------------------------------------------------------------------------------

describe('POST /api/v1/bots/:botId/avatar', () => {
  it('stores a PNG and returns the cache-busting version (201)', async () => {
    arrange();
    prismaMock.botConfiguration.upsert.mockResolvedValue({
      avatarUpdatedAt: new Date('2026-10-04T10:00:00.000Z'),
      avatarVersion: 1,
    });

    const res = await post(PNG, 'logo.png', 'image/png');

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      avatarUrl: `/bots/${BOT_ID}/avatar`,
      avatarUpdatedAt: '2026-10-04T10:00:00.000Z',
      avatarVersion: 1,
    });

    // `upsert` is what makes a replacement atomic: there is no window in which the bot has
    // no avatar because the old bytes were cleared first.
    const call = prismaMock.botConfiguration.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ botId: BOT_ID });
    expect(call.create.avatarVersion).toBe(1);
    expect(call.update.avatarVersion).toEqual({ increment: 1 });
    // The stored MIME type is the one that was *sniffed*, not the one the client claimed.
    expect(call.create.avatarMimeType).toBe('image/png');
    expect(Buffer.from(call.create.avatarData).equals(PNG)).toBe(true);
  });

  it.each([
    ['JPEG', JPEG, 'photo.jpg', 'image/jpeg'],
    ['WebP', WEBP, 'logo.webp', 'image/webp'],
  ])('accepts a real %s (201)', async (_label, buffer, filename, contentType) => {
    arrange();
    prismaMock.botConfiguration.upsert.mockResolvedValue({
      avatarUpdatedAt: new Date(),
      avatarVersion: 1,
    });

    const res = await post(buffer as Buffer, filename as string, contentType as string);

    expect(res.status).toBe(201);
  });

  it('bumps the version on replacement rather than resetting it', async () => {
    arrange();
    prismaMock.botConfiguration.upsert.mockResolvedValue({
      avatarUpdatedAt: new Date(),
      avatarVersion: 4,
    });

    const res = await post(PNG, 'logo.png', 'image/png');

    expect(res.status).toBe(201);
    expect(res.body.data.avatarVersion).toBe(4);
    // A browser holding "v3" must not be served "v3" again just because a later upload
    // computed the same value.
    expect(prismaMock.botConfiguration.upsert.mock.calls[0][0].update.avatarVersion).toEqual({
      increment: 1,
    });
  });
});

// ---------------------------------------------------------------------------------------
// Upload — every rejection path. The statuses differ by cause and each is asserted, because
// a single "400 for all bad uploads" would tell a client nothing actionable.
// ---------------------------------------------------------------------------------------

describe('POST /api/v1/bots/:botId/avatar — rejections', () => {
  it('rejects a text file renamed .png — the magic bytes do not lie (400)', async () => {
    arrange();

    const res = await post(TEXT_AS_PNG, 'logo.png', 'image/png');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a valid/i);
    expect(res.body.data).toMatchObject({ reason: 'NOT_AN_IMAGE' });
    // Nothing was written: validation precedes storage.
    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('rejects a genuine image uploaded under the wrong MIME type (400)', async () => {
    arrange();

    // A JPEG that claims to be a PNG. Accepting it would store `image/jpeg` bytes under an
    // `image/png` label, so every later reader would be told the wrong thing.
    const res = await post(JPEG, 'logo.png', 'image/png');

    expect(res.status).toBe(400);
    expect(res.body.data).toMatchObject({ reason: 'MIME_MISMATCH', sniffed: 'image/jpeg' });
    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('rejects a type outside the accepted list at the parser (400)', async () => {
    arrange();

    const res = await post(PNG, 'logo.gif', 'image/gif');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/PNG, JPEG and WebP/);
    // Rejected by `fileFilter`, so the handler never ran.
    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('rejects an oversize image with 413, naming the limit', async () => {
    arrange();

    // One byte over the ceiling, with a valid PNG header so the only failing rule is size.
    const oversize = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]);

    const res = await post(oversize, 'logo.png', 'image/png');

    // 413, not 400: "too large" is a different fix from "wrong format", and the message
    // quotes the configured limit rather than a hardcoded one.
    expect(res.status).toBe(413);
    expect(res.body.message).toMatch(/512 KB/);
    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('rejects a request with no file part (400)', async () => {
    arrange();

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/image file is required/i);
  });

  it('refuses an unauthorized member before the body is buffered', async () => {
    arrange('AGENT');

    const res = await post(PNG, 'logo.png', 'image/png', AGENT);

    // AGENT holds `bots:view`, not `bots:manage`.
    expect(res.status).toBe(403);
    // The point of `validate → permission → multer`: multer never parsed, so an unauthorized
    // caller cannot make the server allocate for a body it was never going to accept.
    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('requires authentication (401)', async () => {
    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/avatar`)
      .attach('avatar', PNG, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------
// Serving
// ---------------------------------------------------------------------------------------

describe('GET /api/v1/bots/:botId/avatar', () => {
  const withAvatar = (overrides: Record<string, unknown> = {}) => {
    arrange();
    prismaMock.botConfiguration.findUnique.mockResolvedValue({
      avatarData: new Uint8Array(PNG),
      avatarMimeType: 'image/png',
      avatarUpdatedAt: new Date('2026-10-04T10:00:00.000Z'),
      avatarVersion: 3,
      ...overrides,
    });
  };

  it('serves the bytes with the stored type and an ETag — not the JSON envelope', async () => {
    withAvatar();

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
    expect(res.headers.etag).toBe(`"av3-${PNG.length}"`);
    // An <img src> cannot unwrap `{success, message, data}` — this is the one route that
    // answers with the resource itself.
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);

    // `private` is load-bearing: the URL carries no token, so a shared proxy caching this
    // would hand one workspace's bot avatar to another tenant.
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['cache-control']).not.toContain('public');
  });

  it('answers 304 on a matching If-None-Match, with no body', async () => {
    withAvatar();

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER))
      .set('If-None-Match', `"av3-${PNG.length}"`);

    expect(res.status).toBe(304);
    expect(res.body).toEqual({});
  });

  it('serves the full body when the validator is stale', async () => {
    withAvatar();

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER))
      .set('If-None-Match', '"av2-999"');

    // The version went 2 → 3, so a client holding the old image must be given the new one
    // rather than a 304 confirming a stale render.
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('is 404 when the bot has no avatar', async () => {
    arrange();
    prismaMock.botConfiguration.findUnique.mockResolvedValue({
      avatarData: null,
      avatarMimeType: null,
      avatarUpdatedAt: null,
      avatarVersion: 0,
    });

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(404);
  });

  it('is 404 when the bot has no configuration row at all', async () => {
    arrange();
    prismaMock.botConfiguration.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(404);
  });

  it('is 403 for an AGENT — the avatar sits behind `bots:view`', async () => {
    arrange('AGENT');
    prismaMock.botConfiguration.findUnique.mockResolvedValue({
      avatarData: new Uint8Array(PNG),
      avatarMimeType: 'image/png',
      avatarUpdatedAt: new Date(),
      avatarVersion: 1,
    });

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(AGENT));

    // AGENT holds neither `bots:view` nor `bots:manage` (plan §10.4) — the bot-configuration
    // surface is OWNER/ADMIN throughout, reads included. Checked here so a later widening of
    // the read stays a deliberate decision rather than a side effect.
    expect(res.status).toBe(403);
    // Refused before any bytes were read out of the database.
    expect(prismaMock.botConfiguration.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------------------

describe('DELETE /api/v1/bots/:botId/avatar', () => {
  it('nulls all four avatar columns in one update', async () => {
    arrange();
    prismaMock.botConfiguration.findUnique.mockResolvedValue({ avatarVersion: 3 });
    prismaMock.botConfiguration.update.mockResolvedValue({ avatarVersion: 4 });

    const res = await request(app)
      .delete(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data.avatarVersion).toBe(4);
    expect(prismaMock.botConfiguration.update.mock.calls[0][0].data).toEqual({
      avatarData: null,
      avatarMimeType: null,
      avatarUpdatedAt: null,
      avatarVersion: { increment: 1 },
    });
  });

  it('still bumps the version when there was no avatar, so a cached image is invalidated', async () => {
    arrange();
    prismaMock.botConfiguration.findUnique.mockResolvedValue({ avatarVersion: 2 });
    prismaMock.botConfiguration.update.mockResolvedValue({ avatarVersion: 3 });

    const res = await request(app)
      .delete(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER));

    // Reported as success, not 404: the desired end state — no avatar — is what the caller
    // asked for, and a browser holding the image needs a changed cache key to notice.
    expect(res.status).toBe(200);
    expect(res.body.data.avatarVersion).toBe(3);
  });

  it('creates no row when the bot has no configuration at all', async () => {
    arrange();
    prismaMock.botConfiguration.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data.avatarVersion).toBe(0);
    // Clearing nothing must not manufacture a configuration row.
    expect(prismaMock.botConfiguration.update).not.toHaveBeenCalled();
  });

  it('refuses an AGENT (403) — this is a write', async () => {
    arrange('AGENT');

    const res = await request(app)
      .delete(`/api/v1/bots/${BOT_ID}/avatar`)
      .set('Authorization', authHeader(AGENT));

    expect(res.status).toBe(403);
    expect(prismaMock.botConfiguration.update).not.toHaveBeenCalled();
  });
});
