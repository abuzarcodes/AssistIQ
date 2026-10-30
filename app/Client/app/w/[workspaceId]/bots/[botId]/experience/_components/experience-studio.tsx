'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import {
  updateExperience,
  type ExperienceConfigSnapshot,
  type ExperienceDraftPatch,
  type ExperienceResponse,
} from '@/lib/api/experience';
import type { ResolvedBotConfig } from '@/lib/api/botConfig';
import {
  EXPERIENCE_CONFIG_KEYS,
  EXPERIENCE_DEFAULTS,
} from '@/lib/experience/config';
import { UnsavedChangesBar } from '../../_components/unsaved-changes-bar';
import { ExperienceAnalyticsTab } from './experience-analytics-tab';
import { ExperienceDeployTab } from './experience-deploy-tab';
import { ExperienceDesignTab } from './experience-design-tab';
import { ExperiencePreviewTab } from './experience-preview-tab';
import { ExperiencePublishTab } from './experience-publish-tab';
import type {
  ExperienceAvatar,
  ExperienceAvatarChanged,
  ExperienceFallbacks,
} from './experience-types';
import { validateExperience } from './experience-validation';

interface ExperienceStudioProps {
  initialExperience: ExperienceResponse;
  canManage: boolean;
  /** The bot record the page already loaded; used by the avatar uploader and preview. */
  botId: string;
  botName: string;
  avatar: ExperienceAvatar;
  /** Values the bot configuration supplies when an experience field is empty. */
  fallbacks: ExperienceFallbacks;
  /** The bot's saved configuration, used only to generate test answers. */
  aiDraft: ResolvedBotConfig;
  /** Lets the page keep its published-status badge in step with saves. */
  onExperienceChange?: (experience: ExperienceResponse) => void;
  /** Lets the page keep the bot avatar in step with uploads and deletions. */
  onAvatarChanged?: ExperienceAvatarChanged;
}

export type ExperienceTabId =
  | 'design'
  | 'preview'
  | 'publish'
  | 'deploy'
  | 'analytics';

/**
 * The fields the draft owns, shared with the Design tab's reset.
 *
 * Comparing exactly these (rather than the whole response) keeps server-side
 * metadata — version, deployments, effective values, timestamps — out of the
 * dirty check.
 */
const CONFIG_KEYS = EXPERIENCE_CONFIG_KEYS;

/**
 * Build the PATCH body: only fields that differ from the last server-confirmed
 * draft, plus the required concurrency token. Deep comparison matters for
 * `suggestedQuestions`; a shallow per-section check would miss a reordered list.
 */
function buildPatch(
  saved: ExperienceResponse,
  draft: ExperienceResponse,
  version: number,
): ExperienceDraftPatch {
  const patch: Record<string, unknown> = { expectedVersion: version };
  for (const key of CONFIG_KEYS) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(saved[key])) {
      patch[key] = draft[key];
    }
  }
  return patch as ExperienceDraftPatch;
}

/**
 * The Studio's working surface (Phase 8).
 *
 * One draft object, one save request. `dirty` compares the editable fields with
 * the last server-confirmed values; the save bar, the `beforeunload` guard and
 * the per-tab dot all derive from it. A failed save preserves every edit, and a
 * 409 opens a conflict dialog instead of overwriting another user's work.
 */
