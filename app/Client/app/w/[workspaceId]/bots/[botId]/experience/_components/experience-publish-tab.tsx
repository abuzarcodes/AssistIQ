'use client';

import { useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import {
  getExperienceVersion,
  listExperienceVersions,
  publishExperience,
  rollbackExperienceVersion,
  unpublishExperience,
  type ExperienceResponse,
  type ExperienceVersion,
} from '@/lib/api/experience';

interface ExperiencePublishTabProps {
  botId: string;
  draft: ExperienceResponse;
  /** True while the draft holds edits the server has not confirmed. */
  dirty: boolean;
  version: number;
  canManage: boolean;
  /** Client validation failures; publishing also requires a clean bill here. */
  validationMessages: string[];
  /** Studio's response handler — updates draft, badges and the header at once. */
  onPublished: (response: ExperienceResponse) => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/**
 * The Publish tab (CP-13.1 – CP-13.5).
 *
 * Publishing snapshots the **saved** draft: with unsaved edits the button stays
 * off and says so, rather than publishing something the owner has not reviewed.
 * After publish, unpublish, or rollback the server's response flows through
 * `onPublished`, so the Deploy badges and the page header move in the same
 * render — nothing here reloads the page to catch up.
 *
 * Versions are read-only history. Restoring copies a snapshot into the draft;
 * the live experience keeps serving the published version until the owner saves
 * and publishes again, and the confirm dialog says exactly that.
 */
export function ExperiencePublishTab({
  botId,
  draft,
  dirty,
  version,
  canManage,
  validationMessages,
  onPublished,
}: ExperiencePublishTabProps) {
  const { toast } = useToast();
  const [versions, setVersions] = useState<ExperienceVersion[] | null>(null);
  const [versionsFailed, setVersionsFailed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExperienceVersion | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ExperienceVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  // Mount fetch: the tab remounts on every open, so history is always fresh.
  useEffect(() => {
    let active = true;
    listExperienceVersions(botId).then(
      (result) => {
        if (active) setVersions(result);
      },
      () => {
        if (active) setVersionsFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [botId]);

  const nameOk = draft.effective.displayName.trim().length > 0;
  const blockers: string[] = [];
  if (dirty) blockers.push('Save your changes first — publishing snapshots the saved draft.');
  if (!nameOk) blockers.push('A display name (or bot name) is required before publishing.');
  blockers.push(...validationMessages);

  const liveCount = draft.deployments.filter(
    (deployment) => deployment.status === 'PUBLISHED' && deployment.enabled,
  ).length;

  async function handlePublish() {
    if (blockers.length > 0 || publishing) return;
    setPublishing(true);
    setActionError(null);
    try {
      const response = await publishExperience(botId, version);
      onPublished(response);
      toast(
        `Published v${response.publishedVersion?.versionNumber ?? ''}`.trim(),
        'success',
      );
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Publishing failed. Try again.',
      );
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish() {
    setUnpublishing(true);
    setActionError(null);
    try {
      const response = await unpublishExperience(botId);
      onPublished(response);
      setUnpublishOpen(false);
      toast('Unpublished — visitors no longer have access', 'info');
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Unpublishing failed. Try again.',
      );
    } finally {
      setUnpublishing(false);
    }
  }

  async function openDetail(versionSummary: ExperienceVersion) {
    setDetail(versionSummary);
    setDetailFailed(false);
    try {
      const full = await getExperienceVersion(botId, versionSummary.id);
      setDetail(full);
    } catch {
      setDetailFailed(true);
    }
  }

  async function handleRestore() {
    if (!restoreTarget || restoring) return;
    setRestoring(true);
    setActionError(null);
    try {
      const response = await rollbackExperienceVersion(botId, restoreTarget.id);
      onPublished(response);
      setRestoreTarget(null);
      toast(`v${restoreTarget.versionNumber} restored into the draft`, 'success');
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : 'Restoring failed. Try again.',
      );
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="publish-status">
            <h3 id="publish-status" className="text-sm font-semibold text-foreground">
              Publish status
            </h3>
            {draft.publishedVersion ? (
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                v{draft.publishedVersion.versionNumber} published{' '}
                {formatDate(draft.publishedVersion.publishedAt)}
                {liveCount > 0
                  ? `, serving ${liveCount} live deployment${liveCount === 1 ? '' : 's'}.`
                  : ' — no deployment is currently serving it.'}
              </p>
            ) : (
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                Never published. The Design, Preview and Deploy tabs all work
                against the draft; visitors see nothing until the first publish.
              </p>
            )}

            {blockers.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            )}

            {actionError && (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {actionError}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!canManage || publishing || blockers.length > 0}
                loading={publishing}
                onClick={() => void handlePublish()}
              >
                {draft.publishedVersion ? 'Publish new version' : 'Publish'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canManage || unpublishing || !draft.publishedVersion}
                onClick={() => setUnpublishOpen(true)}
              >
                Unpublish
              </Button>
            </div>
            {!canManage && (
              <p className="mt-2 text-xs text-muted-foreground">
                Publishing needs bot management access.
              </p>
            )}
          </section>

          <section aria-labelledby="publish-history">
            <div className="flex items-center gap-2">
              <History aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              <h3 id="publish-history" className="text-sm font-semibold text-foreground">
                Version history
              </h3>
            </div>

            {versions === null ? (
              versionsFailed ? (
                <p className="mt-3 text-xs text-destructive">
                  Could not load version history. Reopening this tab tries again.
                </p>
              ) : (
                <div
                  role="status"
                  aria-label="Loading versions"
                  className="mt-3 space-y-2"
                >
                  {[0, 1].map((index) => (
                    <span
                      key={index}
                      className="block h-12 animate-pulse rounded-lg bg-muted"
                    />
                  ))}
                </div>
              )
            ) : versions.length === 0 ? (
              <p className="mt-3 text-[13px] text-muted-foreground">
                No versions yet. The first publish creates v1.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {versions.map((entry) => {
                  const isCurrent = draft.publishedVersionId === entry.id;
                  return (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-3 py-2.5"
                    >
                      <span className="text-sm font-semibold text-foreground">
                        v{entry.versionNumber}
                      </span>
                      {isCurrent && <Badge variant="success">Current</Badge>}
                      <span className="text-xs text-muted-foreground">
                        {formatDate(entry.publishedAt)}
                      </span>
                      <span
                        className="text-xs text-muted-foreground"
                        title={`Published by user ${entry.publishedBy}`}
                      >
                        by {entry.publishedBy.slice(0, 8)}…
                      </span>
                      <span className="ml-auto flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void openDetail(entry)}
                        >
                          View
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={!canManage}
                          onClick={() => setRestoreTarget(entry)}
                        >
                          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                          Restore
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside
          aria-label="About publishing"
          className="rounded-xl border border-border bg-card px-4 py-4"
        >
          <h3 className="text-sm font-semibold text-foreground">
            How publishing works
          </h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-muted-foreground marker:text-muted-foreground">
            <li>Save the draft, then publish it as the next version.</li>
            <li>Every live deployment serves the new version at once.</li>
            <li>Versions are immutable — restoring copies one back into the draft.</li>
            <li>Unpublishing revokes visitor access immediately.</li>
          </ol>
        </aside>
      </div>

      <Dialog
        open={unpublishOpen}
        onClose={() => setUnpublishOpen(false)}
        title="Unpublish this experience?"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Visitors lose access immediately, including conversations already
            open. The draft and every version stay exactly as they are, so you
            can republish any time.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setUnpublishOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={unpublishing}
              onClick={() => void handleUnpublish()}
            >
              Unpublish now
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={detail !== null} onClose={() => setDetail(null)} title={detail ? `Version ${detail.versionNumber}` : 'Version'}>
        {detail && (
          <div className="space-y-4">
            <p className="text-xs leading-5 text-muted-foreground">
              Published {formatDate(detail.publishedAt)}, snapshot taken at publish
              time. Read-only.
            </p>
            {detailFailed ? (
              <p role="alert" className="text-xs text-destructive">
                Could not load this snapshot. The list entry above is still accurate.
              </p>
            ) : (
              <VersionSummary config={detail.config} />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                Close
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={!canManage}
                onClick={() => {
                  setDetail(null);
                  setRestoreTarget(detail);
                }}
              >
                Restore this version
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        title={restoreTarget ? `Restore v${restoreTarget.versionNumber} into the draft?` : 'Restore version'}
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            The draft takes this version&apos;s settings. Nothing goes live until
            you save and publish — restore on its own changes no visitor&apos;s
            chat.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRestoreTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={restoring}
              onClick={() => void handleRestore()}
            >
              Restore into draft
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** The notable fields of a version snapshot, read-only (CP-13.4). */
function VersionSummary({ config }: { config: ExperienceVersion['config'] }) {
  const rows: [string, string][] = [
    ['Name', config.displayName || 'Inherited from bot'],
    ['Accent', config.accentColor],
    ['Theme', config.themeMode],
    ['Widget', `${config.widgetPosition} · ${config.widgetPanelWidth} by ${config.widgetPanelHeight}`],
    ['Welcome', config.welcomeMessage || 'Inherited from bot'],
    ['Questions', String(config.suggestedQuestions.length)],
    ['Opens with', config.firstOpenBehavior],
    ['Timestamps', config.showTimestamps ? 'On' : 'Off'],
    ['Auto-open', config.autoOpen ? 'On' : 'Off'],
    ['Branding', config.showBranding ? 'Shown' : 'Hidden'],
  ];

  return (
    <dl className="space-y-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-xs">
      {rows.map(([term, value]) => (
        <div key={term} className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">{term}</dt>
          <dd className="min-w-0 truncate text-right font-medium text-foreground">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
