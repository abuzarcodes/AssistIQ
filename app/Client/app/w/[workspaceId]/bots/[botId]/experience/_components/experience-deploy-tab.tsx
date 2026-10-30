'use client';

import { useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeSnippet, copyTextToClipboard } from '@/components/ui/code-snippet';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api-client';
import {
  addDeploymentDomain,
  getDeploymentSnippet,
  listDeploymentDomains,
  removeDeploymentDomain,
  updateDeployment,
  type Deployment,
  type DeploymentDomain,
} from '@/lib/api/deployments';
import type {
  DeploymentFormat,
  ExperienceDeployment,
} from '@/lib/api/experience';

interface ExperienceDeployTabProps {
  botId: string;
  deployments: ExperienceDeployment[];
  onDeploymentsChange: (deployments: ExperienceDeployment[]) => void;
  canManage: boolean;
  /** The experience version, sent as the concurrency token on every mutation. */
  version: number;
  /** The draft's iframe dimensions, which the iframe snippet is built from. */
  iframeWidth: string;
  iframeHeight: string;
}

type SnippetState = Record<
  string,
  { code: string; url: string } | { error: string } | undefined
>;

const FORMAT_ORDER: DeploymentFormat[] = ['HOSTED_PAGE', 'WIDGET', 'IFRAME'];

const FORMAT_NAMES: Record<DeploymentFormat, string> = {
  HOSTED_PAGE: 'Hosted page',
  WIDGET: 'Widget',
  IFRAME: 'Iframe',
};

function statusBadge(deployment: ExperienceDeployment): {
  variant: 'default' | 'success' | 'warning';
  label: string;
} {
  if (deployment.status === 'PUBLISHED' && deployment.enabled) {
    return { variant: 'success', label: 'Live' };
  }
  if (deployment.status === 'PUBLISHED') {
    return { variant: 'warning', label: 'Paused' };
  }
  if (deployment.status === 'UNPUBLISHED') {
    return { variant: 'default', label: 'Unpublished' };
  }
  return { variant: 'default', label: 'Not published' };
}

/**
 * The Deploy tab (CP-12.2 – CP-12.11).
 *
 * One card per format with its install artifact, an enable switch, and — for the
 * hosted page — the slug editor. Mutations write through `updateDeployment` and
 * replace the card's deployment from the response, so badges update without a
 * reload (CP-12.9). Snippets and domains load on mount; the tab remounts on
 * every open, so the data is always fresh.
 *
 * Nothing here publishes: a card whose snapshot is not `PUBLISHED` says so
 * plainly, and installing its snippet serves whatever was published last.
 */
