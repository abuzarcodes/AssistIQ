'use client';

import { useEffect, useState } from 'react';
import { Cpu, Plus, Pencil, Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import {
  createModel,
  deleteModel,
  listModels,
  listProviders,
  updateModel,
  updateProvider,
  type AIModel,
  type AIProvider,
} from '@/lib/api/models';

/**
 * Platform owner: the AI model catalog.
 *
 * Two things this page deliberately does **not** do:
 *
 * 1. **It makes no provider-bound request.** There is no "test connection" button, and
 *    nothing here causes Node to dial a model provider. The only outbound calls are to this
 *    platform's own API. Reachability is learned from real chat traffic and nowhere else —
 *    which is why no badge on this page is allowed to say "working", "online" or
 *    "reachable". "Ready" means *configured*, and that is the strongest true claim available
 *    without spending money to make a stronger one.
 * 2. **It renders no credential.** Readiness arrives as two nullable booleans. A `null` is
 *    "unknown", never "false" — the AI service failing to answer is not evidence that a key
 *    is missing.
 *
 * `PlatformGuard` in the layout keeps non-owners off this route, but that is **navigation**,
 * not enforcement: every endpoint behind it calls `requirePlatformOwner()` on the server.
 */

/** What the two readiness booleans mean, as one of four mutually exclusive states. */
type ReadinessState = 'unknown' | 'no-adapter' | 'no-credential' | 'ready';

const readinessOf = (provider: AIProvider): ReadinessState => {
  // Checked first and together: if the AI service could not be asked, *neither* question
  // has an answer, and reporting either as `false` would be an affirmative claim this
  // page cannot support.
  if (provider.adapterAvailable === null || provider.credentialConfigured === null) {
    return 'unknown';
  }
  if (!provider.adapterAvailable) return 'no-adapter';
  if (!provider.credentialConfigured) return 'no-credential';
  return 'ready';
};

const READINESS: Record<
  ReadinessState,
  { variant: 'default' | 'success' | 'warning' | 'danger'; label: string; detail: string }
> = {
  // Two distinct problems, two distinct remedies — which is the whole reason the readiness
  // axes are not merged into one boolean. "No adapter" is a code problem; "no credential"
  // is an environment problem. Telling an operator the wrong one sends them to the wrong
  // place.
  unknown: {
    variant: 'default',
    label: 'Status unknown',
    detail: 'AI service unreachable — status unknown.',
  },
  'no-adapter': {
    variant: 'danger',
    label: 'No adapter',
    detail: 'No adapter for this provider — a code change is required.',
  },
  'no-credential': {
    variant: 'warning',
    label: 'No credential',
    detail: 'Adapter present, credential missing.',
  },
  ready: {
    variant: 'success',
    label: 'Ready',
    // "Ready" is defined on the card, so it cannot be misread as "working".
    detail: 'Ready — the adapter is loaded and its credential is present.',
  },
};

export default function PlatformModelsPage() {
  const { toast } = useToast();

  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<AIModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);

  // Add model
  const [addOpen, setAddOpen] = useState(false);
  const [addProviderId, setAddProviderId] = useState('');
  const [addModelId, setAddModelId] = useState('');
  const [addDisplayName, setAddDisplayName] = useState('');
  const [adding, setAdding] = useState(false);

  // Edit model — `providerModelId` is intentionally absent: it is immutable.
  const [editing, setEditing] = useState<AIModel | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editEnabled, setEditEnabled] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  // Confirmations
  const [pendingDisable, setPendingDisable] = useState<AIModel | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AIModel | null>(null);
  const [confirming, setConfirming] = useState(false);

  /**
   * Re-read the catalog after a write.
   *
   * Refetched rather than patched in place because `botCount` is a *live* count on the
   * server: a local update would leave the table showing a number that was true when the
   * page loaded. Only ever called from an event handler — the initial read keeps the
   * fetch-inside-the-effect shape the rest of the platform pages use.
   *
   * **It never throws.** Every caller runs it *after* a write has already succeeded, so a
   * failure here means a stale table, not a failed write. Letting it propagate would make
   * the caller's `catch` report "Failed to add model" for a model the server had just
   * created — the toast would contradict the database, and the only clue would be that a
   * reload shows the change. The two failures get two messages, because only one of them is
   * about the write.
   */
  const refreshModels = async () => {
    try {
      setModels(await listModels());
    } catch {
      // The write landed; the re-read did not. 403s are surfaced by ApiErrorBridge already,
      // but a stale table is this page's own problem to disclose, so it says so itself.
      toast(
        'The change was saved, but the list could not be refreshed — reload to see the current state.',
        'error'
      );
    }
  };

  useEffect(() => {
    Promise.all([listProviders(), listModels()])
      .then(([providerList, modelList]) => {
        setProviders(providerList);
        setModels(modelList);
        setAddProviderId(providerList[0]?.id ?? '');
      })
      .catch(() => {
        // Already surfaced by ApiErrorBridge.
      })
      .finally(() => setLoading(false));
  }, []);

  const report = (err: unknown, fallback: string) =>
    toast(err instanceof ApiError ? err.message : fallback, 'error');

  async function toggleProvider(provider: AIProvider) {
    setBusyProviderId(provider.id);
    try {
      const updated = await updateProvider(provider.id, { enabled: !provider.enabled });
      setProviders((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      // Disabling a provider does not touch its models — it stops them resolving. The
      // list is refetched anyway so the page cannot show state the server has moved past.
      await refreshModels();
      toast(updated.enabled ? 'Provider enabled' : 'Provider disabled', 'success');
    } catch (err) {
      report(err, 'Failed to update provider');
    } finally {
      setBusyProviderId(null);
    }
  }

  /** Apply a model's enabled flag, refetching the list so bot counts stay live. */
  async function setModelEnabled(model: AIModel, enabled: boolean) {
    try {
      await updateModel(model.id, { enabled });
      await refreshModels();
      toast(enabled ? 'Model enabled' : 'Model disabled', 'success');
    } catch (err) {
      report(err, 'Failed to update model');
    }
  }

  function requestToggleModel(model: AIModel) {
    // Disabling a model that bots are using changes what their customers experience, so it
    // is confirmed first with the consequence stated. Enabling has no such consequence and
    // needs no interruption.
    if (model.enabled && model.botCount > 0) {
      setPendingDisable(model);
      return;
    }
    void setModelEnabled(model, !model.enabled);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await createModel({
        providerId: addProviderId,
        providerModelId: addModelId.trim(),
        displayName: addDisplayName.trim(),
      });
      await refreshModels();
      setAddOpen(false);
      setAddModelId('');
      setAddDisplayName('');
      // Created disabled, so this is genuinely "added, not yet available".
      toast('Model added — it is disabled until you enable it', 'success');
    } catch (err) {
      report(err, 'Failed to add model');
    } finally {
      setAdding(false);
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSavingEdit(true);
    try {
      await updateModel(editing.id, {
        displayName: editDisplayName.trim(),
        enabled: editEnabled,
      });
      await refreshModels();
      setEditing(null);
      toast('Model updated', 'success');
    } catch (err) {
      report(err, 'Failed to update model');
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setConfirming(true);
    try {
      await deleteModel(pendingDelete.id);
      await refreshModels();
      setPendingDelete(null);
      toast('Model deleted', 'success');
    } catch (err) {
      // The 409 for an in-use model is expected traffic, not a bug: the button is hidden
      // for those rows, but a reference can appear between the render and the click.
      report(err, 'Failed to delete model');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Models</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage which AI models are available to workspaces.
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)} disabled={providers.length === 0}>
          <Plus className="h-3.5 w-3.5" />
          Add model
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Providers</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              {providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No providers are configured.
                </p>
              ) : (
                providers.map((provider) => {
                  const state = readinessOf(provider);
                  const readiness = READINESS[state];
                  return (
                    <div
                      key={provider.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 justify-between border-b border-border last:border-0 pb-4 last:pb-0"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {provider.name}
                          </p>
                          <span className="text-xs text-muted-foreground font-mono">
                            {provider.slug}
                          </span>
                          <Badge variant={provider.enabled ? 'info' : 'default'}>
                            {provider.enabled ? 'Enabled' : 'Disabled'}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          {/* The credential remedy names the variable to set, derived from
                              the slug so it stays true for a provider added later. */}
                          {state === 'no-credential'
                            ? `Adapter present, credential missing — set ${provider.slug.toUpperCase()}_API_KEY on the AI service.`
                            : readiness.detail}
                          {' '}
                          <span className="text-muted-foreground/70">
                            (configured, not a live reachability check)
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant={readiness.variant} dot>
                          {readiness.label}
                        </Badge>
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={busyProviderId === provider.id}
                          onClick={() => toggleProvider(provider)}
                        >
                          {provider.enabled ? 'Disable' : 'Enable'}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All models</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              {models.length === 0 ? (
                <EmptyState
                  icon={Cpu}
                  title="No models yet"
                  description="Add a model to make it selectable by workspaces."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Model</th>
                        <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Provider</th>
                        <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Model ID</th>
                        <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Bots</th>
                        <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">State</th>
                        <th className="px-5 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {models.map((model) => (
                        <tr key={model.id} className="border-b border-border last:border-0">
                          <td className="px-5 py-3 text-foreground">{model.displayName}</td>
                          <td className="px-5 py-3 text-muted-foreground">
                            {model.provider.name}
                          </td>
                          <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                            {model.providerModelId}
                          </td>
                          <td className="px-5 py-3 text-muted-foreground">{model.botCount}</td>
                          <td className="px-5 py-3">
                            <Badge variant={model.enabled ? 'success' : 'default'} dot>
                              {model.enabled ? 'Enabled' : 'Disabled'}
                            </Badge>
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => requestToggleModel(model)}
                              >
                                {model.enabled ? 'Disable' : 'Enable'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditing(model);
                                  setEditDisplayName(model.displayName);
                                  setEditEnabled(model.enabled);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                                Edit
                              </Button>
                              {model.botCount === 0 ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setPendingDelete(model)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Delete
                                </Button>
                              ) : (
                                // Not rendered as a disabled button: a disabled control
                                // swallows the mouse events that would show its own tooltip,
                                // so the reason would be invisible. A plain span keeps the
                                // explanation reachable and still offers nothing clickable.
                                <span
                                  className="px-3 text-xs text-muted-foreground cursor-default"
                                  title="This model is in use by at least one bot. Reassign those bots before deleting it."
                                >
                                  In use
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {/* --- Add model --- */}
      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add model">
        <form onSubmit={handleAdd} className="space-y-4">
          <Select
            id="add-provider"
            label="Provider"
            value={addProviderId}
            onChange={(e) => setAddProviderId(e.target.value)}
            options={providers.map((provider) => ({
              value: provider.id,
              label: provider.name,
            }))}
          />
          <Input
            id="add-model-id"
            label="Model ID"
            value={addModelId}
            onChange={(e) => setAddModelId(e.target.value)}
            placeholder="openai/gpt-4o-mini"
            required
          />
          <p className="text-xs text-muted-foreground">
            The provider&apos;s own identifier, exactly as that provider writes it. It is not
            verified until a chat uses it, and it cannot be changed afterwards.
          </p>
          <Input
            id="add-display-name"
            label="Display name"
            value={addDisplayName}
            onChange={(e) => setAddDisplayName(e.target.value)}
            placeholder="GPT-4o mini"
            required
          />
          <p className="text-xs text-muted-foreground">
            Created disabled, so adding a model never changes what workspaces can select
            until you enable it.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={adding}>
              Add model
            </Button>
          </div>
        </form>
      </Dialog>

      {/* --- Edit model --- */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit model"
      >
        {editing && (
          <form onSubmit={handleEdit} className="space-y-4">
            <Input
              id="edit-display-name"
              label="Display name"
              value={editDisplayName}
              onChange={(e) => setEditDisplayName(e.target.value)}
              required
            />
            {/* Read-only text, never an input: the API rejects `providerModelId` on update
                with a 400, so a field here would look editable and fail confusingly. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Model ID</span>
              <p className="font-mono text-xs text-muted-foreground break-all rounded-lg border border-border bg-muted px-3 py-2">
                {editing.providerModelId}
              </p>
              <p className="text-xs text-muted-foreground">
                The model ID cannot be changed. To correct it, delete this model and add a
                new one.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={editEnabled}
                onChange={(e) => setEditEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-(--accent-600)"
              />
              Enabled — workspaces can select this model
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" loading={savingEdit}>
                Save changes
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      {/* --- Confirm disabling an in-use model --- */}
      <Dialog
        open={pendingDisable !== null}
        onClose={() => setPendingDisable(null)}
        title="Disable model"
      >
        {pendingDisable && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">{pendingDisable.botCount}</strong>{' '}
              {pendingDisable.botCount === 1 ? 'bot' : 'bots'} currently use this model. They
              will fall back to a human handoff until they are reassigned.
            </p>
            {/* Disabling withholds an answer; it destroys nothing. Saying so prevents an
                operator from expecting data loss and avoiding a reversible action. */}
            <p className="text-sm text-muted-foreground">
              No conversations or knowledge are affected, and re-enabling restores the model
              immediately. Those bots keep the assignment — they resume using it as soon as
              the model is enabled again.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingDisable(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  const model = pendingDisable;
                  setPendingDisable(null);
                  void setModelEnabled(model, false);
                }}
              >
                Disable model
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* --- Confirm delete --- */}
      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete model"
      >
        {pendingDelete && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Delete <strong className="text-foreground">{pendingDelete.displayName}</strong>{' '}
              from the catalog?
            </p>
            <p className="text-sm text-muted-foreground">
              No bot is using it, so nothing changes for any workspace. It can be added again
              with the same model ID.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={confirming}
                onClick={handleDelete}
              >
                Delete model
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