export function ExperienceStudio({
  initialExperience,
  canManage,
  botId,
  botName,
  avatar,
  fallbacks,
  aiDraft,
  onExperienceChange,
  onAvatarChanged,
}: ExperienceStudioProps) {
  const { toast } = useToast();

  const [draft, setDraft] = useState<ExperienceResponse>(initialExperience);
  const [saved, setSaved] = useState<ExperienceResponse>(initialExperience);
  const [version, setVersion] = useState(initialExperience.version);
  const [activeTab, setActiveTab] = useState<ExperienceTabId>('design');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ExperienceResponse | null>(null);

  /**
   * The deployments the Deploy tab manages. Lifted here (rather than living in
   * the tab) so saves, conflict resolutions — and, in Phase 13, publishing —
   * update the badges through the same response path as the draft.
   */
  const [deployments, setDeployments] = useState(initialExperience.deployments);

  const applyResponse = useCallback(
    (response: ExperienceResponse) => {
      setDraft(response);
      setSaved(response);
      setVersion(response.version);
      setDeployments(response.deployments);
      onExperienceChange?.(response);
    },
    [onExperienceChange],
  );

  const dirty = useMemo(
    () =>
      CONFIG_KEYS.some(
        (key) => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]),
      ),
    [draft, saved],
  );

  const validation = useMemo(() => validateExperience(draft), [draft]);

  // A browser-level guard against losing a dirty draft on navigation.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const update = useCallback(
    <K extends keyof ExperienceConfigSnapshot>(
      field: K,
      value: ExperienceConfigSnapshot[K],
    ) => {
      setDraft((previous) => ({ ...previous, [field]: value }));
      setSaveError(null);
    },
    [],
  );

  const discard = useCallback(() => {
    if (saved) setDraft(saved);
    setSaveError(null);
  }, [saved]);

  /**
   * Write the platform defaults over the draft. The avatar is not part of this list —
   * it is owned by the bot and uploaded to its own endpoint — and nothing is saved
   * here, so Discard still restores the previous values.
   */
  const resetToDefaults = useCallback(() => {
    setDraft((previous) => {
      const next = { ...previous } as Record<string, unknown>;
      for (const key of EXPERIENCE_CONFIG_KEYS) {
        next[key] = EXPERIENCE_DEFAULTS[key];
      }
      return next as unknown as ExperienceResponse;
    });
    setSaveError(null);
  }, []);

  const save = useCallback(async () => {
    // The server validates too, but a blocked save keeps the draft and points at the
    // field instead of spending a round trip to be told the same thing.
    if (validation.messages.length > 0) {
      setSaveError(validation.messages[0] ?? null);
      return;
    }

    const patch = buildPatch(saved, draft, version);
    if (Object.keys(patch).length <= 1) {
      setDraft(saved);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const response = await updateExperience(saved.botId, patch);
      applyResponse(response);
      toast('Experience saved', 'success');
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const current = (caught.data as { data?: ExperienceResponse } | undefined)
          ?.data;
        if (current) {
          setConflict(current);
        } else {
          setSaveError(
            'This experience was changed elsewhere. Reload to see the latest draft.',
          );
        }
      } else {
        const message =
          caught instanceof ApiError
            ? caught.message
            : 'Failed to save the experience.';
        setSaveError(message);
        toast(message, 'error');
      }
    } finally {
      setSaving(false);
    }
  }, [applyResponse, draft, saved, toast, validation, version]);

  /** Adopt the server's version and drop the local draft. */
  function resolveConflictReload() {
    if (!conflict) return;
    applyResponse(conflict);
    setConflict(null);
    toast('Reloaded the latest draft', 'info');
  }

  /** Re-apply this draft's changed fields on top of the fresh version, once. */
  async function resolveConflictKeepMine() {
    if (!conflict) return;
    const patch = buildPatch(saved, draft, conflict.version);
    setConflict(null);
    setSaving(true);
    setSaveError(null);
    try {
      const response = await updateExperience(saved.botId, patch);
      applyResponse(response);
      toast('Your changes were applied', 'success');
    } catch {
      setSaveError('Your changes could not be applied. Reload and try again.');
    } finally {
      setSaving(false);
    }
  }

  const tabs = useMemo(
    () => [
      {
        id: 'design',
        label: 'Design',
        content: (
          <ExperienceDesignTab
            draft={draft}
            errors={validation.errors}
            disabled={!canManage}
            botId={botId}
            botName={botName}
            avatar={avatar}
            fallbacks={fallbacks}
            onChange={update}
            onAvatarChanged={onAvatarChanged ?? (() => {})}
            onReset={resetToDefaults}
          />
        ),
      },
      {
        id: 'preview',
        label: 'Preview',
        content: (
          <ExperiencePreviewTab
            draft={draft}
            fallbacks={fallbacks}
            botId={botId}
            botName={botName}
            avatar={avatar}
            aiDraft={aiDraft}
            readOnly={!canManage}
          />
        ),
      },
      {
        id: 'publish',
        label: 'Publish',
        content: (
          <ExperiencePublishTab
            botId={botId}
            draft={draft}
            dirty={dirty}
            version={version}
            canManage={canManage}
            validationMessages={validation.messages}
            onPublished={applyResponse}
          />
        ),
      },
      {
        id: 'deploy',
        label: 'Deploy',
        content: (
          <ExperienceDeployTab
            botId={botId}
            deployments={deployments}
            onDeploymentsChange={setDeployments}
            canManage={canManage}
            version={version}
            iframeWidth={draft.iframeWidth}
            iframeHeight={draft.iframeHeight}
          />
        ),
      },
      {
        id: 'analytics',
        label: 'Analytics',
        content: (
          <ExperienceAnalyticsTab botId={botId} deployments={deployments} />
        ),
      },
    ],
    [
      aiDraft,
      applyResponse,
      avatar,
      botId,
      botName,
      canManage,
      deployments,
      dirty,
      draft,
      fallbacks,
      onAvatarChanged,
      resetToDefaults,
      update,
      validation,
      version,
    ],
  );

  return (
    <div className={dirty ? 'pb-20' : undefined}>
      {!canManage && (
        <div className="rounded-lg border border-border bg-muted px-4 py-3 text-xs text-muted-foreground">
          You have read-only access to this bot’s experience.
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">
          Editing the draft does not change the live experience until you publish.
        </p>
        {dirty && <Badge variant="warning">Unsaved changes</Badge>}
      </div>

      <div className="mt-4">
        <Tabs
          tabs={tabs}
          defaultTab="design"
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as ExperienceTabId)}
          ariaLabel="Experience studio sections"
        />
      </div>

      {canManage && (
        <UnsavedChangesBar
          dirty={dirty}
          saving={saving}
          error={saveError}
          onDiscard={discard}
          onSave={() => void save()}
        />
      )}

      <Dialog
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title="This experience was changed elsewhere"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Another tab or user saved changes to this experience. Reload to take
            their version, or keep yours by re-applying your changes on top of
            theirs.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConflict(null)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={resolveConflictReload}
            >
              Reload
            </Button>
            <Button size="sm" onClick={() => void resolveConflictKeepMine()}>
              Keep mine
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
