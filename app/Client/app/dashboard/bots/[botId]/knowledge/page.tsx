'use client';

import { LegacyBotRedirect } from '@/components/legacy-bot-redirect';

/** The knowledge base lives with the bot in its workspace. */
export default function LegacyKnowledgePage() {
  return (
    <LegacyBotRedirect
      suffix="/knowledge"
      label="Opening the workspace knowledge base…"
    />
  );
}
