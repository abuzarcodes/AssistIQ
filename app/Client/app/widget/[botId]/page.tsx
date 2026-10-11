'use client';

import { useParams } from 'next/navigation';
import { CustomerChatWidget } from '@/components/widget/CustomerChatWidget';

/**
 * Standalone public customer chat widget page (§17, CP6).
 * Renders the customer chat widget in full-page standalone mode for the given bot.
 */
export default function StandaloneWidgetPage() {
  const params = useParams<{ botId: string }>();
  const botId = Array.isArray(params?.botId) ? params.botId[0] : params?.botId;

  if (!botId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading widget...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background flex flex-col p-2 sm:p-6">
      <div className="flex-1 max-w-3xl w-full mx-auto flex flex-col">
        <CustomerChatWidget botId={botId} standalone={true} />
      </div>
    </main>
  );
}
