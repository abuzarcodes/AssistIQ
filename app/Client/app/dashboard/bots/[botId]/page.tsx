'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Trash2, BookOpen, MessageSquare } from 'lucide-react';
import { getBot, deleteBot, type Bot } from '@/lib/api/bots';
import { getWorkspace, type WorkspaceRole } from '@/lib/api/workspaces';
import { listAvailableModels, type SelectableModel } from '@/lib/api/models';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { WORKSPACE_PERMISSIONS, hasWorkspacePermission } from '@/lib/permissions';
import { BotConfigTabs } from './_components/bot-config-tabs';

/**
 * The bot detail page, now the Bot Configuration Center (plan §16).
 *
 * It keeps its identity — header, back link, navigation cards and Danger Zone — and replaces
 * the old "Bot Settings" and "AI Model" cards with the tabbed configuration surface. The
 * page owns the bot and the model catalog; `BotConfigTabs` owns the configuration draft.
 */
export default function BotDetailPage() {
  const params = useParams<{ botId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<WorkspaceRole | undefined>(undefined);

  const [models, setModels] = useState<SelectableModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadBot();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.botId]);

  async function loadBot() {
    try {
      const data = await getBot(params.botId);
      setBot(data);
      loadWorkspaceRole(data.workspaceId);
      loadModels();
    } catch {
      toast('Failed to load bot', 'error');
      router.push('/dashboard/workspaces');
    } finally {
      setLoading(false);
    }
  }

  async function loadWorkspaceRole(workspaceId: string) {
    try {
      const workspace = await getWorkspace(workspaceId);
      setViewerRole(workspace.viewerRole);
    } catch {
      // Left undefined, which grants nothing: the configuration surface stays read-only.
    }
  }

  async function loadModels() {
    try {
      setModels(await listAvailableModels());
    } catch {
      // Surfaced inline: an empty selector would read as "no models exist".
      setModelsError(true);
    } finally {
      setModelsLoading(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteBot(params.botId);
      toast('Bot deleted', 'success');
      router.push(`/dashboard/workspaces/${bot?.workspaceId}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to delete bot', 'error');
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!bot) return null;

  const canManage = hasWorkspacePermission(viewerRole, WORKSPACE_PERMISSIONS.BOTS_MANAGE);

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => router.push(`/dashboard/workspaces/${bot.workspaceId}`)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 cursor-pointer"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Workspace
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground">{bot.name}</h1>
            <Badge variant="info">Bot</Badge>
            {bot.isActive === false && <Badge variant="warning">Paused</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {bot.description || 'No description'}
          </p>
        </div>
      </div>

      {/* Navigation Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <Link href={`/dashboard/bots/${bot.id}/knowledge`}>
          <Card className="hover:border-accent/50 transition-colors cursor-pointer group">
            <CardBody>
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-muted p-2 group-hover:bg-[var(--accent-50)] dark:group-hover:bg-[color-mix(in_srgb,var(--accent-600)_15%,transparent)] transition-colors">
                  <BookOpen className="h-4 w-4 text-muted-foreground group-hover:text-accent transition-colors" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Knowledge Base</p>
                  <p className="text-xs text-muted-foreground">Manage FAQ entries and RAG data</p>
                </div>
              </div>
            </CardBody>
          </Card>
        </Link>

        <Link href={`/dashboard/bots/${bot.id}/conversations`}>
          <Card className="hover:border-accent/50 transition-colors cursor-pointer group">
            <CardBody>
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-muted p-2 group-hover:bg-[var(--accent-50)] dark:group-hover:bg-[color-mix(in_srgb,var(--accent-600)_15%,transparent)] transition-colors">
                  <MessageSquare className="h-4 w-4 text-muted-foreground group-hover:text-accent transition-colors" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">Conversations</p>
                  <p className="text-xs text-muted-foreground">Chat with this bot and view history</p>
                </div>
              </div>
            </CardBody>
          </Card>
        </Link>
      </div>

      <BotConfigTabs
        bot={bot}
        models={models}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        canManage={canManage}
        onBotChanged={setBot}
      />

      {/* Danger Zone */}
      <Card className="mt-8 border-destructive/30">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardBody>
          <p className="text-sm text-muted-foreground mb-3">
            Deleting this bot will permanently remove all its conversations, knowledge entries,
            and vector embeddings.
          </p>
          <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" />
            Delete Bot
          </Button>
        </CardBody>
      </Card>

      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Bot">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{bot.name}</strong>? This will permanently
            delete:
          </p>
          <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
            <li>All conversations and messages</li>
            <li>All knowledge entries</li>
            <li>All vector embeddings</li>
          </ul>
          <p className="text-sm font-medium text-destructive">This action cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" loading={deleting} onClick={handleDelete}>
              Delete Bot
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}