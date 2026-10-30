import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => {
  const mock: any = {
    user: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    bot: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    botExperience: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    botExperienceVersion: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    botDeployment: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn((fn: any) => fn(mock)),
  };
  return mock;
});

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const {
  getOrCreateExperience,
  updateExperience,
  publishExperience,
  unpublishExperience,
  listVersions,
  getVersion,
  rollbackToVersion,
  extractSnapshot,
} = await import('../src/services/experience.service.js');
const {
  updateExperienceSchema,
  experienceDraftSchema,
  publishExperienceSchema,
} = await import('../src/schemas/experience.schema.js');
const { EXPERIENCE_DEFAULTS } = await import('../src/constants/experienceDefaults.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_BOT_ID = '33333333-3333-3333-3333-333333333333';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';

const authHeader = (userId = USER_ID): string =>
  `Bearer ${signToken({ sub: userId, email: 'owner@example.com' })}`;

const accessibleBot = (botId = BOT_ID, name = 'Support Bot') =>
  prismaMock.bot.findFirst.mockImplementation(({ where }: any) => {
    if (where.id === botId && where.workspace?.members?.some?.userId === USER_ID) {
      return Promise.resolve({
        id: botId,
        name,
        description: null,
        workspaceId: WORKSPACE_ID,
        aiModelId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        aiModel: null,
      });
    }
    return Promise.resolve(null);
  });

const arrangeRoute = (role: 'OWNER' | 'ADMIN' | 'AGENT' = 'OWNER', botId = BOT_ID) => {
  prismaMock.bot.findUnique.mockImplementation(({ where }: any) => {
    if (where?.id === botId) {
      return Promise.resolve({
        id: botId,
        name: 'Support Bot',
        workspaceId: WORKSPACE_ID,
        configuration: null,
      });
    }
    return Promise.resolve(null);
  });
  prismaMock.workspaceMember.findUnique.mockImplementation(({ where }: any) => {
    if (where?.userId_workspaceId?.userId === USER_ID && where?.userId_workspaceId?.workspaceId === WORKSPACE_ID) {
      return Promise.resolve({
        id: 'member-1',
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        role,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return Promise.resolve(null);
  });
  accessibleBot(botId);
};

const defaultExperienceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'exp-1',
  botId: BOT_ID,
  version: 1,
  publishedVersionId: null,
  publishedVersion: null,
  deployments: [],
  ...EXPERIENCE_DEFAULTS,
  suggestedQuestions: [...EXPERIENCE_DEFAULTS.suggestedQuestions],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));
});

describe('Phase 1: Experience Schema Validation (CP-1.9)', () => {
  it('validates a complete valid draft configuration', () => {
    const validDraft = {
      displayName: 'Customer Assistant',
      botAvatarUrl: 'https://example.com/avatar.png',
      businessLogoUrl: 'https://example.com/logo.png',
      accentColor: '#4f46e5',
      userBubbleColor: '#3b82f6',
      botBubbleColor: '#f3f4f6',
      themeMode: 'dark',
      themePreset: 'professional',

      hostedPageTitle: 'Live Support',
      hostedPageDescription: 'How can we help today?',
      widgetPosition: 'bottom-right',
      widgetLauncherLabel: 'Chat with us',
      widgetPanelWidth: 420,
      widgetPanelHeight: 650,
      widgetMobileBehavior: 'fullscreen',
      iframeWidth: '100%',
      iframeHeight: '600px',

      welcomeMessage: 'Hello! How may I assist you?',
      welcomeSubtitle: 'Typically replies in seconds',
      inputPlaceholder: 'Ask a question...',
      suggestedQuestions: ['What are your hours?', 'How to reset password?'],
      firstOpenBehavior: 'welcome',

      showTimestamps: true,
      autoOpen: false,
      privacyPolicyUrl: 'https://example.com/privacy',
      termsUrl: 'https://example.com/terms',
      showBranding: false,
    };

    const parsed = experienceDraftSchema.safeParse(validDraft);
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid hex colors', () => {
    const invalidDraft = {
      accentColor: 'blue',
    };
    const parsed = updateExperienceSchema.safeParse(invalidDraft);
    expect(parsed.success).toBe(false);
  });

  it('rejects panel dimensions outside allowed bounds', () => {
    expect(updateExperienceSchema.safeParse({ widgetPanelWidth: 100 }).success).toBe(false);
    expect(updateExperienceSchema.safeParse({ widgetPanelWidth: 1000 }).success).toBe(false);
    expect(updateExperienceSchema.safeParse({ widgetPanelHeight: 200 }).success).toBe(false);
    expect(updateExperienceSchema.safeParse({ widgetPanelHeight: 1200 }).success).toBe(false);
  });

  it('rejects duplicate suggested questions', () => {
    const res = updateExperienceSchema.safeParse({
      suggestedQuestions: ['Hello', 'hello'],
    });
    expect(res.success).toBe(false);
  });

  it('rejects an empty update body', () => {
    const res = updateExperienceSchema.safeParse({});
    expect(res.success).toBe(false);
  });

  it('accepts partial updates with expectedVersion', () => {
    const res = updateExperienceSchema.safeParse({
      expectedVersion: 1,
      displayName: 'New Bot Name',
    });
    expect(res.success).toBe(true);
  });
});