export function ExperienceDeployTab({
  botId,
  deployments,
  onDeploymentsChange,
  canManage,
  version,
  iframeWidth,
  iframeHeight,
}: ExperienceDeployTabProps) {
  const disabled = !canManage;
  const [snippets, setSnippets] = useState<SnippetState>({});
  const [snippetsFailed, setSnippetsFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cardError, setCardError] = useState<Record<string, string | null>>({});
  const [copiedUrl, setCopiedUrl] = useState(false);

  const ordered = useMemo(
    () =>
      [...deployments].sort(
        (a, b) => FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format),
      ),
    [deployments],
  );

  // Load one card's install code. Every setState here runs in a promise
  // continuation, never synchronously in an effect body.
  async function loadSnippet(deployment: Deployment): Promise<boolean> {
    try {
      const snippet = await getDeploymentSnippet(botId, deployment.id);
      setSnippets((previous) => ({
        ...previous,
        [deployment.id]: { code: snippet.snippet, url: snippet.url },
      }));
      return true;
    } catch {
      setSnippets((previous) => ({
        ...previous,
        [deployment.id]: { error: 'Could not load the install code.' },
      }));
      return false;
    }
  }

  // Mount fetch: the tab remounts on every open, so this is the freshness check.
  useEffect(() => {
    let active = true;

    void (async () => {
      const results = await Promise.all(
        ordered.map(async (deployment) => {
          try {
            const snippet = await getDeploymentSnippet(botId, deployment.id);
            return { id: deployment.id, value: { code: snippet.snippet, url: snippet.url } } as const;
          } catch {
            return { id: deployment.id, value: { error: 'Could not load the install code.' } } as const;
          }
        }),
      );
      if (!active) return;

      const next: SnippetState = {};
      let failed = false;
      for (const { id, value } of results) {
        next[id] = value;
        if ('error' in value) failed = true;
      }
      setSnippets(next);
      setSnippetsFailed(failed);
    })();

    return () => {
      active = false;
    };
  }, [botId, ordered]);

  function replaceDeployment(updated: Deployment) {
    onDeploymentsChange(
      deployments.map((current) =>
        current.id === updated.id ? { ...current, ...updated } : current,
      ),
    );
  }

  function fail(id: string, message: string) {
    setCardError((previous) => ({ ...previous, [id]: message }));
  }

  async function copyUrl(url: string) {
    if (await copyTextToClipboard(url)) {
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } else {
      fail(
        ordered.find((deployment) => {
          const snippet = snippets[deployment.id];
          return snippet && 'url' in snippet && snippet.url === url;
        })?.id ?? '',
        'Copy failed — select the address manually.',
      );
    }
  }

  async function toggleEnabled(deployment: ExperienceDeployment, enabled: boolean) {
    setBusy(`${deployment.id}:enabled`);
    setCardError((previous) => ({ ...previous, [deployment.id]: null }));
    try {
      const updated = await updateDeployment(botId, deployment.id, {
        enabled,
        expectedVersion: version,
      });
      replaceDeployment(updated);
    } catch (caught) {
      fail(
        deployment.id,
        caught instanceof ApiError
          ? caught.message
          : 'Could not update this deployment.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
        Each format installs from the last published snapshot. Publishing a new
        version updates every live deployment — no code changes needed.
      </p>

      {snippetsFailed && (
        <p role="alert" className="mt-4 text-xs text-destructive">
          Some install snippets could not be loaded. Reopening this tab tries
          again.
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        {ordered.map((deployment) =>
          deployment.format === 'HOSTED_PAGE' ? (
            <HostedCard
              key={deployment.id}
              deployment={deployment}
              snippet={snippets[deployment.id]}
              disabled={disabled}
              busy={busy}
              error={cardError[deployment.id] ?? null}
              copiedUrl={copiedUrl}
              onToggle={(enabled) => void toggleEnabled(deployment, enabled)}
              onCopyUrl={() => {
                const snippet = snippets[deployment.id];
                if (snippet && 'url' in snippet) void copyUrl(snippet.url);
              }}
              onSlugSaved={(updated) => {
                replaceDeployment(updated);
                void loadSnippet(updated);
              }}
              onError={(message) => fail(deployment.id, message)}
              botId={botId}
              version={version}
              setBusy={setBusy}
            />
          ) : deployment.format === 'WIDGET' ? (
            <WidgetCard
              key={deployment.id}
              deployment={deployment}
              snippet={snippets[deployment.id]}
              disabled={disabled}
              busy={busy}
              error={cardError[deployment.id] ?? null}
              onToggle={(enabled) => void toggleEnabled(deployment, enabled)}
              botId={botId}
            />
          ) : (
            <IframeCard
              key={deployment.id}
              deployment={deployment}
              snippet={snippets[deployment.id]}
              disabled={disabled}
              busy={busy}
              error={cardError[deployment.id] ?? null}
              onToggle={(enabled) => void toggleEnabled(deployment, enabled)}
              iframeWidth={iframeWidth}
              iframeHeight={iframeHeight}
            />
          ),
        )}

        {ordered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No deployments yet. They are created with the experience.
          </p>
        )}
      </div>
    </div>
  );
}

interface CardShellProps {
  deployment: ExperienceDeployment;
  disabled: boolean;
  busy: string | null;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}

/** The shared card frame: name, status badge, enable switch, error line. */
function CardShell({
  deployment,
  disabled,
  busy,
  error,
  onToggle,
  children,
}: CardShellProps) {
  const badge = statusBadge(deployment);

  return (
    <section
      aria-labelledby={`deploy-${deployment.id}`}
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3
            id={`deploy-${deployment.id}`}
            className="text-sm font-semibold text-foreground"
          >
            {FORMAT_NAMES[deployment.format]}
          </h3>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {deployment.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <Switch
            label={`Enable ${FORMAT_NAMES[deployment.format]} deployment`}
            checked={deployment.enabled}
            disabled={disabled || busy !== null}
            onChange={onToggle}
          />
        </div>
      </div>

      {deployment.status !== 'PUBLISHED' && (
        <p className="px-4 pt-2 text-xs leading-5 text-muted-foreground">
          Not serving visitors yet — publish the experience first. Anything
          installed now shows the last published snapshot, if any.
        </p>
      )}

      <div className="flex flex-1 flex-col gap-4 px-4 py-4">{children}</div>

      {error && (
        <p role="alert" className="border-t border-border px-4 py-2.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

/** Ordered, plain-language steps — the same shape on all three cards. */
function InstallSteps({ steps }: { steps: string[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-xs leading-5 text-muted-foreground marker:text-muted-foreground">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

function SnippetOrLoading({
  snippet,
  language,
  copyLabel,
}: {
  snippet: { code: string; url: string } | { error: string } | undefined;
  language: string;
  copyLabel: string;
}) {
  if (!snippet) {
    return (
      <div
        role="status"
        aria-label="Loading install code"
        className="h-24 animate-pulse rounded-lg bg-muted"
      />
    );
  }
  if ('error' in snippet) {
    return <p className="text-xs text-destructive">{snippet.error}</p>;
  }
  return <CodeSnippet code={snippet.code} language={language} copyLabel={copyLabel} />;
}

interface HostedCardProps {
  deployment: ExperienceDeployment;
  snippet: { code: string; url: string } | { error: string } | undefined;
  disabled: boolean;
  busy: string | null;
  error: string | null;
  copiedUrl: boolean;
  onToggle: (enabled: boolean) => void;
  onCopyUrl: () => void;
  onSlugSaved: (deployment: Deployment) => void;
  onError: (message: string) => void;
  botId: string;
  version: number;
  setBusy: (busy: string | null) => void;
}

/** The hosted page card: shareable URL, slug editor, open-in-new-tab. */
function HostedCard({
  deployment,
  snippet,
  disabled,
  busy,
  error,
  copiedUrl,
  onToggle,
  onCopyUrl,
  onSlugSaved,
  onError,
  botId,
  version,
  setBusy,
}: HostedCardProps) {
  const [slug, setSlug] = useState(deployment.slug ?? '');
  const [slugError, setSlugError] = useState<string | null>(null);
  const key = `${deployment.id}:slug`;
  const saving = busy === key;
  const unchanged = slug.trim().toLowerCase() === (deployment.slug ?? '');

  const url = snippet && 'url' in snippet ? snippet.url : null;

  async function saveSlug() {
    const value = slug.trim().toLowerCase();
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) || value.length < 3 || value.length > 80) {
      setSlugError(
        'Use 3 to 80 lowercase letters and numbers, with single hyphens.',
      );
      return;
    }

    setBusy(key);
    setSlugError(null);
    try {
      const updated = await updateDeployment(botId, deployment.id, {
        slug: value,
        expectedVersion: version,
      });
      onSlugSaved(updated);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setSlugError('That address is already taken. Try another.');
      } else {
        onError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not update the page address.',
        );
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <CardShell
      deployment={deployment}
      disabled={disabled}
      busy={busy}
      error={error}
      onToggle={onToggle}
    >
      {url ? (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
            {url}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={onCopyUrl}
            className="shrink-0"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {copiedUrl ? 'Copied' : 'Copy'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
            className="shrink-0"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Open
          </Button>
        </div>
      ) : (
        <SnippetOrLoading snippet={snippet} language="URL" copyLabel="Copy hosted page URL" />
      )}

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={`deploy-slug-${deployment.id}`}
            label="Page address"
            value={slug}
            disabled={disabled || saving}
            spellCheck={false}
            autoComplete="off"
            maxLength={80}
            error={slugError ?? undefined}
            onChange={(event) => {
              setSlug(event.target.value);
              setSlugError(null);
            }}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || saving || unchanged || slug.trim().length === 0}
          loading={saving}
          onClick={() => void saveSlug()}
          className="mb-[26px] shrink-0"
        >
          Save
        </Button>
      </div>

      <InstallSteps
        steps={[
          'Copy the link above or open it to preview the published page.',
          'Share the link with customers or add it to your site navigation.',
          'Change the page address any time — the old address stops working.',
        ]}
      />
    </CardShell>
  );
}

interface WidgetCardProps {
  deployment: ExperienceDeployment;
  snippet: { code: string; url: string } | { error: string } | undefined;
  disabled: boolean;
  busy: string | null;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  botId: string;
}

/** The widget card: loader snippet plus the domain allowlist. */
function WidgetCard({
  deployment,
  snippet,
  disabled,
  busy,
  error,
  onToggle,
  botId,
}: WidgetCardProps) {
  return (
    <CardShell
      deployment={deployment}
      disabled={disabled}
      busy={busy}
      error={error}
      onToggle={onToggle}
    >
      <SnippetOrLoading
        snippet={snippet}
        language="HTML"
        copyLabel="Copy widget script"
      />

      <InstallSteps
        steps={[
          'Paste the script just before the closing body tag, on every page that should offer chat.',
          'The launcher appears in the corner from your Layout settings; republishing updates it with no code changes.',
          'List below every hostname that embeds the widget, without scheme or path.',
        ]}
      />

      <DomainAllowlist deployment={deployment} botId={botId} disabled={disabled} />
    </CardShell>
  );
}

/**
 * The hostnames recorded for this widget. Stored today and returned with the
 * published config; the page using them for enforcement is server work that
 * has not landed, so the copy below does not promise blocking.
 */
function DomainAllowlist({
  deployment,
  botId,
  disabled,
}: {
  deployment: ExperienceDeployment;
  botId: string;
  disabled: boolean;
}) {
  const [domains, setDomains] = useState<DeploymentDomain[] | null>(null);
  const [domainsFailed, setDomainsFailed] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  // Mount fetch, same freshness reasoning as the snippets.
  useEffect(() => {
    let active = true;
    listDeploymentDomains(botId, deployment.id).then(
      (result) => {
        if (active) setDomains(result);
      },
      () => {
        if (active) setDomainsFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [botId, deployment.id]);

  async function add() {
    const value = draft.trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/.test(value)) {
      setDraftError('Enter a hostname such as example.com, without scheme or path.');
      return;
    }
    if (domains?.some((domain) => domain.domain === value)) {
      setDraftError('That hostname is already listed.');
      return;
    }

    setWorking('add');
    setDraftError(null);
    try {
      const created = await addDeploymentDomain(botId, deployment.id, value);
      setDomains((previous) => [...(previous ?? []), created]);
      setDraft('');
    } catch (caught) {
      setDraftError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not add this hostname.',
      );
    } finally {
      setWorking(null);
    }
  }

  async function remove(domain: DeploymentDomain) {
    setWorking(domain.id);
    try {
      await removeDeploymentDomain(botId, deployment.id, domain.id);
      setDomains((previous) =>
        (previous ?? []).filter((entry) => entry.id !== domain.id),
      );
    } catch {
      setDraftError('Could not remove that hostname. Try again.');
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-foreground">
        Allowed hostnames
      </span>

      {domains === null ? (
        domainsFailed ? (
          <p className="text-xs text-destructive">
            Could not load the hostname list.
          </p>
        ) : (
          <div
            role="status"
            aria-label="Loading hostnames"
            className="h-9 animate-pulse rounded-lg bg-muted"
          />
        )
      ) : domains.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          No hostnames listed yet — record each site that embeds the widget so
          the deployment knows where it runs.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {domains.map((domain) => (
            <li
              key={domain.id}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5"
            >
              <span className="flex-1 truncate text-sm text-foreground">
                {domain.domain}
              </span>
              <button
                type="button"
                aria-label={`Remove ${domain.domain}`}
                disabled={disabled || working !== null}
                onClick={() => void remove(domain)}
                className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={`deploy-domain-${deployment.id}`}
            aria-label="New hostname"
            value={draft}
            disabled={disabled || working !== null}
            spellCheck={false}
            autoComplete="off"
            maxLength={253}
            placeholder="example.com"
            error={draftError ?? undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void add();
              }
            }}
          />
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || working !== null || draft.trim().length === 0}
          loading={working === 'add'}
          onClick={() => void add()}
          className="mb-[26px] shrink-0"
        >
          Add
        </Button>
      </div>
    </div>
  );
}

interface IframeCardProps {
  deployment: ExperienceDeployment;
  snippet: { code: string; url: string } | { error: string } | undefined;
  disabled: boolean;
  busy: string | null;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  iframeWidth: string;
  iframeHeight: string;
}

/** The iframe card: embed snippet with the draft's dimensions. */
function IframeCard({
  deployment,
  snippet,
  disabled,
  busy,
  error,
  onToggle,
  iframeWidth,
  iframeHeight,
}: IframeCardProps) {
  return (
    <CardShell
      deployment={deployment}
      disabled={disabled}
      busy={busy}
      error={error}
      onToggle={onToggle}
    >
      <SnippetOrLoading
        snippet={snippet}
        language="HTML"
        copyLabel="Copy iframe embed code"
      />

      <p className="text-xs leading-5 text-muted-foreground">
        Embeds at {iframeWidth} by {iframeHeight}, from your Layout settings.
        Change the dimensions there and the snippet updates on your next visit —
        already-pasted embeds keep their own size.
      </p>

      <InstallSteps
        steps={[
          'Paste the iframe where the chat should appear on the page.',
          'Give its container room: the chat fills the frame you size.',
          'Like every format, it serves the last published snapshot.',
        ]}
      />
    </CardShell>
  );
}
