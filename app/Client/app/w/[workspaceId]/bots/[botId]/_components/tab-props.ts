import type { ResolvedBotConfig } from '@/lib/api/botConfig';

/**
 * The props every configuration tab shares.
 *
 * `update` patches one section of the single draft object. Tabs never own state — the
 * orchestrator (`BotConfigTabs`) does, so dirty detection and the one save request are
 * possible (plan §16.2).
 */
export interface TabProps {
  config: ResolvedBotConfig;
  update: <K extends keyof ResolvedBotConfig>(
    section: K,
    patch: Partial<ResolvedBotConfig[K]>,
  ) => void;
  /** True when the caller lacks `bots:manage`: every control is disabled. */
  disabled: boolean;
}