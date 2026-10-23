'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Headphones, ChevronDown } from 'lucide-react';
import type { Message, MessageRole } from '@/lib/api/conversations';

interface ChatBubbleProps {
  message: Message;
  agentName?: string;
  isCurrentUser?: boolean;
}

export function ChatBubble({ message, agentName, isCurrentUser }: ChatBubbleProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const role: MessageRole = message.role;

  const formattedTime = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (role === 'SYSTEM') {
    return (
      <div className="my-2 flex justify-center">
        <span className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground/80">
          {message.content}
        </span>
      </div>
    );
  }

  const isAgent = role === 'AGENT';
  const isAssistant = role === 'ASSISTANT';
  const isUser = role === 'USER';

  return (
    <div className={`mb-4 flex flex-col ${isAgent ? 'items-end' : 'items-start'}`}>
      <div className="mb-1 flex items-center gap-1.5 px-1">
        {isAssistant && (
          <Bot aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
        )}
        {isUser && (
          <User aria-hidden="true" className="h-3 w-3 text-muted-foreground" />
        )}
        {isAgent && (
          <Headphones aria-hidden="true" className="h-3 w-3 text-accent-strong" />
        )}
        <span className="text-xs font-medium text-muted-foreground">
          {isAssistant && 'AI Assistant'}
          {isUser && 'Customer'}
          {isAgent && (agentName || (isCurrentUser ? 'You' : 'Agent'))}
        </span>
        <span className="text-xs text-muted-foreground">{formattedTime}</span>
      </div>

      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm sm:max-w-[75%] ${
          isAgent
            ? 'rounded-tr-sm bg-accent text-accent-foreground'
            : isAssistant
              ? 'rounded-tl-sm border border-border bg-card text-card-foreground'
              : 'rounded-tl-sm bg-muted text-foreground'
        }`}
      >
        <div
          className={`prose prose-sm max-w-none break-words ${
            isAgent ? '[&_*]:text-accent-foreground' : 'dark:prose-invert'
          } [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
      </div>

      {isAssistant && message.sources && message.sources.length > 0 && (
        <div className="mt-1 max-w-[85%] px-1 sm:max-w-[75%]">
          <button
            type="button"
            onClick={() => setSourcesOpen((prev) => !prev)}
            aria-expanded={sourcesOpen}
            className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              aria-hidden="true"
              className={`h-3 w-3 transition-transform ${sourcesOpen ? 'rotate-180' : ''}`}
            />
            Sources ({message.sources.length})
          </button>
          {sourcesOpen && (
            <ul className="mt-1 space-y-0.5 rounded-lg border border-border bg-muted/50 p-2">
              {message.sources.map((source) => (
                <li key={source.chunkId} className="text-xs text-muted-foreground">
                  {source.label ?? source.topic ?? 'Knowledge chunk'}
                  {source.pageNumber != null ? ` — page ${source.pageNumber}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
