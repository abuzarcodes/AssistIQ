'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plus, Bot as BotIcon, ArrowRight } from 'lucide-react';
import { getWorkspace, type Workspace } from '@/lib/api/workspaces';
import { listBots, createBot, type Bot } from '@/lib/api/bots';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';

export default function WorkspaceDetailPage() {
  const params = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [botName, setBotName] = useState('');
  const [botDesc, setBotDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.workspaceId]);

  async function loadData() {
    try {
      const [ws, botList] = await Promise.all([
        getWorkspace(params.workspaceId),
        listBots(params.workspaceId),
      ]);
      setWorkspace(ws);
      setBots(botList);
    } catch {
      toast('Failed to load workspace', 'error');
      router.push('/dashboard/workspaces');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateBot(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setCreating(true);

    try {
      await createBot(params.workspaceId, {
        name: botName,
        description: botDesc || undefined,
      });
      toast('Bot created', 'success');
      setDialogOpen(false);
      setBotName('');
      setBotDesc('');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create bot');
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => router.push('/dashboard/workspaces')}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 cursor-pointer"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Workspaces
      </button>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">
            {workspace?.name}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage bots in this workspace.
          </p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New Bot
        </Button>
      </div>

      {bots.length === 0 ? (
        <EmptyState
          icon={BotIcon}
          title="No bots yet"
          description="Create a bot to start handling customer conversations with AI."
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Create Bot
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {bots.map((bot) => (
            <Link key={bot.id} href={`/dashboard/bots/${bot.id}`}>
              <Card className="hover:border-accent/50 transition-colors cursor-pointer group">
                <CardBody>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-muted p-2 group-hover:bg-[var(--accent-50)] dark:group-hover:bg-[color-mix(in_srgb,var(--accent-600)_15%,transparent)] transition-colors">
                        <BotIcon className="h-4 w-4 text-muted-foreground group-hover:text-accent transition-colors" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          {bot.name}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[180px]">
                          {bot.description || 'No description'}
                        </p>
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setError('');
          setBotName('');
          setBotDesc('');
        }}
        title="Create Bot"
      >
        <form onSubmit={handleCreateBot} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
              {error}
            </div>
          )}
          <Input
            id="bot-name"
            label="Bot name"
            placeholder="e.g. Support Bot"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            required
            autoFocus
          />
          <Textarea
            id="bot-desc"
            label="Description (optional)"
            placeholder="What does this bot do?"
            value={botDesc}
            onChange={(e) => setBotDesc(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={creating}>
              Create Bot
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
