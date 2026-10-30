import type { AvatarState } from '@/lib/api/botConfig';
import type { ExperienceConfigSnapshot } from '@/lib/api/experience';

/** A generic field writer owned by the studio; each tab receives it unchanged. */
export type ExperienceChange = <K extends keyof ExperienceConfigSnapshot>(
  field: K,
  value: ExperienceConfigSnapshot[K],
) => void;

/** Values the bot configuration supplies when the experience has no override. */
export interface ExperienceFallbacks {
  displayName: string;
  welcomeMessage: string | null;
  inputPlaceholder: string | null;
  suggestedQuestions: string[];
}

/** The avatar the studio renders and refreshes after an upload. */
export interface ExperienceAvatar {
  hasAvatar: boolean;
  avatarVersion: number;
}

/**
 * What the page hands the studio when `POST /bots/:botId/avatar` succeeds. `null`
 * means the avatar was removed.
 */
export type ExperienceAvatarChanged = (state: AvatarState | null) => void;
