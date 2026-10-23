'use client';

import { useEffect, useState } from 'react';
import { getBotAvatarBlob } from '@/lib/api/botConfig';

interface BotAvatarProps {
  botId: string;
  hasAvatar: boolean;
  /** Bumped by the server on every avatar write; part of the cache key. */
  avatarVersion: number;
  /** Fallback initial when there is no avatar. */
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-lg',
} as const;

/**
 * The bot avatar, fetched as an authenticated blob.
 *
 * An `<img src="/bots/:id/avatar">` cannot attach the bearer token, and the endpoint is
 * deliberately not public (the dashboard is its only consumer). So the bytes are fetched
 * through the API client and rendered from an object URL, which is revoked on unmount and
 * whenever the version changes — an object URL is a leak if it is not released.
 */
export function BotAvatar({ botId, hasAvatar, avatarVersion, name, size = 'md' }: BotAvatarProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasAvatar) return;

    let objectUrl: string | null = null;
    let cancelled = false;

    getBotAvatarBlob(botId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // A missing or failed avatar falls back to the initial rather than breaking the page.
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [botId, hasAvatar, avatarVersion]);

  const initial = name.trim().charAt(0).toUpperCase() || '?';

  // Gated on `hasAvatar` as well as `url`: when the avatar is removed, the stale object URL
  // must not keep rendering. The effect no longer resets state synchronously, which is what
  // the React Compiler's set-state-in-effect rule forbids.
  if (hasAvatar && url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- an object URL cannot use next/image.
      <img
        src={url}
        alt={`${name} avatar`}
        className={`${SIZE_CLASSES[size]} shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`${SIZE_CLASSES[size]} flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground`}
    >
      {initial}
    </span>
  );
}