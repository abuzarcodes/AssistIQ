'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ApiError } from '@/lib/api-client';
import { updateBot, type Bot } from '@/lib/api/bots';
import type { AvatarState } from '@/lib/api/botConfig';
import { AvatarUploader } from './avatar-uploader';
import { LIMITS } from './config-options';
import type { TabProps } from './tab-props';

interface GeneralTabProps extends TabProps {
  bot: Bot;
  canManage: boolean;
  onBotChanged: (bot: Bot) => void;
  onAvatarChanged: (state: AvatarState | null) => void;
}

/**
 * General: identity and operational state.
 *
 * Name, description and the active/paused switch live on the `Bot` row, so they save
 * immediately through `PATCH /bots/:id` — the same batched form the page already had. The
 * display name is part of the configuration draft, because it is a presentation override
 * rather than the bot's identity.
 */
export function GeneralTab({
  bot,
  config,
  update,
  disabled,
  onBotChanged,
  onAvatarChanged,
}: GeneralTabProps) {
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identityDirty = name !== bot.name || description !== (bot.description ?? '');

  async function saveIdentity() {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateBot(bot.id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      onBotChanged(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save the bot.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(checked: boolean) {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateBot(bot.id, { isActive: checked });
      onBotChanged(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to change the bot state.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <Input
          id="bot-name"
          label="Name"
          value={name}
          disabled={disabled}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <Textarea
          id="bot-description"
          label="Description"
          value={description}
          disabled={disabled}
          maxLength={2000}
          placeholder="What does this bot do?"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            loading={saving}
            disabled={disabled || !identityDirty || !name.trim()}
            onClick={saveIdentity}
          >
            <Save className="h-3.5 w-3.5" />
            Save identity
          </Button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
          <div>
            <span className="text-sm font-medium text-foreground">Active</span>
            <p className="text-xs text-muted-foreground">
              A paused bot answers nothing and spends no provider credit.
            </p>
          </div>
          <Switch
            label="Bot active"
            checked={config.general.isActive}
            disabled={disabled || saving}
            onChange={toggleActive}
          />
        </div>
      </div>

      <div className="space-y-4">
        <AvatarUploader
          botId={bot.id}
          name={config.general.displayName ?? bot.name}
          hasAvatar={config.general.hasAvatar}
          avatarVersion={config.general.avatarVersion}
          disabled={disabled}
          onChanged={onAvatarChanged}
        />
        <Input
          id="bot-display-name"
          label="Display name"
          value={config.general.displayName ?? ''}
          disabled={disabled}
          maxLength={LIMITS.displayName}
          placeholder={bot.name}
          onChange={(e) => update('general', { displayName: e.target.value || null })}
        />
        <p className="text-xs text-muted-foreground">
          Shown in the chat surface. Leave blank to use the bot’s name.
        </p>
      </div>
    </div>
  );
}