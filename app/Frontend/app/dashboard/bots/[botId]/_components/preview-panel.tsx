'use client';

import { useState } from 'react';
import { Send, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';
import { previewBotConfig, type ResolvedBotConfig, type PreviewResponse } from '@/lib/api/botConfig';
import { BotAvatar } from './bot-avatar';
import { ChatMessage } from './chat-message';

interface PreviewPanelProps {
  botId: string;
  botName: string;
  draft: ResolvedBotConfig;
}

interface PreviewTurn {
  role: 'USER' | 'ASSISTANT';
  content: string;
  sources?: PreviewResponse['sources'];
}

/**
 * The live preview (plan §17).
 *
 * Tests the **draft** against the bot's real knowledge base. Nothing is persisted — the
 * server's preview endpoint writes no conversation, message or feedback row. The panel
 * deliberately shows only the answer, optional sources and the fallback state; the pipeline
 * debug trace stays behind the platform-owner AI Lab where it already lives.
 *
 * The transcript is local component state, cleared by "Reset preview".
 */
export function PreviewPanel({ botId, botName, draft }: PreviewPanelProps) {
  const [turns, setTurns] = useState<PreviewTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const displayName = draft.general.displayName ?? botName;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || sending) return;

    setInput('');
    setError(null);
    setTurns((prev) => [...prev, { role: 'USER', content: message }]);
    setSending(true);

    try {
      const result = await previewBotConfig(botId, message, draft);
      setTurns((prev) => [
        ...prev,
        { role: 'ASSISTANT', content: result.response, sources: result.sources },
      ]);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The preview could not reach the assistant. Please try again.',
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">Preview</span>
          <Badge variant="info">Draft</Badge>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={turns.length === 0 || sending}
          onClick={() => {
            setTurns([]);
            setError(null);
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && !sending && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <BotAvatar
              botId={botId}
              hasAvatar={draft.general.hasAvatar}
              avatarVersion={draft.general.avatarVersion}
              name={displayName}
              size="lg"
            />
            <p className="text-sm font-medium text-foreground">{displayName}</p>
            <p className="text-xs text-muted-foreground">
              {draft.conversation.welcomeMessage ?? 'Send a message to test this draft.'}
            </p>
          </div>
        )}

        {turns.map((turn, index) => (
          <ChatMessage
            key={index}
            role={turn.role}
            content={turn.content}
            sources={turn.sources}
          />
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" />
            {draft.conversation.thinkingMessages[0] ?? 'AI is thinking…'}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {draft.conversation.suggestedQuestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-2">
          {draft.conversation.suggestedQuestions.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => setInput(question)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              {question}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
        <Input
          id="preview-input"
          aria-label="Preview message"
          value={input}
          disabled={sending}
          placeholder={draft.conversation.inputPlaceholder ?? 'Type a message…'}
          onChange={(e) => setInput(e.target.value)}
        />
        <Button type="submit" size="md" disabled={!input.trim() || sending}>
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}