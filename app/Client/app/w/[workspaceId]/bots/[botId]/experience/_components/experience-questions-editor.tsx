'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { EXPERIENCE_LIMITS } from '@/lib/experience/config';

interface ExperienceQuestionsEditorProps {
  value: string[];
  /** The bot configuration's questions, shown when this draft has none. */
  fallback: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}

/**
 * The clickable question chips shown before a conversation starts.
 *
 * Bounds mirror the experience schema: at most 10, each 1-120 characters, no
 * case-insensitive duplicates. A duplicate is rejected inline rather than dropped
 * silently, so an owner sees why their second "Refunds?" did not appear.
 *
 * The experience form allows more questions than the bot configuration's six. When the
 * draft list is empty the customer still sees the configured questions, and they are
 * listed here as reference rather than copied into the draft — an empty list is a real
 * choice ("inherit"), not a missing one.
 */
export function ExperienceQuestionsEditor({
  value,
  fallback,
  onChange,
  disabled,
}: ExperienceQuestionsEditorProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add() {
    const text = draft.trim();
    if (!text) return;

    if (value.length >= EXPERIENCE_LIMITS.suggestedQuestionsMax) {
      setError(
        `At most ${EXPERIENCE_LIMITS.suggestedQuestionsMax} suggested questions`,
      );
      return;
    }
    if (text.length > EXPERIENCE_LIMITS.suggestedQuestionLength) {
      setError(
        `Each question must be ${EXPERIENCE_LIMITS.suggestedQuestionLength} characters or fewer`,
      );
      return;
    }
    if (value.some((question) => question.toLowerCase() === text.toLowerCase())) {
      setError('That question is already in the list');
      return;
    }

    onChange([...value, text]);
    setDraft('');
    setError(null);
  }

  function remove(index: number) {
    onChange(value.filter((_, current) => current !== index));
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...value];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  const atLimit = value.length >= EXPERIENCE_LIMITS.suggestedQuestionsMax;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-foreground">
          Suggested questions
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value.length} of {EXPERIENCE_LIMITS.suggestedQuestionsMax}
        </span>
      </div>

      {value.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-3">
          <p className="text-xs leading-5 text-muted-foreground">
            This experience has none of its own, so the chat shows the bot
            configuration’s questions.
          </p>
          {fallback.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {fallback.map((question) => (
                <li
                  key={question}
                  className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
                >
                  {question}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {value.map((question, index) => (
            <li
              key={`${question}-${index}`}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5"
            >
              <GripVertical
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-sm text-foreground">
                {question}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Move ${question} up`}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                  className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${question} down`}
                  disabled={disabled || index === value.length - 1}
                  onClick={() => move(index, 1)}
                  className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${question}`}
                  disabled={disabled}
                  onClick={() => remove(index)}
                  className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            id="experience-suggested-question"
            aria-label="New suggested question"
            value={draft}
            disabled={disabled || atLimit}
            placeholder="e.g. What is your refund policy?"
            maxLength={EXPERIENCE_LIMITS.suggestedQuestionLength}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
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
          disabled={disabled || !draft.trim() || atLimit}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
