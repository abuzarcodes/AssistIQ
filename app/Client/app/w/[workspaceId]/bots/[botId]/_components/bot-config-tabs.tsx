'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Cpu,
  Headphones,
  MessageSquare,
  Palette,
  RotateCcw,
  Settings2,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { Bot } from '@/lib/api/bots';
import type { SelectableModel } from '@/lib/api/models';
import {
  getBotConfig,
  resetBotConfig,
  updateBotConfig,
  type BotConfigPatch,
  type AvatarState,
  type BotConfigResponse,
  type ConfigSection,
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
  onAvatarChanged?: (state: AvatarState | null) => void;
}

type TabId =
  | 'general'
  | 'personality'
  | 'conversation'
  | 'knowledge'
  | 'humanSupport'
  | 'model'
  | 'appearance';

interface SectionMeta {
  id: TabId;
  label: string;
  description: string;
  icon: LucideIcon;
  /** The reset endpoint's section, when this view has defaults worth restoring. */
  resetSection?: Exclude<ConfigSection, 'all' | 'appearance'>;
}

/**
 * The seven configuration areas, in the order an owner sets a bot up.
 *
 * One item opens one view (plan §16.1); nothing is stacked into a single long
 * page. The rail is navigation, not a second form of the save state.
 */
const SECTIONS: SectionMeta[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Bot name, avatar, display name and whether it is answering.',
    icon: Settings2,
    resetSection: 'general',
  },
  {
    id: 'personality',
    label: 'Personality',
    description: 'How the assistant sounds and what it should always keep in mind.',
    icon: Sparkles,
    resetSection: 'personality',
  },
  {
    id: 'conversation',
    label: 'Conversation',
    description: 'The opening, prompts and feedback customers see in chat.',
    icon: MessageSquare,
    resetSection: 'conversation',
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    description: 'How answers use the sources and FAQ entries you have uploaded.',
    icon: BookOpen,
    resetSection: 'knowledge',
  },
  {
    id: 'humanSupport',
    label: 'Human support',
    description: 'When and how a conversation reaches a person.',
    icon: Headphones,
    resetSection: 'humanSupport',
  },
  {
    id: 'model',
    label: 'AI model',
    description: 'The model that serves this bot and the parameters it uses.',
    icon: Cpu,
    resetSection: 'generation',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    description: 'What the assistant’s identity looks like in the chat surface.',
    icon: Palette,
  },
];

const SAVED_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

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

function formatSaved(iso: string | null) {
  if (!iso) return 'Using defaults';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Using defaults' : SAVED_FORMATTER.format(date);
}

/**
 * The configuration center's working surface (plan §16).
 *
 * One draft object, one save request. `dirty` is a deep comparison against the last
 * server-confirmed value; the save bar, the rail dots and the `beforeunload` guard all
 * derive from it. A failed save preserves the draft — losing typed instructions is the
 * worst outcome this feature can produce — and a 409 opens a conflict dialog rather
 * than overwriting.
 *
 * CP6 presents this as a white sheet: section rail on the left, the active area in the
 * middle, and the live draft preview on the right. The rail and the preview stay in
 * view while the form scrolls.
 */
