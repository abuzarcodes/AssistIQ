'use client';

import { LegacyBotRedirect } from '@/components/legacy-bot-redirect';

/** Conversations live with the bot in its workspace. */
export default function LegacyConversationsPage() {
  return (
    <LegacyBotRedirect
      suffix="/conversations"
      label="Opening the workspace conversations…"
    />
  );
}
