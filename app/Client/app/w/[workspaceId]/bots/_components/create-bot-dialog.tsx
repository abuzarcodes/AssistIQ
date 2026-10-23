'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { createBot, type Bot } from '@/lib/api/bots';

interface CreateBotDialogProps {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (bot: Bot) => void;
}

/**
 * Creates a bot in the workspace currently open in the shell. The dialog is
 * only mounted by a caller that has already checked `bots:manage`; the server
 * still rejects the request for a caller without it.
 */
export function CreateBotDialog({
  workspaceId,
  open,
  onClose,
  onCreated,
}: CreateBotDialogProps) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  function reset() {
    setName('');
    setDescription('');
    setError('');
  }

  function close() {
    if (creating) return;
    reset();
    onClose();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setCreating(true);

    try {
      const bot = await createBot(workspaceId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      reset();
      toast('Bot created', 'success');
      onCreated(bot);
      onClose();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message || 'We could not create this bot.'
          : 'We could not create this bot. Check your connection and try again.',
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title="Create bot">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          The bot starts with platform defaults. You can change its knowledge,
          model and behavior after it is created.
        </p>

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/20 bg-error-bg px-3 py-2 text-sm text-error-bg-foreground"
          >
            {error}
          </div>
        )}

        <Input
          id="bot-name"
          label="Name"
          placeholder="e.g. Billing assistant"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
          autoFocus
          className="h-11 sm:h-9"
        />

        <Textarea
          id="bot-description"
          label="Description (optional)"
          placeholder="What does this bot help customers with?"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={2000}
        />

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={close}
            disabled={creating}
            className="h-11 sm:h-8"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={creating}
            disabled={!name.trim()}
            className="h-11 sm:h-8"
          >
            Create bot
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