describe('Phase 1: Experience Service CRUD (CP-1.10)', () => {
  it('creates default experience on first access if none exists', async () => {
    accessibleBot();
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      name: 'Default Bot',
      configuration: null,
    });
    prismaMock.botExperience.findUnique.mockResolvedValue(null);
    prismaMock.botExperience.create.mockResolvedValue(defaultExperienceRow());

    const result = await getOrCreateExperience(BOT_ID, USER_ID);

    expect(prismaMock.botExperience.create).toHaveBeenCalledWith({
      data: {
        botId: BOT_ID,
        ...EXPERIENCE_DEFAULTS,
      },
      include: {
        publishedVersion: true,
        deployments: true,
      },
    });
    expect(result.botId).toBe(BOT_ID);
    expect(result.version).toBe(1);
    expect(result.effective.displayName).toBe('Default Bot');
    expect(result.effective.isDisplayNameOverridden).toBe(false);
  });

  it('returns existing experience with effective override calculations', async () => {
    accessibleBot();
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      name: 'Fallback Name',
      configuration: {
        displayName: 'Config Name',
        welcomeMessage: 'Config Welcome',
        suggestedQuestions: ['Q1'],
      },
    });
    prismaMock.botExperience.findUnique.mockResolvedValue(
      defaultExperienceRow({
        displayName: 'Overridden Name',
        welcomeMessage: 'Overridden Welcome',
        suggestedQuestions: ['Custom Q1', 'Custom Q2'],
      })
    );

    const result = await getOrCreateExperience(BOT_ID, USER_ID);

    expect(result.effective.displayName).toBe('Overridden Name');
    expect(result.effective.isDisplayNameOverridden).toBe(true);
    expect(result.effective.welcomeMessage).toBe('Overridden Welcome');
    expect(result.effective.isWelcomeMessageOverridden).toBe(true);
    expect(result.effective.suggestedQuestions).toEqual(['Custom Q1', 'Custom Q2']);
    expect(result.effective.isSuggestedQuestionsOverridden).toBe(true);
  });

  it('falls back to BotConfiguration when experience overrides are null', async () => {
    accessibleBot();
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      name: 'Bot Model Name',
      configuration: {
        displayName: 'Config Display Name',
        welcomeMessage: 'Config Welcome Message',
        suggestedQuestions: ['Config Q1'],
      },
    });
    prismaMock.botExperience.findUnique.mockResolvedValue(
      defaultExperienceRow({
        displayName: null,
        welcomeMessage: null,
        suggestedQuestions: [],
      })
    );

    const result = await getOrCreateExperience(BOT_ID, USER_ID);

    expect(result.effective.displayName).toBe('Config Display Name');
    expect(result.effective.isDisplayNameOverridden).toBe(false);
    expect(result.effective.welcomeMessage).toBe('Config Welcome Message');
    expect(result.effective.isWelcomeMessageOverridden).toBe(false);
    expect(result.effective.suggestedQuestions).toEqual(['Config Q1']);
    expect(result.effective.isSuggestedQuestionsOverridden).toBe(false);
  });

  it('applies partial update and increments version', async () => {
    accessibleBot();
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      name: 'Bot Name',
      configuration: null,
    });
    prismaMock.botExperience.findUnique.mockResolvedValue(
      defaultExperienceRow({ version: 1 })
    );
    prismaMock.botExperience.update.mockResolvedValue(
      defaultExperienceRow({
        version: 2,
        displayName: 'Updated Name',
        accentColor: '#10b981',
      })
    );

    const result = await updateExperience(BOT_ID, USER_ID, {
      expectedVersion: 1,
      displayName: 'Updated Name',
      accentColor: '#10b981',
    });

    expect(prismaMock.botExperience.update).toHaveBeenCalledWith({
      where: { botId: BOT_ID },
      data: {
        displayName: 'Updated Name',
        accentColor: '#10b981',
        version: { increment: 1 },
      },
      include: {
        publishedVersion: true,
        deployments: true,
      },
    });
    expect(result.version).toBe(2);
    expect(result.displayName).toBe('Updated Name');
    expect(result.accentColor).toBe('#10b981');
  });

  it('rejects stale expectedVersion with 409 Conflict', async () => {
    accessibleBot();
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      name: 'Bot Name',
      configuration: null,
    });
    prismaMock.botExperience.findUnique.mockResolvedValue(
      defaultExperienceRow({ version: 3 })
    );

    await expect(
      updateExperience(BOT_ID, USER_ID, {
        expectedVersion: 1,
        displayName: 'Conflict Test',
      })
    ).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(prismaMock.botExperience.update).not.toHaveBeenCalled();
  });
});

