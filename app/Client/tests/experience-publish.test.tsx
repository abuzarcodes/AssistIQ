import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { ExperiencePublishTab } from '@/app/w/[workspaceId]/bots/[botId]/experience/_components/experience-publish-tab';
import type {
  ExperienceConfigSnapshot,
  ExperienceResponse,
  ExperienceVersion,
} from '@/lib/api/experience';

/**
 * CP-13.1 – CP-13.5 — publishing and version management.
 *
 * Publish snapshots the saved draft (dirty drafts cannot publish), unpublish
 * takes a confirmation, versions list newest-first with a read-only detail
 * view, and restore copies a snapshot into the draft without publishing.
 * Every lifecycle call flows through `onPublished` — the studio path that
 * moves Deploy badges and the header in the same render.
 */

vi.mock('@/lib/api/experience', () => ({
  publishExperience: vi.fn(),
  unpublishExperience: vi.fn(),
  listExperienceVersions: vi.fn(),
  getExperienceVersion: vi.fn(),
  rollbackExperienceVersion: vi.fn(),
}));

const api = await import('@/lib/api/experience');

const BOT = '11111111-1111-1111-1111-111111111111';

function snapshot(): ExperienceConfigSnapshot {
  return {
    displayName: 'Helper',
    botAvatarUrl: null,
    businessLogoUrl: null,
    accentColor: '#ff6b35',
    userBubbleColor: null,
    botBubbleColor: null,
    themeMode: 'system',
    themePreset: null,
    hostedPageTitle: null,
    hostedPageDescription: null,
    widgetPosition: 'bottom-right',
    widgetLauncherLabel: null,
    widgetPanelWidth: 400,
    widgetPanelHeight: 600,
    widgetMobileBehavior: 'fullscreen',
    iframeWidth: '100%',
    iframeHeight: '600px',
    welcomeMessage: 'Hello there',
    welcomeSubtitle: null,
    inputPlaceholder: null,
    suggestedQuestions: [],
    firstOpenBehavior: 'welcome',
    showTimestamps: true,
    autoOpen: false,
    privacyPolicyUrl: null,
    termsUrl: null,
    showBranding: true,
  };
}