export function BotConfigTabs({
  bot,
  models,
  modelsLoading,
  modelsError,
  canManage,
  onBotChanged,
  onConfigLoaded,
  onAvatarChanged,
}: BotConfigTabsProps) {
  const { toast } = useToast();

  const [draft, setDraft] = useState<ResolvedBotConfig | null>(null);
  const [saved, setSaved] = useState<ResolvedBotConfig | null>(null);
  const [version, setVersion] = useState(0);
  const [effective, setEffective] = useState<EffectiveInfo | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [conflict, setConflict] = useState<BotConfigResponse | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [resetTarget, setResetTarget] = useState<SectionMeta | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const applyResponse = useCallback(
    (response: BotConfigResponse) => {
      setDraft(response.config);
      setSaved(response.config);
      setVersion(response.version);
      setEffective(response.effective);
      setUpdatedAt(response.updatedAt);
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

  // Which views have changed, for the dot on each rail item. Most map one-to-one
  // to a config section; response length lives in Personality but is edited on
  // Conversation, and identity is visible on both General and Appearance.
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
    if (
      JSON.stringify(draft.personality.responseLength) !==
      JSON.stringify(saved.personality.responseLength)
    ) {
      set.add('conversation');
    }
    if (
      JSON.stringify(draft.general) !== JSON.stringify(saved.general)
    ) {
      set.add('appearance');
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

  /**
   * The avatar saves through its own endpoint, so its new version belongs to
   * both the draft and the saved baseline. Moving only the draft would light the
   * save bar for a change the config PATCH cannot carry.
   */
  function handleAvatarChanged(state: AvatarState | null) {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            general: {
              ...prev.general,
              hasAvatar: state !== null,
              avatarVersion: state?.avatarVersion ?? prev.general.avatarVersion + 1,
            },
          }
        : prev,
    );
    setSaved((prev) =>
      prev
        ? {
            ...prev,
            general: {
              ...prev.general,
              hasAvatar: state !== null,
              avatarVersion: state?.avatarVersion ?? prev.general.avatarVersion + 1,
            },
          }
        : prev,
    );
    setSaveError(null);
    onAvatarChanged?.(state);
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

  function requestReset(section: SectionMeta) {
    setResetError(null);
    setResetTarget(section);
  }

  /**
   * Restore one area's server defaults without throwing away draft edits in the
   * other areas. The response updates the version and the saved baseline; only the
   * reset section is replaced in the current draft.
   */
  async function confirmReset() {
    const section = resetTarget?.resetSection;
    if (!resetTarget || !section || !saved) return;

    setResetting(true);
    setResetError(null);
    try {
      const response = await resetBotConfig(bot.id, {
        section,
        expectedVersion: version,
      });

      setSaved(response.config);
      setVersion(response.version);
      setEffective(response.effective);
      setUpdatedAt(response.updatedAt);
      setDraft((prev) => {
        if (!prev) return response.config;
        switch (section) {
          case 'general':
            return { ...prev, general: response.config.general };
          case 'personality':
            return { ...prev, personality: response.config.personality };
          case 'conversation':
            return { ...prev, conversation: response.config.conversation };
          case 'knowledge':
            return { ...prev, knowledge: response.config.knowledge };
          case 'humanSupport':
            return { ...prev, humanSupport: response.config.humanSupport };
          case 'generation':
            return { ...prev, generation: response.config.generation };
          default:
            return prev;
        }
      });
      onConfigLoaded?.(response);
      toast(`${resetTarget.label} reset to defaults`, 'success');
      setResetTarget(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.data as { data?: BotConfigResponse } | undefined)?.data;
        if (current) {
          setResetTarget(null);
          setConflict(current);
          return;
        }
      }

      setResetError(
        err instanceof ApiError
          ? err.message
          : 'The section could not be reset. Please try again.',
      );
    } finally {
      setResetting(false);
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
      <div className="flex items-center justify-center py-20">
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
  const activeSection = SECTIONS.find((section) => section.id === activeTab) ?? SECTIONS[0];
  const activeChanged = changedTabs.has(activeTab);
  const resetSection = activeSection.resetSection;

  const tabContent: Record<TabId, ReactNode> = {
    general: (
      <GeneralTab
        bot={bot}
        config={draft}
        update={update}
        disabled={disabled}
        canManage={canManage}
        onBotChanged={onBotChanged}
        onAvatarChanged={handleAvatarChanged}
      />
    ),
    personality: <PersonalityTab config={draft} update={update} disabled={disabled} />,
    conversation: <ConversationTab config={draft} update={update} disabled={disabled} />,
    knowledge: <KnowledgeTab config={draft} update={update} disabled={disabled} />,
    humanSupport: <HumanSupportTab config={draft} update={update} disabled={disabled} />,
    model: (
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
    appearance: (
      <AppearanceTab
        botId={bot.id}
        botName={bot.name}
        config={draft}
        update={update}
        disabled={disabled}
      />
    ),
  };

  return (
    <div className={dirty ? 'pb-20' : undefined}>
      {!canManage && (
        <div className="border-b border-border bg-muted px-4 py-3 text-xs text-muted-foreground sm:px-6">
          You have read-only access to this bot’s configuration.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[148px_minmax(0,1fr)_300px]">
        <nav
          aria-label="Configuration sections"
          className="flex gap-1 overflow-x-auto border-b border-border p-2 xl:sticky xl:top-6 xl:flex-col xl:gap-0.5 xl:self-start xl:overflow-visible xl:border-b-0 xl:border-r xl:p-3"
        >
          <span className="hidden px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground xl:block">
            Sections
          </span>
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const active = activeTab === section.id;
            const changed = changedTabs.has(section.id);

            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveTab(section.id)}
                aria-current={active ? 'true' : undefined}
                aria-label={`${section.label}${changed ? ', unsaved changes' : ''}`}
                className={`flex h-11 shrink-0 items-center gap-2 rounded-md border-b-2 px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 xl:h-10 xl:w-full xl:border-b-0 xl:border-l-2 ${
                  active
                    ? 'border-accent bg-muted/60 font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                }`}
              >
                <Icon
                  aria-hidden="true"
                  className={`h-4 w-4 shrink-0 ${
                    active ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                />
                <span className="whitespace-nowrap">{section.label}</span>
                {changed && (
                  <span
                    aria-hidden="true"
                    title="Unsaved changes"
                    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong"
                  />
                )}
              </button>
            );
          })}

          <div className="mt-auto hidden border-t border-border px-2 pt-3 xl:block">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Last saved
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
              {formatSaved(updatedAt)}
            </p>
          </div>
        </nav>

        <section
          aria-labelledby="config-section-title"
          className="min-w-0 scroll-mt-20"
        >
          <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
            <div className="min-w-0">
              <h2
                id="config-section-title"
                className="text-lg font-semibold tracking-tight text-foreground"
              >
                {activeSection.label}
              </h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                {activeSection.description}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {activeChanged && (
                <span className="text-[11px] font-medium text-foreground">
                  Unsaved
                </span>
              )}
              {canManage && resetSection && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving || resetting}
                  onClick={() => requestReset(activeSection)}
                  className="h-9"
                >
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                  Reset section
                </Button>
              )}
            </div>
          </div>

          <div className="@container px-4 py-5 sm:px-6">
            {tabContent[activeTab]}
          </div>
        </section>

        <aside
          aria-label="Draft preview"
          className="hidden border-l border-border p-3 xl:sticky xl:top-6 xl:block xl:h-[calc(100vh-10rem)] xl:min-h-[480px] xl:self-start"
        >
          <PreviewPanel
            botId={bot.id}
            botName={bot.name}
            draft={draft}
            readOnly={!canManage}
          />
        </aside>
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
        open={resetTarget !== null}
        onClose={() => {
          if (!resetting) setResetTarget(null);
        }}
        title={`Reset ${resetTarget?.label ?? 'section'}?`}
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This restores the saved defaults for{' '}
            <strong className="text-foreground">{resetTarget?.label}</strong>.
            Unsaved edits in this section will be discarded; other sections keep
            their edits.
          </p>
          {resetError && <p className="text-sm text-destructive">{resetError}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={resetting}
              onClick={() => setResetTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={resetting}
              onClick={() => void confirmReset()}
            >
              <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
              Reset {resetTarget?.label ?? 'section'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={conflict !== null}
        onClose={() => setConflict(null)}
        title="This bot was changed elsewhere"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Another tab or user saved changes to this bot. Reload to take their
            version, or keep yours by re-applying your changes on top of theirs.
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
