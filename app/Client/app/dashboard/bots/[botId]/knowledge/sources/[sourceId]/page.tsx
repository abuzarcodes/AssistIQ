'use client';

import { useParams } from 'next/navigation';
import { LegacyBotRedirect } from '@/components/legacy-bot-redirect';

/** A bookmarked source opens inside the workspace knowledge base. */
export default function LegacySourceDetailPage() {
  const params = useParams<{ sourceId: string }>();

  return (
    <LegacyBotRedirect
      suffix={`/knowledge/sources/${encodeURIComponent(params.sourceId)}`}
      label="Opening the document…"
    />
  );
}