describe('Phase 1: Experience Routes & RBAC (CP-1.11)', () => {
  it('GET /api/v1/bots/:botId/experience returns 200 for OWNER', async () => {
    arrangeRoute('OWNER');
    prismaMock.botExperience.findUnique.mockResolvedValue(defaultExperienceRow());

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.botId).toBe(BOT_ID);
    expect(res.body.data.version).toBe(1);
  });

  it('GET /api/v1/bots/:botId/experience returns 200 for ADMIN (bots:view)', async () => {
    arrangeRoute('ADMIN');
    prismaMock.botExperience.findUnique.mockResolvedValue(defaultExperienceRow());

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
  });

  it('GET /api/v1/bots/:botId/experience returns 403 for AGENT', async () => {
    arrangeRoute('AGENT');

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(403);
  });

  it('PATCH /api/v1/bots/:botId/experience returns 200 on valid update for OWNER (bots:manage)', async () => {
    arrangeRoute('OWNER');
    prismaMock.botExperience.findUnique.mockResolvedValue(defaultExperienceRow({ version: 1 }));
    prismaMock.botExperience.update.mockResolvedValue(
      defaultExperienceRow({ version: 2, displayName: 'Patched Assistant' })
    );

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', authHeader())
      .send({
        expectedVersion: 1,
        displayName: 'Patched Assistant',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.displayName).toBe('Patched Assistant');
  });

  it('PATCH /api/v1/bots/:botId/experience returns 403 for AGENT', async () => {
    arrangeRoute('AGENT');

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', authHeader())
      .send({
        displayName: 'Agent Attempt',
      });

    expect(res.status).toBe(403);
  });

  it('PATCH /api/v1/bots/:botId/experience returns 400 for invalid body', async () => {
    arrangeRoute('OWNER');

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', authHeader())
      .send({
        accentColor: 'invalid-color',
      });

    expect(res.status).toBe(400);
  });
});

