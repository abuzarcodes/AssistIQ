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
      <div className="flex justify-center my-2 animate-fade-in">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs text-muted-foreground bg-muted border border-border">
          {message.content}
        </span>
      </div>
    );
  }

  const isAgent = role === 'AGENT';
  const isAssistant = role === 'ASSISTANT';
  const isUser = role === 'USER';

  return (
    <div
      className={`flex flex-col mb-4 animate-fade-in ${
        isAgent ? 'items-end' : 'items-start'
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1 px-1">
        {isAssistant && (
          <div className="h-4 w-4 rounded-full bg-accent/20 flex items-center justify-center">
            <Bot className="h-2.5 w-2.5 text-accent" />
          </div>
        )}
        {isUser && (
          <div className="h-4 w-4 rounded-full bg-muted flex items-center justify-center">
            <User className="h-2.5 w-2.5 text-muted-foreground" />
          </div>
        )}
        {isAgent && (
          <div className="h-4 w-4 rounded-full bg-accent flex items-center justify-center">
            <Headphones className="h-2.5 w-2.5 text-accent-foreground" />
          </div>
        )}
        <span className="text-xs font-medium text-muted-foreground">
          {isAssistant && 'AI Assistant'}
          {isUser && 'Customer'}
          {isAgent && (agentName || (isCurrentUser ? 'You' : 'Agent'))}
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          {formattedTime}
        </span>
      </div>

      <div
        className={`max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 text-sm transition-all ${
          isAgent
            ? 'bg-accent text-accent-foreground rounded-tr-xs shadow-sm'
            : isAssistant
            ? 'bg-card text-card-foreground border border-accent/30 rounded-tl-xs shadow-xs'
            : 'bg-muted text-foreground rounded-tl-xs'
        }`}
      >
        <div
          className={`prose prose-sm max-w-none break-words ${
            isAgent ? 'prose-invert' : 'dark:prose-invert'
          } [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
      </div>

      {isAssistant && message.sources && message.sources.length > 0 && (
        <div className="mt-1 max-w-[85%] sm:max-w-[75%] px-1">
          <button
            type="button"
            onClick={() => setSourcesOpen((prev) => !prev)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            aria-expanded={sourcesOpen}
          >
            <ChevronDown
              className={`h-3 w-3 transition-transform ${sourcesOpen ? 'rotate-180' : ''}`}
            />
            Sources ({message.sources.length})
          </button>
          {sourcesOpen && (
            <ul className="mt-1 space-y-0.5 p-2 rounded-lg bg-muted/50 border border-border">
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
