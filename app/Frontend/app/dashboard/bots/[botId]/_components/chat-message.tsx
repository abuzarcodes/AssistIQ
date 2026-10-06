'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { MessageFeedback, SourceRef } from '@/lib/api/conversations';

interface ChatMessageProps {
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  /** Citations, present only when the bot shows sources and the turn produced an answer. */
  sources?: SourceRef[] | null;
  feedbackEnabled?: boolean;
  feedback?: MessageFeedback | null;
  /** Called when the user rates the message; omit to render read-only. */
  onFeedback?: (rating: 'UP' | 'DOWN') => void;
}

/**
 * A single chat bubble, extracted so the conversations panel and the preview share one
 * rendering (plan §16.5). The bubble markup is unchanged from the pre-feature page; the
 * additions are the optional sources disclosure and feedback controls, both off by default.
 *
 * **No scores and no match explanations** in the sources list — that is the deferred Tier 3
 * retrieval diagnostics, and the plan is explicit that this surface must not slide into it.
 */
export function ChatMessage({
  role,
  content,
  sources,
  feedbackEnabled = false,
  feedback,
  onFeedback,
}: ChatMessageProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const isUser = role === 'USER';

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-accent text-accent-foreground rounded-tr-sm'
            : 'bg-muted text-foreground rounded-tl-sm'
        }`}
      >
        <div
          className={`prose prose-sm max-w-none break-words ${
            isUser ? 'prose-invert' : 'dark:prose-invert'
          } [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>

      {!isUser && sources && sources.length > 0 && (
        <div className="mt-1 max-w-[80%]">
          <button
            type="button"
            onClick={() => setSourcesOpen((open) => !open)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            aria-expanded={sourcesOpen}
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${sourcesOpen ? 'rotate-180' : ''}`}
            />
            Sources ({sources.length})
          </button>
          {sourcesOpen && (
            <ul className="mt-1 space-y-0.5">
              {sources.map((source) => (
                <li key={source.chunkId} className="text-xs text-muted-foreground">
                  {source.label ?? source.topic ?? 'Knowledge chunk'}
                  {source.pageNumber != null ? ` — page ${source.pageNumber}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!isUser && feedbackEnabled && onFeedback && (
        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            aria-label="Helpful"
            aria-pressed={feedback?.rating === 'UP'}
            onClick={() => onFeedback('UP')}
            className={`rounded p-1 transition-colors cursor-pointer ${
              feedback?.rating === 'UP'
                ? 'text-success'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Not helpful"
            aria-pressed={feedback?.rating === 'DOWN'}
            onClick={() => onFeedback('DOWN')}
            className={`rounded p-1 transition-colors cursor-pointer ${
              feedback?.rating === 'DOWN'
                ? 'text-destructive'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}