describe('Phase 2: Publishing & Versioning (CP-2.1 to CP-2.14)', () => {
  it('CP-2.1: publishExperience creates immutable version snapshot and 3 deployments', async () => {
    accessibleBot();
    const expRow = defaultExperienceRow({ displayName: 'Published Bot', version: 1 });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.botExperience.findUniqueOrThrow.mockResolvedValue(expRow);
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'Support Bot', workspaceId: WORKSPACE_ID });
    prismaMock.botExperienceVersion.findFirst.mockResolvedValue(null); // first version

    const mockCreatedVersion = {
      id: 'ver-1',
      experienceId: expRow.id,
      versionNumber: 1,
      config: extractSnapshot(expRow as any),
      publishedAt: new Date(),
      publishedBy: USER_ID,
    };
    prismaMock.botExperienceVersion.create.mockResolvedValue(mockCreatedVersion);

    prismaMock.botDeployment.findUnique.mockResolvedValue(null); // none exist yet
    prismaMock.botDeployment.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: `dep-${data.format.toLowerCase()}`,
        ...data,
        unpublishedAt: null,
        publishEpoch: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );

    const publishedExpRow = {
      ...expRow,
      version: 2,
      publishedVersionId: 'ver-1',
      publishedVersion: mockCreatedVersion,
      deployments: [
        { id: 'dep-hosted', format: 'HOSTED_PAGE', status: 'PUBLISHED', enabled: true, slug: 'support-bot-123456', publishEpoch: 0, unpublishedAt: null, createdAt: new Date(), updatedAt: new Date(), experienceId: expRow.id, botId: BOT_ID, workspaceId: WORKSPACE_ID },
        { id: 'dep-widget', format: 'WIDGET', status: 'PUBLISHED', enabled: true, slug: null, publishEpoch: 0, unpublishedAt: null, createdAt: new Date(), updatedAt: new Date(), experienceId: expRow.id, botId: BOT_ID, workspaceId: WORKSPACE_ID },
        { id: 'dep-iframe', format: 'IFRAME', status: 'PUBLISHED', enabled: true, slug: null, publishEpoch: 0, unpublishedAt: null, createdAt: new Date(), updatedAt: new Date(), experienceId: expRow.id, botId: BOT_ID, workspaceId: WORKSPACE_ID },
      ],
    };
    prismaMock.botExperience.update.mockResolvedValue(publishedExpRow);
    prismaMock.botExperience.findUniqueOrThrow.mockResolvedValue(publishedExpRow);

    const res = await publishExperience(BOT_ID, USER_ID);

    expect(prismaMock.botExperienceVersion.create).toHaveBeenCalled();
    const versionArgs = prismaMock.botExperienceVersion.create.mock.calls[0][0];
    expect(versionArgs.data.versionNumber).toBe(1);
    expect(versionArgs.data.config.displayName).toBe('Published Bot');

    // 3 deployments created
    expect(prismaMock.botDeployment.create).toHaveBeenCalledTimes(3);
    expect(res.publishedVersionId).toBe('ver-1');
    expect(res.deployments.length).toBe(3);
    expect(res.deployments.every((d) => d.status === 'PUBLISHED')).toBe(true);
  });

  it('CP-2.2: auto-increments version number on subsequent publish', async () => {
    accessibleBot();
    const expRow = defaultExperienceRow({ displayName: 'Published Bot', version: 2 });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.botExperience.findUniqueOrThrow.mockResolvedValue(expRow);
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'Support Bot', workspaceId: WORKSPACE_ID });
    // Previous version was versionNumber 1
    prismaMock.botExperienceVersion.findFirst.mockResolvedValue({ versionNumber: 1 });
    prismaMock.botExperienceVersion.create.mockResolvedValue({
      id: 'ver-2',
      experienceId: expRow.id,
      versionNumber: 2,
      config: extractSnapshot(expRow as any),
      publishedAt: new Date(),
      publishedBy: USER_ID,
    });
    prismaMock.botDeployment.findUnique.mockResolvedValue({ id: 'dep-1', format: 'HOSTED_PAGE' });
    prismaMock.botDeployment.update.mockResolvedValue({});

    await publishExperience(BOT_ID, USER_ID);

    const versionArgs = prismaMock.botExperienceVersion.create.mock.calls[0][0];
    expect(versionArgs.data.versionNumber).toBe(2);
  });

  it('CP-2.3: deployment slug is generated on first publish and stable across subsequent publishes', async () => {
    accessibleBot();
    const expRow = defaultExperienceRow({ displayName: 'My Special Bot' });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.botExperience.findUniqueOrThrow.mockResolvedValue(expRow);
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'My Special Bot', workspaceId: WORKSPACE_ID });
    prismaMock.botExperienceVersion.findFirst.mockResolvedValue({ versionNumber: 1 });
    prismaMock.botExperienceVersion.create.mockResolvedValue({
      id: 'ver-2',
      experienceId: expRow.id,
      versionNumber: 2,
      config: extractSnapshot(expRow as any),
      publishedAt: new Date(),
      publishedBy: USER_ID,
    });

    // Existing hosted deployment has slug 'my-special-bot-stable1'
    prismaMock.botDeployment.findUnique.mockImplementation(({ where }: any) => {
      if (where?.experienceId_format?.format === 'HOSTED_PAGE') {
        return Promise.resolve({
          id: 'dep-hosted-existing',
          format: 'HOSTED_PAGE',
          slug: 'my-special-bot-stable1',
        });
      }
      return Promise.resolve({ id: 'dep-other' });
    });
    prismaMock.botDeployment.update.mockResolvedValue({});

    await publishExperience(BOT_ID, USER_ID);

    // Should NOT have created a new slug for HOSTED_PAGE, should update existing
    expect(prismaMock.botDeployment.create).not.toHaveBeenCalled();
    expect(prismaMock.botDeployment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dep-hosted-existing' },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      })
    );
  });

  it('CP-2.4: unpublishExperience sets all deployments to UNPUBLISHED, bumps publishEpoch, and records timestamp', async () => {
    accessibleBot();
    const expRow = defaultExperienceRow({ id: 'exp-1' });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.botExperience.findUniqueOrThrow.mockResolvedValue(expRow);
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'Support Bot', workspaceId: WORKSPACE_ID });
    prismaMock.botDeployment.updateMany.mockResolvedValue({ count: 3 });
    prismaMock.botExperience.update.mockResolvedValue(expRow);

    await unpublishExperience(BOT_ID, USER_ID);

    expect(prismaMock.botDeployment.updateMany).toHaveBeenCalledWith({
      where: { experienceId: 'exp-1' },
      data: expect.objectContaining({
        status: 'UNPUBLISHED',
        publishEpoch: { increment: 1 },
      }),
    });
    const updateArgs = prismaMock.botDeployment.updateMany.mock.calls[0][0];
    expect(updateArgs.data.unpublishedAt).toBeInstanceOf(Date);
  });

  it('CP-2.5: listVersions returns versions ordered by versionNumber DESC', async () => {
    accessibleBot();
    const expRow = defaultExperienceRow({ id: 'exp-1' });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.botExperience.findUniqueOrThrow.mockResolvedValue(expRow);
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'Support Bot', workspaceId: WORKSPACE_ID });

    prismaMock.botExperienceVersion.findMany.mockResolvedValue([
      {
        id: 'ver-2',
        experienceId: 'exp-1',
        versionNumber: 2,
        config: extractSnapshot(expRow as any),
        publishedAt: new Date(),
        publishedBy: USER_ID,
      },
      {
        id: 'ver-1',
        experienceId: 'exp-1',
        versionNumber: 1,
        config: extractSnapshot(expRow as any),
        publishedAt: new Date(),
        publishedBy: USER_ID,
      },
    ]);

    const versions = await listVersions(BOT_ID, USER_ID);

    expect(prismaMock.botExperienceVersion.findMany).toHaveBeenCalledWith({
      where: { experienceId: 'exp-1' },
      orderBy: { versionNumber: 'desc' },
    });
    expect(versions.length).toBe(2);
    expect(versions[0].versionNumber).toBe(2);
    expect(versions[1].versionNumber).toBe(1);
  });

  it('CP-2.6: getVersion returns specific version and throws 404 if not found', async () => {
    accessibleBot();
    const expRow = defaultExperienceRow({ id: 'exp-1' });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'Support Bot', workspaceId: WORKSPACE_ID });

    prismaMock.botExperienceVersion.findFirst.mockResolvedValueOnce({
      id: 'ver-1',
      experienceId: 'exp-1',
      versionNumber: 1,
      config: extractSnapshot(expRow as any),
      publishedAt: new Date(),
      publishedBy: USER_ID,
    });

    const version = await getVersion(BOT_ID, 'ver-1', USER_ID);
    expect(version.id).toBe('ver-1');

    prismaMock.botExperienceVersion.findFirst.mockResolvedValueOnce(null);
    await expect(getVersion(BOT_ID, 'nonexistent', USER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('CP-2.7: rollbackToVersion copies snapshot into draft, increments draft version, leaves publishedVersionId unchanged', async () => {
    accessibleBot();
    const expRow = defaultExperienceRow({
      id: 'exp-1',
      displayName: 'Current Draft Name',
      publishedVersionId: 'ver-current-published',
      version: 5,
    });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'Support Bot', workspaceId: WORKSPACE_ID });

    const targetSnapshot = {
      ...extractSnapshot(expRow as any),
      displayName: 'Old Rolled Back Name',
      accentColor: '#123456',
    };

    prismaMock.botExperienceVersion.findFirst.mockResolvedValue({
      id: 'ver-target',
      experienceId: 'exp-1',
      versionNumber: 2,
      config: targetSnapshot,
      publishedAt: new Date(),
      publishedBy: USER_ID,
    });

    prismaMock.botExperience.update.mockResolvedValue({
      ...expRow,
      displayName: 'Old Rolled Back Name',
      accentColor: '#123456',
      version: 6,
      publishedVersionId: 'ver-current-published',
    });

    const result = await rollbackToVersion(BOT_ID, 'ver-target', USER_ID);

    expect(prismaMock.botExperience.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'exp-1' },
        data: expect.objectContaining({
          displayName: 'Old Rolled Back Name',
          accentColor: '#123456',
          version: { increment: 1 },
        }),
      })
    );
    expect(result.displayName).toBe('Old Rolled Back Name');
    expect(result.publishedVersionId).toBe('ver-current-published');
  });

  it('CP-2.9: draft validation on publish requires non-empty display name', async () => {
    accessibleBot();
    // Bot has empty name and no config
    prismaMock.botExperience.findUnique.mockResolvedValue(
      defaultExperienceRow({ displayName: null })
    );
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: '   ', workspaceId: WORKSPACE_ID, configuration: null });

    await expect(publishExperience(BOT_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('CP-2.12: concurrent publish protection rejects with 409 on expectedVersion mismatch', async () => {
    accessibleBot();
    prismaMock.botExperience.findUnique.mockResolvedValue(
      defaultExperienceRow({ version: 3 })
    );
    prismaMock.bot.findUnique.mockResolvedValue({ id: BOT_ID, name: 'Support Bot', workspaceId: WORKSPACE_ID });

    await expect(
      publishExperience(BOT_ID, USER_ID, { expectedVersion: 1 })
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('CP-2.14: tenant isolation - cross-workspace access returns 404', async () => {
    // User is not a member of OTHER_BOT_ID's workspace
    prismaMock.bot.findFirst.mockResolvedValue(null);

    await expect(publishExperience(OTHER_BOT_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(unpublishExperience(OTHER_BOT_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(listVersions(OTHER_BOT_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(getVersion(OTHER_BOT_ID, 'ver-1', USER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(rollbackToVersion(OTHER_BOT_ID, 'ver-1', USER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('CP-2.8: HTTP routes test (publish, unpublish, versions list, version get, rollback)', async () => {
    arrangeRoute('OWNER');
    const expRow = defaultExperienceRow({ displayName: 'Published Bot' });
    prismaMock.botExperience.findUnique.mockResolvedValue(expRow);
    prismaMock.botExperience.findUniqueOrThrow.mockResolvedValue(expRow);
    prismaMock.botExperienceVersion.findFirst.mockResolvedValue(null);
    prismaMock.botExperienceVersion.create.mockResolvedValue({
      id: 'ver-1',
      experienceId: expRow.id,
      versionNumber: 1,
      config: extractSnapshot(expRow as any),
      publishedAt: new Date(),
      publishedBy: USER_ID,
    });
    prismaMock.botDeployment.findUnique.mockResolvedValue(null);
    prismaMock.botDeployment.create.mockResolvedValue({
      id: 'dep-1',
      format: 'HOSTED_PAGE',
      status: 'PUBLISHED',
      enabled: true,
      publishEpoch: 0,
      unpublishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prismaMock.botExperience.update.mockResolvedValue({
      ...expRow,
      publishedVersionId: 'ver-1',
      version: 2,
    });

    // 1. POST /bots/:botId/experience/publish (200)
    const pubRes = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/publish`)
      .set('Authorization', authHeader())
      .send({});
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.success).toBe(true);

    // 2. POST /bots/:botId/experience/unpublish (200)
    prismaMock.botDeployment.updateMany.mockResolvedValue({ count: 3 });
    const unpubRes = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/unpublish`)
      .set('Authorization', authHeader());
    expect(unpubRes.status).toBe(200);

    // 3. GET /bots/:botId/experience/versions (200)
    prismaMock.botExperienceVersion.findMany.mockResolvedValue([
      {
        id: 'ver-1',
        experienceId: expRow.id,
        versionNumber: 1,
        config: extractSnapshot(expRow as any),
        publishedAt: new Date(),
        publishedBy: USER_ID,
      },
    ]);
    const listRes = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience/versions`)
      .set('Authorization', authHeader());
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);

    // 4. GET /bots/:botId/experience/versions/:versionId (200)
    prismaMock.botExperienceVersion.findFirst.mockResolvedValue({
      id: '11111111-2222-3333-4444-555555555555',
      experienceId: expRow.id,
      versionNumber: 1,
      config: extractSnapshot(expRow as any),
      publishedAt: new Date(),
      publishedBy: USER_ID,
    });
    const getVerRes = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience/versions/11111111-2222-3333-4444-555555555555`)
      .set('Authorization', authHeader());
    expect(getVerRes.status).toBe(200);
    expect(getVerRes.body.data.id).toBe('11111111-2222-3333-4444-555555555555');

    // 5. POST /bots/:botId/experience/versions/:versionId/rollback (200)
    const rollbackRes = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/versions/11111111-2222-3333-4444-555555555555/rollback`)
      .set('Authorization', authHeader());
    expect(rollbackRes.status).toBe(200);
  });

  it('CP-2.8: AGENT role is forbidden (403) from publish, unpublish, and rollback', async () => {
    arrangeRoute('AGENT');

    const pub = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/publish`)
      .set('Authorization', authHeader());
    expect(pub.status).toBe(403);

    const unpub = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/unpublish`)
      .set('Authorization', authHeader());
    expect(unpub.status).toBe(403);

    const rollback = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/versions/11111111-2222-3333-4444-555555555555/rollback`)
      .set('Authorization', authHeader());
    expect(rollback.status).toBe(403);

    const versions = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience/versions`)
      .set('Authorization', authHeader());
    expect(versions.status).toBe(403);
  });
});
