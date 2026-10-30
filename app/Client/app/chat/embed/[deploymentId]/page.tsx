'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { MessageCircle } from 'lucide-react';
import { CustomerChatWidget } from '@/components/widget/CustomerChatWidget';
import { readableInk } from '@/lib/experience/config';
import {
  getPublishedConfigByDeploymentId,
  PublicApiError,
  type PublishedDeploymentPayload,
} from '@/lib/api/publicChat';

interface WidgetMessage {
  source: 'assistiq-widget';
  deploymentId: string;
  type: 'ready' | 'position' | 'resize' | 'state';
  position?: string;
  width?: number;
  height?: number;
  open?: boolean;
}

/**
 * The iframe embed page (CP-11.7).
 *
 * Served at `/chat/embed/:deploymentId` — the URL the iframe snippet hands out.
 * Two presentations, chosen by query:
 *
 * - Full chat (default): the merchant sized the iframe, so it fills it with the
 *   whole conversation. Used by the iframe snippet.
 * - `?mode=widget`: the loader script owns a tiny iframe and grows it on demand.
 *   Closed, the iframe holds only the launcher; open, it holds the panel. Every
 *   size and corner change is posted to the parent, which owns the actual frame —
 *   the contract `public/widget/loader.js` implements.
 */
export default function EmbedChatPage() {
  const params = useParams<{ deploymentId: string }>();
  const searchParams = useSearchParams();
  const deploymentId = Array.isArray(params?.deploymentId)
    ? params.deploymentId[0]
    : params?.deploymentId;
  const widgetMode = searchParams?.get('mode') === 'widget';

  const [payload, setPayload] = useState<PublishedDeploymentPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!deploymentId) return;
    let active = true;

    getPublishedConfigByDeploymentId(deploymentId)
      .then((result) => {
        if (active) setPayload(result);
      })
      .catch((caught) => {
        if (active && caught instanceof PublicApiError) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [deploymentId]);

  if (!deploymentId || failed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <p role="alert" className="text-xs text-muted-foreground">
          This chat is unavailable. It may have been unpublished or disabled.
        </p>
      </main>
    );
  }

  if (!payload) {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-background"
        role="status"
        aria-label="Loading chat"
      >
        <span
          aria-hidden="true"
          className="block h-8 w-8 animate-pulse rounded-full bg-muted"
        />
      </main>
    );
  }

  if (widgetMode) {
    return <WidgetEmbed payload={payload} />;
  }

  const name = payload.config.displayName || payload.bot.name;
  return (
    <main className="h-screen">
      <CustomerChatWidget
        botId={payload.bot.id}
        botName={name}
        standalone
        experienceConfig={payload.config}
        deploymentId={payload.deployment.id}
      />
    </main>
  );
}

/** The launcher-and-panel presentation the loader script frames. */
function WidgetEmbed({ payload }: { payload: PublishedDeploymentPayload }) {
  const { config } = payload;
  const [open, setOpen] = useState(config.autoOpen);
  const launcherRef = useRef<HTMLButtonElement>(null);

  const post = useCallback(
    (message: Omit<WidgetMessage, 'source' | 'deploymentId'>) => {
      window.parent.postMessage(
        {
          source: 'assistiq-widget',
          deploymentId: payload.deployment.id,
          ...message,
        } satisfies WidgetMessage,
        '*',
      );
    },
    [payload.deployment.id],
  );

  // The parent positions the frame, so it needs the corner as soon as we know it.
  useEffect(() => {
    post({ type: 'ready' });
    post({ type: 'position', position: config.widgetPosition });
  }, [config.widgetPosition, post]);

  // Size the frame to its content: the measured launcher when closed, the draft's
  // panel dimensions (clamped to the viewport) when open.
  useEffect(() => {
    function notifySize() {
      if (!open) {
        const launcher = launcherRef.current;
        post({
          type: 'resize',
          width: launcher ? Math.ceil(launcher.offsetWidth) + 8 : 230,
          height: launcher ? Math.ceil(launcher.offsetHeight) + 8 : 64,
        });
        return;
      }

      post({
        type: 'resize',
        width: Math.min(
          config.widgetPanelWidth,
          window.innerWidth - 16,
          480,
        ),
        height: Math.min(
          config.widgetPanelHeight,
          window.innerHeight - 16,
          800,
        ),
      });
    }

    notifySize();
    window.addEventListener('resize', notifySize);
    return () => window.removeEventListener('resize', notifySize);
  }, [config.widgetPanelHeight, config.widgetPanelWidth, open, post]);

  function setOpenState(next: boolean) {
    setOpen(next);
    post({ type: 'state', open: next });
  }

  const accent = config.accentColor;
  const label = config.widgetLauncherLabel || 'Chat with us';
  const name = config.displayName || payload.bot.name;

  if (!open) {
    return (
      <main className="flex h-screen items-center justify-center bg-transparent">
        <button
          ref={launcherRef}
          type="button"
          onClick={() => setOpenState(true)}
          aria-label="Open chat support"
          style={{ backgroundColor: accent, color: readableInk(accent) }}
          className="flex cursor-pointer items-center gap-2 rounded-full py-3 pl-4 pr-5 text-sm font-medium shadow-lg transition-opacity hover:opacity-90"
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
          {label}
        </button>
      </main>
    );
  }

  return (
    <main className="h-screen">
      <CustomerChatWidget
        botId={payload.bot.id}
        botName={name}
        standalone
        experienceConfig={config}
        deploymentId={payload.deployment.id}
        onCollapse={() => setOpenState(false)}
      />
    </main>
  );
}
