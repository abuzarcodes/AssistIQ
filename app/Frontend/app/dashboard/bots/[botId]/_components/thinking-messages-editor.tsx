'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LIMITS } from './config-options';

interface ThinkingMessagesEditorProps {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/**
 * The status lines rotated while the bot is generating a reply.
 *
 * Max 5, each ≤ 60 characters, no duplicates — the server's bounds. Empty means the client's
 * default ("AI is thinking…") is used, which is presentation rather than configuration.
 */
export function ThinkingMessagesEditor({ value, onChange, disabled }: ThinkingMessagesEditorProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    const text = draft.trim();
    if (!text) return;
    if (value.length >= LIMITS.thinkingMessagesMax) {
      setError(`At most ${LIMITS.thinkingMessagesMax} thinking messages`);
      return;
    }
    if (text.length > LIMITS.thinkingMessageLength) {
      setError(`Each message must be ${LIMITS.thinkingMessageLength} characters or fewer`);
      return;
    }
    if (value.some((m) => m.toLowerCase() === text.toLowerCase())) {
      setError('That message is already in the list');
      return;
    }
    onChange([...value, text]);
    setDraft('');
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">Thinking messages</span>
      <ul className="flex flex-wrap gap-1.5">
        {value.map((message, index) => (
          <li
            key={`${message}-${index}`}
            className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-foreground"
          >
            <span className="truncate">{message}</span>
            <button
              type="button"
              aria-label={`Remove ${message}`}
              disabled={disabled}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              className="text-muted-foreground hover:text-destructive disabled:opacity-30 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            id="thinking-message-draft"
            aria-label="New thinking message"
            value={draft}
            disabled={disabled || value.length >= LIMITS.thinkingMessagesMax}
            placeholder="e.g. Checking that for you…"
            maxLength={LIMITS.thinkingMessageLength}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={add}
          disabled={disabled || !draft.trim() || value.length >= LIMITS.thinkingMessagesMax}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}