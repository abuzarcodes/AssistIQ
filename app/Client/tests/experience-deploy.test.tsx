import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ExperienceDeployTab } from '@/app/w/[workspaceId]/bots/[botId]/experience/_components/experience-deploy-tab';
import { CodeSnippet } from '@/components/ui/code-snippet';
import type { ExperienceDeployment } from '@/lib/api/experience';

/**
 * CP-12.2 – CP-12.12 — the deployment management UI.
 *
 * Each card installs from its generated snippet, mutations write through and
 * update badges without a reload, and the slug editor surfaces a taken address
 * inline. Snippets and domains are real client calls (mocked at the module
 * boundary); the copy buttons use the real clipboard path with a stub.
 */

vi.mock('@/lib/api/deployments', () => ({
  getDeploymentSnippet: vi.fn(),
  updateDeployment: vi.fn(),
  listDeploymentDomains: vi.fn(),
  addDeploymentDomain: vi.fn(),
  removeDeploymentDomain: vi.fn(),
}));

const deploymentsApi = await import('@/lib/api/deployments');

const BOT = '11111111-1111-1111-1111-111111111111';

function deployment(
  overrides: Partial<ExperienceDeployment> = {},
): ExperienceDeployment {
  return {
    id: 'dep-hosted',
    experienceId: 'exp-1',
    botId: BOT,
    workspaceId: 'ws-1',
    format: 'HOSTED_PAGE',
    status: 'PUBLISHED',
    slug: 'acme-help',
    enabled: true,
    unpublishedAt: null,
    publishEpoch: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const threeDeployments: ExperienceDeployment[] = [
  deployment(),
  deployment({ id: 'dep-widget', format: 'WIDGET', slug: null }),
  deployment({ id: 'dep-iframe', format: 'IFRAME', slug: null }),
];

function mockSnippets() {
  vi.mocked(deploymentsApi.getDeploymentSnippet).mockImplementation(
    async (_botId: string, deploymentId: string) => {
      if (deploymentId === 'dep-hosted') {
        return {
          deploymentId,
          format: 'HOSTED_PAGE',
          snippet: 'https://chat.example.com/chat/acme-help',
          url: 'https://chat.example.com/chat/acme-help',
        };
      }
      if (deploymentId === 'dep-widget') {
        return {
          deploymentId,
          format: 'WIDGET',
          snippet:
            '<script src="https://chat.example.com/widget/loader.js" data-deployment-id="dep-widget" async defer></script>',
          url: 'https://chat.example.com/widget/loader.js',
        };
      }
      return {
        deploymentId,
        format: 'IFRAME',
        snippet:
          '<iframe src="https://chat.example.com/chat/embed/dep-iframe" width="100%" height="600px" frameborder="0" allow="clipboard-write"></iframe>',
        url: 'https://chat.example.com/chat/embed/dep-iframe',
      };
    },
  );
  vi.mocked(deploymentsApi.listDeploymentDomains).mockResolvedValue([
    {
      id: 'dom-1',
      deploymentId: 'dep-widget',
      domain: 'example.com',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
  ]);
}

const renderTab = (overrides = {}) =>
  render(
    <ExperienceDeployTab
      botId={BOT}
      deployments={threeDeployments}
      onDeploymentsChange={() => {}}
      canManage
      version={3}
      iframeWidth="100%"
      iframeHeight="600px"
      {...overrides}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockSnippets();
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.spyOn(window, 'open').mockReturnValue(null);
});

describe('Experience Deploy tab', () => {
  it('lists all three formats with status badges and install steps', async () => {
    renderTab();

    for (const name of ['Hosted page', 'Widget', 'Iframe']) {
      expect(
        await screen.findByRole('heading', { name }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText('Live')).toHaveLength(3);
    expect(
      screen.getByText(/Publishing a new version updates every live deployment/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Paste the script just before the closing body tag/),
    ).toBeInTheDocument();
  });

  it('copies the hosted URL and opens it in a new tab', async () => {
    renderTab();
    await screen.findByText('https://chat.example.com/chat/acme-help');

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'https://chat.example.com/chat/acme-help',
      ),
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(window.open).toHaveBeenCalledWith(
      'https://chat.example.com/chat/acme-help',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('disables a deployment and updates its badge without a reload', async () => {
    const onDeploymentsChange = vi.fn();
    vi.mocked(deploymentsApi.updateDeployment).mockImplementation(
      async (_botId, deploymentId, input) => ({
        ...deployment({ id: deploymentId }),
        enabled: input.enabled ?? true,
        domains: [],
      }),
    );

    render(
      <ExperienceDeployTab
        botId={BOT}
        deployments={threeDeployments}
        onDeploymentsChange={onDeploymentsChange}
        canManage
        version={3}
        iframeWidth="100%"
        iframeHeight="600px"
      />,
    );
    await screen.findByText('https://chat.example.com/chat/acme-help');

    const hostedCard = screen
      .getByRole('heading', { name: 'Hosted page' })
      .closest('section')!;
    fireEvent.click(
      within(hostedCard).getByRole('switch', {
        name: 'Enable Hosted page deployment',
      }),
    );

    await waitFor(() =>
      expect(deploymentsApi.updateDeployment).toHaveBeenCalledWith(
        BOT,
        'dep-hosted',
        { enabled: false, expectedVersion: 3 },
      ),
    );
    expect(onDeploymentsChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'dep-hosted', enabled: false }),
      ]),
    );
  });

  it('saves a new slug and reloads the URL, rejecting a taken address', async () => {
    // Make the mock error look like an ApiError for the 409 branch.
    const { ApiError } = await import('@/lib/api-client');
    vi.mocked(deploymentsApi.updateDeployment).mockImplementation(
      async (_botId, deploymentId, input) => {
        if (input.slug === 'taken') throw new ApiError('Taken', 409);
        const slug = input.slug ?? null;
        vi.mocked(deploymentsApi.getDeploymentSnippet).mockResolvedValueOnce({
          deploymentId,
          format: 'HOSTED_PAGE',
          snippet: `https://chat.example.com/chat/${slug}`,
          url: `https://chat.example.com/chat/${slug}`,
        });
        return { ...deployment({ id: deploymentId }), slug, domains: [] };
      },
    );

    renderTab();
    await screen.findByText('https://chat.example.com/chat/acme-help');

    const slugField = screen.getByLabelText('Page address');
    fireEvent.change(slugField, { target: { value: 'taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('That address is already taken. Try another.'),
    ).toBeInTheDocument();

    fireEvent.change(slugField, { target: { value: 'acme-support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('https://chat.example.com/chat/acme-support'),
    ).toBeInTheDocument();
  });

  it('renders the widget script with highlighting and manages hostnames', async () => {
    vi.mocked(deploymentsApi.addDeploymentDomain).mockImplementation(
      async (_botId, deploymentId, domain) => ({
        id: 'dom-2',
        deploymentId,
        domain,
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
    );
    vi.mocked(deploymentsApi.removeDeploymentDomain).mockResolvedValue({
      success: true,
    });

    renderTab();

    expect(
      await screen.findByText(/widget\/loader\.js/),
    ).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();

    const hostnameField = screen.getByLabelText('New hostname');
    fireEvent.change(hostnameField, { target: { value: 'not a domain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText(
        'Enter a hostname such as example.com, without scheme or path.',
      ),
    ).toBeInTheDocument();

    fireEvent.change(hostnameField, { target: { value: 'shop.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText('shop.example.com'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove example.com' }),
    );
    await waitFor(() =>
      expect(screen.queryByText('example.com')).not.toBeInTheDocument(),
    );
  });

  it('shows the iframe dimensions from the Layout settings', async () => {
    renderTab();

    expect(await screen.findByText(/chat\/embed\/dep-iframe/)).toBeInTheDocument();
    expect(
      screen.getByText(/Embeds at 100% by 600px, from your Layout settings/),
    ).toBeInTheDocument();
  });

  it('disables every control for read-only users', async () => {
    renderTab({ canManage: false });
    await screen.findByText('https://chat.example.com/chat/acme-help');

    for (const name of [
      'Enable Hosted page deployment',
      'Enable Widget deployment',
      'Enable Iframe deployment',
    ]) {
      expect(screen.getByRole('switch', { name })).toBeDisabled();
    }
    expect(screen.getByLabelText('Page address')).toBeDisabled();
    expect(screen.getByLabelText('New hostname')).toBeDisabled();
  });

  it('warns on cards that have never been published', async () => {
    render(
      <ExperienceDeployTab
        botId={BOT}
        deployments={[deployment({ status: 'DRAFT' })]}
        onDeploymentsChange={() => {}}
        canManage
        version={3}
        iframeWidth="100%"
        iframeHeight="600px"
      />,
    );

    expect(await screen.findByText('Not published')).toBeInTheDocument();
    expect(
      screen.getByText(/publish the experience first/),
    ).toBeInTheDocument();
  });
});

describe('CodeSnippet', () => {
  it('copies the exact code and confirms', async () => {
    const code = '<script src="x.js" async defer></script>';
    const { container } = render(
      <CodeSnippet code={code} language="HTML" copyLabel="Copy script" />,
    );

    // Highlighting splits the source across spans; the concatenated text is exact.
    expect(container.querySelector('code')).toHaveTextContent(code);
    fireEvent.click(screen.getByRole('button', { name: 'Copy script' }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code),
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
