'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { Bot } from '@/lib/api/bots';
import type { SelectableModel } from '@/lib/api/models';
import {
  getBotConfig,
  updateBotConfig,
  type BotConfigPatch,
  type BotConfigResponse,
  type EffectiveInfo,
  type ResolvedBotConfig,
} from '@/lib/api/botConfig';
import { GeneralTab } from './general-tab';
import { PersonalityTab } from './personality-tab';
import { ConversationTab } from './conversation-tab';
import { KnowledgeTab } from './knowledge-tab';
import { HumanSupportTab } from './human-support-tab';
import { AiModelTab } from './ai-model-tab';
import { AppearanceTab } from './appearance-tab';
import { PreviewPanel } from './preview-panel';
import { UnsavedChangesBar } from './unsaved-changes-bar';

interface BotConfigTabsProps {
  bot: Bot;
  models: SelectableModel[];
  modelsLoading: boolean;
  modelsError: boolean;
  canManage: boolean;
  onBotChanged: (bot: Bot) => void;
  onConfigLoaded?: (response: BotConfigResponse) => void;
}

type TabId =
  | 'general'
  | 'personality'
  | 'conversation'
  | 'knowledge'
  | 'humanSupport'
  | 'model'
  | 'appearance';

/** The flat server-column names, per section field. */
const COLUMN_MAP: Record<string, string> = {
  'general.displayName': 'displayName',
  'personality.preset': 'personality',
  'personality.tone': 'tone',
  'personality.customPersonality': 'customPersonality',
  'personality.customInstructions': 'customInstructions',
  'personality.responseLanguage': 'responseLanguage',
  'personality.responseLength': 'responseLength',
  'conversation.welcomeMessage': 'welcomeMessage',
  'conversation.conversationStarter': 'conversationStarter',
  'conversation.suggestedQuestions': 'suggestedQuestions',
  'conversation.inputPlaceholder': 'inputPlaceholder',
  'conversation.thinkingMessages': 'thinkingMessages',
  'conversation.feedbackEnabled': 'feedbackEnabled',
  'conversation.feedbackCollectReason': 'feedbackCollectReason',
  'knowledge.enabled': 'knowledgeEnabled',
  'knowledge.strictness': 'knowledgeStrictness',
  'knowledge.showSources': 'showSources',
  'knowledge.topK': 'retrievalTopK',
  'generation.temperature': 'temperature',
  'generation.topP': 'topP',
  'generation.frequencyPenalty': 'frequencyPenalty',
  'generation.presencePenalty': 'presencePenalty',
  'generation.maxOutputTokens': 'maxOutputTokens',
  'humanSupport.fallbackEnabled': 'humanFallbackEnabled',
  'humanSupport.fallbackMessage': 'fallbackMessage',
  'humanSupport.humanRequestBehavior': 'humanRequestBehavior',
  'humanSupport.handoffMessage': 'handoffMessage',
  'humanSupport.businessHours': 'businessHours',
  'humanSupport.contactCollection': 'contactCollection',
};

/**
 * Build the PATCH body: only the fields that differ from the last server-confirmed config,
 * plus the required `expectedVersion`.
 *
 * Comparing the *stored shape* means a change to an array (a reordered suggested question)
 * is detected, which a shallow per-section comparison would miss.
 */
function buildPatch(saved: ResolvedBotConfig, draft: ResolvedBotConfig, version: number): BotConfigPatch {
  const patch: Record<string, unknown> = { expectedVersion: version };
  for (const [path, column] of Object.entries(COLUMN_MAP)) {
    const [section, field] = path.split('.') as [keyof ResolvedBotConfig, string];
    const before = (saved[section] as Record<string, unknown>)[field];
    const after = (draft[section] as Record<string, unknown>)[field];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      patch[column] = after;
    }
  }
  return patch as BotConfigPatch;
}

/**
 * The tabbed configuration center (plan §16).
 *
 * One draft object, one save request. `dirty` is a deep comparison against the last
 * server-confirmed value; the save bar, the per-tab dot and the `beforeunload` guard all
 * derive from it. A failed save preserves the draft — losing typed instructions is the worst
 * outcome this feature can produce — and a 409 opens a conflict dialog rather than
 * overwriting.
 */
