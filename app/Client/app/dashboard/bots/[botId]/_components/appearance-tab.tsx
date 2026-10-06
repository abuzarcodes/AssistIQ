'use client';

import { Input } from '@/components/ui/input';
import { BotAvatar } from './bot-avatar';
import { LIMITS } from './config-options';
import type { TabProps } from './tab-props';

interface AppearanceTabProps extends TabProps {
  botId: string;
  botName: string;
}

/**
 * Appearance: the identity surface and a preview of the bubble.
 *
 * The avatar itself is uploaded on the General tab (one uploader, not two); this tab owns the
 * display name and shows how the customer-facing bubble will look with the current draft.
 * Per-bot accent colours are deliberately excluded (plan §18.4) — the avatar and display
 * name are the identity surface, and the palette stays the platform's.
 */
export function AppearanceTab({ botId, botName, config, update, disabled }: AppearanceTabProps) {
  const displayName = config.general.displayName ?? botName;
  const placeholder = config.conversation.inputPlaceholder ?? 'Type a message…';
  const thinking = config.conversation.thinkingMessages[0] ?? 'AI is thinking…';

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <Input
          id="appearance-display-name"
          label="Display name"
          value={config.general.displayName ?? ''}
          disabled={disabled}
          maxLength={LIMITS.displayName}
          placeholder={botName}
          onChange={(e) => update('general', { displayName: e.target.value || null })}
        />
        <p className="text-xs text-muted-foreground">
          The avatar is uploaded on the General tab. Colours follow the platform theme.
        </p>
      </div>

      <div className="space-y-3">
        <span className="text-sm font-medium text-foreground">Preview</span>
        <div className="rounded-xl border border-border bg-background p-4">
          <div className="mb-3 flex items-center gap-2">
            <BotAvatar
              botId={botId}
              hasAvatar={config.general.hasAvatar}
              avatarVersion={config.general.avatarVersion}
              name={displayName}
              size="sm"
            />
            <span className="text-sm font-medium text-foreground">{displayName}</span>
          </div>
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5 text-sm text-foreground">
              {config.conversation.welcomeMessage ?? 'Hi! How can I help you today?'}
            </div>
          </div>
          <div className="mt-2 flex justify-start">
            <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted px-4 py-2 text-xs text-muted-foreground">
              {thinking}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-full border border-border px-3 py-2">
            <span className="flex-1 truncate text-xs text-muted-foreground">{placeholder}</span>
            <span className="h-5 w-5 rounded-full bg-accent" aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}