function experience(overrides: Partial<ExperienceResponse> = {}): ExperienceResponse {
  return {
    id: 'exp-1',
    botId: BOT,
    ...snapshot(),
    version: 3,
    publishedVersionId: 'ver-2',
    publishedVersion: {
      id: 'ver-2',
      experienceId: 'exp-1',
      versionNumber: 2,
      config: snapshot(),
      publishedAt: '2026-10-20T00:00:00.000Z',
      publishedBy: 'user-1',
    },
    deployments: [],
    effective: {
      displayName: 'Helper',
      welcomeMessage: 'Hello there',
      suggestedQuestions: [],
      isDisplayNameOverridden: true,
      isWelcomeMessageOverridden: true,
      isSuggestedQuestionsOverridden: false,
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function versionEntry(
  overrides: Partial<ExperienceVersion> = {},
): ExperienceVersion {
  return {
    id: 'ver-2',
    experienceId: 'exp-1',
    versionNumber: 2,
    config: snapshot(),
    publishedAt: '2026-10-20T00:00:00.000Z',
    publishedBy: 'user-1',
    ...overrides,
  };
}

const renderTab = (overrides = {}) =>
  render(
    <ToastProvider>
      <ExperiencePublishTab
        botId={BOT}
        draft={experience()}
        dirty={false}
        version={3}
        canManage
        validationMessages={[]}
        onPublished={() => {}}
        {...overrides}
      />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listExperienceVersions).mockResolvedValue([
    versionEntry(),
    versionEntry({ id: 'ver-1', versionNumber: 1, publishedAt: '2026-10-10T00:00:00.000Z' }),
  ]);
  vi.mocked(api.getExperienceVersion).mockImplementation(async (_botId, id) =>
    versionEntry({ id }),
  );
});

describe('Experience Publish tab', () => {
  it('shows the status and publishes a new version', async () => {
    const onPublished = vi.fn();
    const published = experience({
      version: 4,
      publishedVersionId: 'ver-3',
      publishedVersion: {
        ...versionEntry({ id: 'ver-3', versionNumber: 3 }),
      },
    });
    vi.mocked(api.publishExperience).mockResolvedValue(published);
    renderTab({ onPublished });

    expect(await screen.findByText(/v2 published/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish new version' }));
    await waitFor(() =>
      expect(api.publishExperience).toHaveBeenCalledWith(BOT, 3),
    );
    expect(onPublished).toHaveBeenCalledWith(published);
  });

  it('blocks publishing while the draft is unsaved or invalid', async () => {
    renderTab({
      dirty: true,
      validationMessages: ['The accent colour must be a hex value.'],
    });
    await screen.findByText(/Version history/);

    expect(
      screen.getByRole('button', { name: 'Publish new version' }),
    ).toBeDisabled();
    expect(screen.getByText(/Save your changes first/)).toBeInTheDocument();
    expect(
      screen.getByText('The accent colour must be a hex value.'),
    ).toBeInTheDocument();
    expect(api.publishExperience).not.toHaveBeenCalled();
  });

  it('unpublishes only after confirmation', async () => {
    const onPublished = vi.fn();
    vi.mocked(api.unpublishExperience).mockResolvedValue(
      experience({ publishedVersionId: null, publishedVersion: null }),
    );
    renderTab({ onPublished });
    await screen.findByText(/Version history/);

    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    expect(
      screen.getByText('Unpublish this experience?'),
    ).toBeInTheDocument();
    expect(api.unpublishExperience).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Unpublish now' }));
    await waitFor(() =>
      expect(api.unpublishExperience).toHaveBeenCalledWith(BOT),
    );
    expect(onPublished).toHaveBeenCalled();
  });

  it('lists versions newest-first with a read-only detail view', async () => {
    renderTab();

    const rows = await screen.findAllByText(/^v\d$/);
    expect(rows.map((row) => row.textContent)).toEqual(['v2', 'v1']);
    expect(screen.getByText('Current')).toBeInTheDocument();

    const v1Row = screen.getByText('v1').closest('li')!;
    fireEvent.click(within(v1Row).getByRole('button', { name: 'View' }));

    await waitFor(() =>
      expect(api.getExperienceVersion).toHaveBeenCalledWith(BOT, 'ver-1'),
    );
    expect(await screen.findByText('Version 2')).toBeInTheDocument();
    expect(screen.getByText('#ff6b35')).toBeInTheDocument();
  });

  it('restores a version into the draft without publishing', async () => {
    const onPublished = vi.fn();
    const rolledBack = experience({ version: 4 });
    vi.mocked(api.rollbackExperienceVersion).mockResolvedValue(rolledBack);
    renderTab({ onPublished });
    await screen.findByText('v1');

    const v1Row = screen.getByText('v1').closest('li')!;
    fireEvent.click(within(v1Row).getByRole('button', { name: 'Restore' }));

    expect(
      screen.getByText(/nothing goes live until you save and publish/i),
    ).toBeInTheDocument();
    expect(api.rollbackExperienceVersion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Restore into draft' }));
    await waitFor(() =>
      expect(api.rollbackExperienceVersion).toHaveBeenCalledWith(BOT, 'ver-1'),
    );
    expect(onPublished).toHaveBeenCalledWith(rolledBack);
  });

  it('surfaces a publish failure inline', async () => {
    vi.mocked(api.publishExperience).mockRejectedValueOnce(
      new ApiError('Taken by someone else', 409),
    );
    renderTab();
    await screen.findByText(/Version history/);

    fireEvent.click(screen.getByRole('button', { name: 'Publish new version' }));
    expect(await screen.findByText('Taken by someone else')).toBeInTheDocument();
  });

  it('gives read-only users the history but no actions', async () => {
    renderTab({ canManage: false });
    await screen.findByText('v1');

    expect(
      screen.getByRole('button', { name: 'Publish new version' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unpublish' })).toBeDisabled();
    expect(
      screen.getAllByRole('button', { name: 'Restore' })[0],
    ).toBeDisabled();
  });
});
