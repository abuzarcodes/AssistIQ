'use client';

import { useState } from 'react';
import { GripVertical, Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LIMITS } from './config-options';

interface SuggestedQuestionsEditorProps {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/**
 * The clickable question chips shown before a conversation starts.
 *
 * Max 6, each ≤ 120 characters, no duplicates (case-insensitive) — the same bounds the
 * server enforces. Duplicates are rejected inline rather than silently dropped so the owner
 * sees why their second "Refunds?" did not appear.
 */
export function SuggestedQuestionsEditor({ value, onChange, disabled }: SuggestedQuestionsEditorProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    const text = draft.trim();
    if (!text) return;
    if (value.length >= LIMITS.suggestedQuestionsMax) {
      setError(`At most ${LIMITS.suggestedQuestionsMax} suggested questions`);
      return;
    }
    if (text.length > LIMITS.suggestedQuestionLength) {
      setError(`Each question must be ${LIMITS.suggestedQuestionLength} characters or fewer`);
      return;
    }
    if (value.some((q) => q.toLowerCase() === text.toLowerCase())) {
      setError('That question is already in the list');
      return;
    }
    onChange([...value, text]);
    setDraft('');
    setError(null);
  }

  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...value];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-foreground">Suggested questions</span>
      <ul className="flex flex-col gap-1.5">
        {value.map((question, index) => (
          <li
            key={`${question}-${index}`}
            className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5"
          >
            <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="flex-1 truncate text-sm text-foreground">{question}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={`Move ${question} up`}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
                className="rounded px-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${question} down`}
                disabled={disabled || index === value.length - 1}
                onClick={() => move(index, 1)}
                className="rounded px-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer"
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${question}`}
                disabled={disabled}
                onClick={() => remove(index)}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-30 cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            id="suggested-question-draft"
            aria-label="New suggested question"
            value={draft}
            disabled={disabled || value.length >= LIMITS.suggestedQuestionsMax}
            placeholder="e.g. What is your refund policy?"
            maxLength={LIMITS.suggestedQuestionLength}
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
          disabled={disabled || !draft.trim() || value.length >= LIMITS.suggestedQuestionsMax}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}