'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { RadioGroup } from '@/components/ui/radio-group';
import { SuggestedQuestionsEditor } from './suggested-questions-editor';
import { ThinkingMessagesEditor } from './thinking-messages-editor';
import { LIMITS, RESPONSE_LENGTH_OPTIONS } from './config-options';
import type { TabProps } from './tab-props';

/**
 * Conversation experience (plan §16.1): what the customer sees before, during and after a
 * reply. Almost all of it is client rendering — the AI service never sees it.
 */
export function ConversationTab({ config, update, disabled }: TabProps) {
  const starter = config.conversation.conversationStarter;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-5">
        <Textarea
          id="welcome-message"
          label="Welcome message"
          value={config.conversation.welcomeMessage ?? ''}
          disabled={disabled}
          maxLength={LIMITS.welcomeMessage}
          placeholder="Hi! Ask me anything about your order."
          onChange={(e) => update('conversation', { welcomeMessage: e.target.value || null })}
        />

        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">Intro card</span>
            <Switch
              label="Show intro card"
              checked={starter !== null}
              disabled={disabled}
              onChange={(checked) =>
                update('conversation', {
                  conversationStarter: checked
                    ? { headline: 'Need a hand?', body: 'We usually reply instantly.', ctaLabel: null }
                    : null,
                })
              }
            />
          </div>
          {starter && (
            <>
              <Input
                id="starter-headline"
                label="Headline"
                value={starter.headline}
                disabled={disabled}
                maxLength={LIMITS.starterHeadline}
                onChange={(e) =>
                  update('conversation', {
                    conversationStarter: { ...starter, headline: e.target.value },
                  })
                }
              />
              <Textarea
                id="starter-body"
                label="Body"
                value={starter.body}
                disabled={disabled}
                maxLength={LIMITS.starterBody}
                onChange={(e) =>
                  update('conversation', {
                    conversationStarter: { ...starter, body: e.target.value },
                  })
                }
              />
            </>
          )}
        </div>

        <Input
          id="input-placeholder"
          label="Input placeholder"
          value={config.conversation.inputPlaceholder ?? ''}
          disabled={disabled}
          maxLength={LIMITS.inputPlaceholder}
          placeholder="Type a message…"
          onChange={(e) => update('conversation', { inputPlaceholder: e.target.value || null })}
        />

        <RadioGroup
          name="response-length"
          label="Response length"
          value={config.personality.responseLength}
          disabled={disabled}
          onChange={(responseLength) => update('personality', { responseLength })}
          options={RESPONSE_LENGTH_OPTIONS}
        />
      </div>

      <div className="space-y-5">
        <SuggestedQuestionsEditor
          value={config.conversation.suggestedQuestions}
          disabled={disabled}
          onChange={(suggestedQuestions) => update('conversation', { suggestedQuestions })}
        />

        <ThinkingMessagesEditor
          value={config.conversation.thinkingMessages}
          disabled={disabled}
          onChange={(thinkingMessages) => update('conversation', { thinkingMessages })}
        />

        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
          <div>
            <span className="text-sm font-medium text-foreground">Response feedback</span>
            <p className="text-xs text-muted-foreground">
              Let customers rate assistant answers with a thumbs up or down.
            </p>
          </div>
          <Switch
            label="Response feedback"
            checked={config.conversation.feedbackEnabled}
            disabled={disabled}
            onChange={(feedbackEnabled) => update('conversation', { feedbackEnabled })}
          />
        </div>

        {config.conversation.feedbackEnabled && (
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <div>
              <span className="text-sm font-medium text-foreground">Ask why</span>
              <p className="text-xs text-muted-foreground">
                Show a short reason list when a customer rates an answer down.
              </p>
            </div>
            <Switch
              label="Collect feedback reason"
              checked={config.conversation.feedbackCollectReason}
              disabled={disabled}
              onChange={(feedbackCollectReason) =>
                update('conversation', { feedbackCollectReason })
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}