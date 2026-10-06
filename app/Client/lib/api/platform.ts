import { apiGet, apiPatch } from '@/lib/api-client';
import type { PlatformRole } from '@/lib/api/auth';

/**
 * Platform administration endpoints (`/platform/*`).
 *
 * Every one of these is behind `requirePlatformOwner()` on the server, so a workspace
 * role can never reach them no matter what the UI offers.
 */

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  platformRole: PlatformRole;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformWorkspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  owner: { id: string; name: string; email: string };
  _count: { bots: number; members: number };
}

export interface PlatformSystemStatus {
  service: string;
  database: { reachable: boolean };
  aiService: { reachable: boolean; detail?: unknown; error?: string };
  counts: { users: number; workspaces: number; bots: number; conversations: number };
}

export function listPlatformUsers() {
  return apiGet<PlatformUser[]>('/platform/users');
}

export function listPlatformWorkspaces() {
  return apiGet<PlatformWorkspace[]>('/platform/workspaces');
}

export function getPlatformSystemStatus() {
  return apiGet<PlatformSystemStatus>('/platform/system');
}

/**
 * The platform's runtime-tunable upload limits (section 12.11).
 *
 * Bytes, not megabytes, on the wire — the page converts for display and back on submit, so
 * there is exactly one unit in the API and one place that knows the UI shows MB.
 */
export interface PlatformSettings {
  id: string;
  maxUploadFileSizeBytes: number;
  maxUploadFilesPerRequest: number;
  maxUploadTotalBytes: number;
  maxChunksPerSource: number;
  maxChunksPerBot: number;
  aiServiceMaxFileSizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** A partial update: only the supplied fields change. */
export type PlatformSettingsPatch = Partial<
  Omit<PlatformSettings, 'id' | 'createdAt' | 'updatedAt'>
>;

export function getPlatformSettings() {
  return apiGet<PlatformSettings>('/platform/settings');
}

export function updatePlatformSettings(patch: PlatformSettingsPatch) {
  return apiPatch<PlatformSettings>('/platform/settings', patch);
}

/**
 * The bounds each setting accepts, mirroring the server's Zod schema (section 12.11).
 *
 * Duplicated deliberately, and only for feedback: the server rejects an out-of-range value
 * regardless, so this exists to tell the operator before they submit rather than to be the
 * check. If the two ever disagree the server is right, which is the failure mode we want.
 */
const MB = 1024 * 1024;

export const SETTINGS_LIMITS = {
  maxUploadFileSizeBytes: { min: 1 * MB, max: 100 * MB, unit: 'bytes' as const },
  maxUploadFilesPerRequest: { min: 1, max: 50, unit: 'count' as const },
  maxUploadTotalBytes: { min: 1 * MB, max: 500 * MB, unit: 'bytes' as const },
  maxChunksPerSource: { min: 1, max: 50_000, unit: 'count' as const },
  maxChunksPerBot: { min: 0, max: 1_000_000, unit: 'count' as const },
  aiServiceMaxFileSizeBytes: { min: 1 * MB, max: 500 * MB, unit: 'bytes' as const },
} as const;

export type SettingsField = keyof typeof SETTINGS_LIMITS;
