import { apiPost, apiGet, apiPatch, apiDelete } from '@/lib/api-client';

/**
 * A bot's assigned model, as the read endpoints project it.
 *
 * `providerModelId` is deliberately absent from this type because the server never sends
 * it: the provider-native id is an implementation detail, and exposing it would invite a
 * client to try using it directly instead of going through the catalog.
 */
export interface BotModel {
  id: string;
  displayName: string;
  enabled: boolean;
  provider: { slug: string; name: string; enabled: boolean };
}

export interface Bot {
  id: string;
  name: string;
  description: string | null;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
  /**
   * `null` is a first-class state — "use the platform default" — not an absence. The two
   * `enabled` flags above let the UI warn about a model switched off *after* assignment
   * without a second request.
   */
  aiModelId?: string | null;
  aiModel?: BotModel | null;
  /** The failover model, resolved through the same catalog projection as the primary. */
  fallbackAiModelId?: string | null;
  fallbackAiModel?: BotModel | null;
  /** Operational state. A paused bot short-circuits before any AI call (Checkpoint 5). */
  isActive?: boolean;
}

export function listBots(workspaceId: string) {
  return apiGet<Bot[]>(`/workspaces/${workspaceId}/bots`);
}

export function getBot(botId: string) {
  return apiGet<Bot>(`/bots/${botId}`);
}

export function createBot(workspaceId: string, data: { name: string; description?: string }) {
  return apiPost<Bot>(`/workspaces/${workspaceId}/bots`, data);
}

export function updateBot(
  botId: string,
  data: { name?: string; description?: string | null; isActive?: boolean },
) {
  return apiPatch<Bot>(`/bots/${botId}`, data);
}

export function deleteBot(botId: string) {
  return apiDelete<null>(`/bots/${botId}`);
}

/**
 * Point a bot at a catalog model, or at the platform default.
 *
 * `null` is the platform-default assignment and is sent as such — the server treats it as
 * a supported state, not as "clear this field". Gated on `bots:manage` server-side, so an
 * AGENT calling this gets a 403 whatever the UI shows.
 */
export function assignBotModel(
  botId: string,
  data: { aiModelId?: string | null; fallbackAiModelId?: string | null },
) {
  return apiPatch<Bot>(`/bots/${botId}/model`, data);
}
