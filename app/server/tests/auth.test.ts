import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

// Mock Prisma so no database is required. vi.hoisted lets the mock object be shared
// between the (hoisted) vi.mock factory and the test bodies.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  workspace: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  bot: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  knowledgeEntry: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  conversation: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  message: { create: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { hashPassword } = await import('../src/utils/password.js');
const { signToken } = await import('../src/utils/jwt.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/auth/register', () => {
  it('registers a new user and returns a token (201) without the password hash', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({
      id: 'user-1',
      name: 'John Doe',
      email: 'john@example.com',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'John Doe', email: 'john@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.user.email).toBe('john@example.com');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a duplicate email (409)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'existing', email: 'john@example.com' });

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'John Doe', email: 'john@example.com', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('rejects invalid input (400)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: '', email: 'not-an-email', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('logs in with valid credentials (200)', async () => {
    const passwordHash = await hashPassword('password123');
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'John Doe',
      email: 'john@example.com',
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'john@example.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects invalid credentials with a generic message (401)', async () => {
    const passwordHash = await hashPassword('password123');
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'John Doe',
      email: 'john@example.com',
      passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'john@example.com', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('accepts a logout and reports success (200)', async () => {
    const res = await request(app).post('/api/v1/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('does NOT invalidate the token server-side — the same token still authenticates', async () => {
    // The documented contract (src/controllers/auth.controller.ts): JWTs are stateless, so
    // logout is a client-side discard and the endpoint deliberately does not pretend
    // otherwise. A token blacklist is a Review 2 item. Pinned so the limitation stays
    // visible instead of being assumed away.
    const token = signToken({ sub: 'user-1', email: 'john@example.com' });
    prismaMock.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'John Doe',
      email: 'john@example.com',
      platformRole: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const loggedOut = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(loggedOut.status).toBe(200);

    // The token issued before the logout is still accepted.
    const after = await request(app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
  });
});

describe('protected route access', () => {
  it('rejects access to /users/me without a token (401)', async () => {
    const res = await request(app).get('/api/v1/users/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});
