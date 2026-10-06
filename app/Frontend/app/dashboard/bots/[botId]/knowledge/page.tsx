'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, BookOpen, Plus, Upload } from 'lucide-react';
import { getBot, type Bot } from '@/lib/api/bots';
import { getWorkspace, type WorkspaceRole } from '@/lib/api/workspaces';
import { getChunkStats, type ChunkStats } from '@/lib/api/knowledgeChunks';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { WORKSPACE_PERMISSIONS, hasWorkspacePermission } from '@/lib/permissions';
import { StatsCards } from './_components/stats-cards';
import { SourcesTab } from './_components/sources-tab';
import { FaqTab } from './_components/faq-tab';
import { ChunksTab } from './_components/chunks-tab';
import { RetrievalTab } from './_components/retrieval-tab';

type TabId = 'sources' | 'faq' | 'chunks' | 'test';

/**
 * The knowledge overview (section 15.2).
 *
 * Four tabs over one bot's knowledge: the documents that were uploaded, the FAQ entries
 * written by hand, the chunks both of them are broken into, and a panel that runs the same
 * retrieval the bot runs.
 *
 * The page owns four things and delegates everything else: the bot, the stats, which tab
 * is showing, and which tab's create dialog is open. The tabs own their own data — each
 * refetches when it mounts, which is also what keeps the stats honest, since every
 * mutation reports back through `onChanged`.
 *
 * The tab *and* the dialog are controlled rather than internal because the header's quick
 * actions have to do both at once: "Add FAQ Entry" from the Documents tab should land on
 * the FAQ tab with the form already open, not tell the user to go and find it.
 */
export default function KnowledgePage() {
  const params = useParams<{ botId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [bot, setBot] = useState<Bot | null>(null);
  const [viewerRole, setViewerRole] = useState<WorkspaceRole | undefined>(undefined);
  const [stats, setStats] = useState<ChunkStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<TabId>('sources');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [faqCreateOpen, setFaqCreateOpen] = useState(false);

  const loadStats = useCallback(async () => {
    try {
      setStats(await getChunkStats(params.botId));
    } catch {
      // Left null, which the cards render as zeros. A failed count should not take the
      // page down — the tabs below still work, and the numbers are not what the user came
      // here to change.
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }, [params.botId]);

  useEffect(() => {
    async function load() {
      try {
        const botData = await getBot(params.botId);
        setBot(botData);
        loadStats();

        // The caller's role is a property of the membership, not of the bot, so it comes
        // from the workspace detail endpoint — the same way the bot detail page resolves it.
        try {
          const workspace = await getWorkspace(botData.workspaceId);
          setViewerRole(workspace.viewerRole);
        } catch {
          // Left undefined, which grants nothing. The tabs then render read-only rather
          // than offering actions the caller may not be allowed to take.
        }
      } catch {
        toast('Failed to load knowledge', 'error');
        router.push(`/dashboard/bots/${params.botId}`);
      } finally {
        setLoading(false);
      }
    }

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.botId]);

  const canManage = hasWorkspacePermission(viewerRole, WORKSPACE_PERMISSIONS.KNOWLEDGE_MANAGE);

  /**
   * Switch tabs, closing any open dialog on the way.
   *
   * The tab that owned the dialog is unmounted by the switch, so leaving the flag set would
   * make the dialog reappear when the user came back — a form they had already dismissed.
   */
  function changeTab(id: TabId) {
    setActiveTab(id);
    setUploadOpen(false);
    setFaqCreateOpen(false);
  }

  function startQuickAction(action: 'upload' | 'faq') {
    setActiveTab(action === 'upload' ? 'sources' : 'faq');
    if (action === 'upload') {
      setUploadOpen(true);
    } else {
      setFaqCreateOpen(true);
    }
  }

  if (loading || !bot) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => router.push(`/dashboard/bots/${bot.id}`)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 cursor-pointer"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Bot
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Knowledge Base</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Everything {bot.name} answers from: uploaded documents and hand-written FAQs.
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => startQuickAction('upload')}>
              <Upload className="h-3.5 w-3.5" />
              Upload Document
            </Button>
            <Button size="sm" onClick={() => startQuickAction('faq')}>
              <Plus className="h-3.5 w-3.5" />
              Add FAQ Entry
            </Button>
          </div>
        )}
      </div>

      <StatsCards stats={stats} loading={statsLoading} />

      <Tabs
        activeTab={activeTab}
        onTabChange={(id) => changeTab(id as TabId)}
        tabs={[
          {
            id: 'sources',
            label: 'Documents',
            content: (
              <SourcesTab
                botId={bot.id}
                canManage={canManage}
                uploadOpen={uploadOpen}
                onUploadOpenChange={setUploadOpen}
                onChanged={loadStats}
              />
            ),
          },
          {
            id: 'faq',
            label: 'FAQ Entries',
            content: (
              <FaqTab
                botId={bot.id}
                botName={bot.name}
                canManage={canManage}
                createOpen={faqCreateOpen}
                onCreateOpenChange={setFaqCreateOpen}
                onChanged={loadStats}
              />
            ),
          },
          {
            id: 'chunks',
            label: 'Chunks',
            content: <ChunksTab botId={bot.id} canManage={canManage} onChanged={loadStats} />,
          },
          {
            id: 'test',
            label: 'Test Retrieval',
            content: <RetrievalTab botId={bot.id} />,
          },
        ]}
      />

      {!canManage && (
        <p className="mt-6 text-xs text-muted-foreground flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5" />
          You have read-only access to this knowledge base.
        </p>
      )}
    </div>
  );
}
