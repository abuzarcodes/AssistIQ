'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { FileInput } from '@/components/ui/file-input';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api-client';
import {
  uploadBotAvatar,
  deleteBotAvatar,
  type AvatarState,
} from '@/lib/api/botConfig';
import { BotAvatar } from './bot-avatar';

interface AvatarUploaderProps {
  botId: string;
  name: string;
  hasAvatar: boolean;
  avatarVersion: number;
  disabled?: boolean;
  /** Called with the new state after an upload or delete, so the parent can update its draft. */
  onChanged: (state: AvatarState | null) => void;
}

const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 512 * 1024;

/**
 * The bot avatar uploader.
 *
 * The avatar saves **immediately** on upload rather than through the draft save bar — a file
 * picker with a pending-upload state is worse UX than an immediate upload plus an undo via
 * Delete (plan §16.2). The parent is told the new version so the avatar refetches.
 */
export function AvatarUploader({
  botId,
  name,
  hasAvatar,
  avatarVersion,
  disabled,
  onChanged,
}: AvatarUploaderProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(file: File) {
    setError(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('Only PNG, JPEG and WebP images are allowed.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('The image must be 512 KB or smaller.');
      return;
    }

    setBusy(true);
    try {
      const state = await uploadBotAvatar(botId, file);
      onChanged(state);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to upload the image.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteBotAvatar(botId);
      onChanged(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to remove the image.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <BotAvatar botId={botId} hasAvatar={hasAvatar} avatarVersion={avatarVersion} name={name} size="lg" />
        {hasAvatar && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </Button>
        )}
      </div>
      <FileInput
        id="bot-avatar-file"
        label="Avatar"
        accept={ACCEPT}
        acceptLabel="PNG, JPEG or WebP, up to 512 KB"
        disabled={disabled || busy}
        error={error ?? undefined}
        onSelect={handleSelect}
      />
    </div>
  );
}