export function BotConfigTabs({
  bot,
  models,
  modelsLoading,
  modelsError,
  canManage,
  onBotChanged,
  onConfigLoaded,
}: BotConfigTabsProps) {
  const { toast } = useToast();

  const [draft, setDraft] = useState<ResolvedBotConfig | null>(null);
  const [saved, setSaved] = useState<ResolvedBotConfig | null>(null);
  const [version, setVersion] = useState(0);
  const [effective, setEffective] = useState<EffectiveInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [conflict, setConflict] = useState<BotConfigResponse | null>(null);
  const [savingModel, setSavingModel] = useState(false);

  const applyResponse = useCallback(
    (response: BotConfigResponse) => {
      setDraft(response.config);
      setSaved(response.config);
      setVersion(response.version);
      setEffective(response.effective);
      onConfigLoaded?.(response);
    },
    [onConfigLoaded],
  );

  useEffect(() => {
    let cancelled = false;
    // `loading` is initialised to `true`; setting it again synchronously here would be a
    // set-state-in-effect, and the component remounts per bot so there is no stale value.
    getBotConfig(bot.id)
      .then((response) => {
        if (cancelled) return;
        applyResponse(response);
        setLoadError(false);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, applyResponse]);

  const dirty = useMemo(
    () => draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  // Which tabs have changed, for the dot on each label.
  const changedTabs = useMemo(() => {
    const set = new Set<TabId>();
    if (!draft || !saved) return set;
    const sectionTab: Record<keyof ResolvedBotConfig, TabId> = {
      general: 'general',
      personality: 'personality',
      conversation: 'conversation',
      knowledge: 'knowledge',
      generation: 'model',
      model: 'model',
      humanSupport: 'humanSupport',
    };
    for (const section of Object.keys(sectionTab) as Array<keyof ResolvedBotConfig>) {
      if (JSON.stringify(draft[section]) !== JSON.stringify(saved[section])) {
        set.add(sectionTab[section]);
      }
    }
    return set;
  }, [draft, saved]);

  // A browser-level guard against losing a dirty draft on navigation.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function update<K extends keyof ResolvedBotConfig>(
    section: K,
    patch: Partial<ResolvedBotConfig[K]>,
  ) {
    setDraft((prev) => (prev ? { ...prev, [section]: { ...prev[section], ...patch } } : prev));
    setSaveError(null);
  }

  function discard() {
    if (saved) setDraft(saved);
    setSaveError(null);
  }

  const save = useCallback(async () => {
    if (!draft || !saved) return;
    const patch = buildPatch(saved, draft, version);
    if (Object.keys(patch).length <= 1) {
      setDraft(saved);
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const response = await updateBotConfig(bot.id, patch);
      applyResponse(response);
      toast('Configuration saved', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.data as { data?: BotConfigResponse } | undefined)?.data;
        if (current) {
          setConflict(current);
        } else {
          setSaveError('This bot was changed elsewhere. Reload to see the latest configuration.');
        }
      } else {
        const message = err instanceof ApiError ? err.message : 'Failed to save the configuration.';
        setSaveError(message);
        toast(message, 'error');
      }
    } finally {
      setSaving(false);
    }
  }, [draft, saved, version, bot.id, applyResponse, toast]);

  /** Adopt the server's current version, discarding the local draft. */
  function resolveConflictReload() {
    if (!conflict) return;
    applyResponse(conflict);
    setConflict(null);
    toast('Reloaded the latest configuration', 'info');
  }

  /** Re-apply this draft's changed fields onto the fresh version and retry once. */
  async function resolveConflictKeepMine() {
    if (!conflict || !draft || !saved) return;
    const patch = buildPatch(saved, draft, conflict.version);
    setConflict(null);
    setSaving(true);
    setSaveError(null);
    try {
      const response = await updateBotConfig(bot.id, patch);
      applyResponse(response);
      toast('Your changes were applied', 'success');
    } catch {
      setSaveError('Your changes could not be applied. Reload and try again.');
    } finally {
      setSaving(false);
    }
  }

  async function assignModel(data: {
    aiModelId?: string | null;
    fallbackAiModelId?: string | null;
  }) {
    setSavingModel(true);
    try {
      const { assignBotModel } = await import('@/lib/api/bots');
      const updated = await assignBotModel(bot.id, data);
      onBotChanged(updated);
      // `effective` depends on the serving model, so refresh the config read.
      const response = await getBotConfig(bot.id);
      setEffective(response.effective);
      toast('Model updated', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to update the model', 'error');
    } finally {
      setSavingModel(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (loadError || !draft || !effective) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-card px-5 py-6">
        <p className="text-sm text-destructive">
          The configuration could not be loaded. Reload the page to try again.
        </p>
      </div>
    );
  }

  const disabled = !canManage;

  const tabs = [
    {
      id: 'general',
      label: `General${changedTabs.has('general') ? ' •' : ''}`,
      content: (
        <GeneralTab
          bot={bot}
          config={draft}
          update={update}
          disabled={disabled}
          canManage={canManage}
          onBotChanged={onBotChanged}
          onAvatarChanged={(state) =>
            update('general', {
              hasAvatar: state !== null,
              avatarVersion: state?.avatarVersion ?? draft.general.avatarVersion + 1,
            })
          }
        />
      ),
    },
    {
      id: 'personality',
      label: `Personality${changedTabs.has('personality') ? ' •' : ''}`,
      content: <PersonalityTab config={draft} update={update} disabled={disabled} />,
    },
    {
      id: 'conversation',
      label: `Conversation${changedTabs.has('conversation') ? ' •' : ''}`,
      content: <ConversationTab config={draft} update={update} disabled={disabled} />,
    },
    {
      id: 'knowledge',
      label: `Knowledge${changedTabs.has('knowledge') ? ' •' : ''}`,
      content: <KnowledgeTab config={draft} update={update} disabled={disabled} />,
    },
    {
      id: 'humanSupport',
      label: `Human Support${changedTabs.has('humanSupport') ? ' •' : ''}`,
      content: <HumanSupportTab config={draft} update={update} disabled={disabled} />,
    },
    {
      id: 'model',
      label: `AI Model${changedTabs.has('model') ? ' •' : ''}`,
      content: (
        <AiModelTab
          bot={bot}
          config={draft}
          update={update}
          disabled={disabled}
          models={models}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          effective={effective}
          savingModel={savingModel}
          onAssignModel={assignModel}
        />
      ),
    },
    {
      id: 'appearance',
      label: 'Appearance',
      content: (
        <AppearanceTab
          botId={bot.id}
          botName={bot.name}
          config={draft}
          update={update}
          disabled={disabled}
        />
      ),
    },
  ];

  return (
    <div className={dirty ? 'pb-24' : undefined}>
      {!canManage && (
        <div className="mb-4 rounded-lg border border-border bg-muted px-4 py-3 text-xs text-muted-foreground">
          You have read-only access to this bot’s configuration.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <div>
          <Tabs
            activeTab={activeTab}
            onTabChange={(id) => setActiveTab(id as TabId)}
            tabs={tabs}
          />
        </div>
        <div className="hidden lg:block">
          <div className="sticky top-4 h-[calc(100vh-8rem)]">
            <PreviewPanel botId={bot.id} botName={bot.name} draft={draft} />
          </div>
        </div>
      </div>

      {canManage && (
        <UnsavedChangesBar
          dirty={dirty}
          saving={saving}
          error={saveError}
          onDiscard={discard}
          onSave={save}
        />
      )}

      <Dialog
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title="This bot was changed elsewhere"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Another tab or user saved changes to this bot. Reload to take their version, or keep
            yours by re-applying your changes on top of theirs.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConflict(null)}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" onClick={resolveConflictReload}>
              Reload
            </Button>
            <Button size="sm" onClick={resolveConflictKeepMine}>
              Keep mine
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}