import type {
  AfterHoursBehavior,
  BotPersonality,
  BotTone,
  ContactField,
  HumanRequestBehavior,
  KnowledgeStrictness,
  ResponseLength,
} from '@/lib/api/botConfig';
import type { RadioOption } from '@/components/ui/radio-group';

/**
 * Selectable values for the configuration center.
 *
 * Presentation only. The server validates every one of these against the same vocabulary;
 * nothing here is a security boundary. The lists exist so the options are declared once and
 * the tabs stay readable.
 */

export const PERSONALITY_OPTIONS: RadioOption<BotPersonality>[] = [
  { value: 'PROFESSIONAL', label: 'Professional' },
  { value: 'FRIENDLY', label: 'Friendly' },
  { value: 'CONCISE', label: 'Concise' },
  { value: 'WARM', label: 'Warm' },
  { value: 'TECHNICAL', label: 'Technical' },
  { value: 'CASUAL', label: 'Casual' },
  { value: 'CUSTOM', label: 'Custom' },
];

export const TONE_OPTIONS: RadioOption<BotTone>[] = [
  { value: 'NEUTRAL', label: 'Neutral' },
  { value: 'FORMAL', label: 'Formal' },
  { value: 'FRIENDLY', label: 'Friendly' },
  { value: 'EMPATHETIC', label: 'Empathetic' },
  { value: 'DIRECT', label: 'Direct' },
];

export const RESPONSE_LENGTH_OPTIONS: RadioOption<ResponseLength>[] = [
  { value: 'SHORT', label: 'Short' },
  { value: 'BALANCED', label: 'Balanced' },
  { value: 'LONG', label: 'Long' },
];

export const STRICTNESS_OPTIONS: RadioOption<KnowledgeStrictness>[] = [
  { value: 'STRICT', label: 'Strict', hint: 'Answer only from your knowledge base' },
  { value: 'BALANCED', label: 'Balanced', hint: 'Answer from knowledge, fall back when unsure' },
  { value: 'FLEXIBLE', label: 'Flexible', hint: 'Prefer knowledge, allow general answers' },
];

export const HUMAN_REQUEST_OPTIONS: RadioOption<HumanRequestBehavior>[] = [
  { value: 'TRANSFER_AUTOMATICALLY', label: 'Transfer automatically' },
  { value: 'UNAVAILABLE_MESSAGE', label: 'Say support is unavailable' },
  { value: 'CONTINUE_WITH_AI', label: 'Keep answering with AI' },
];

export const AFTER_HOURS_OPTIONS: RadioOption<AfterHoursBehavior>[] = [
  { value: 'MESSAGE_AND_ESCALATE', label: 'Message and escalate' },
  { value: 'MESSAGE_ONLY', label: 'Message only' },
  { value: 'ESCALATE', label: 'Escalate only' },
];

/**
 * The response-language allow-list, mirrored from the server's `RESPONSE_LANGUAGES`.
 *
 * Kept in sync by hand because there is no shared constants package across TS/TSX. The
 * server is the authority: an unknown code is a 400 whatever this list says.
 */
export const LANGUAGE_OPTIONS = [
  { value: 'AUTO', label: 'Match the customer’s language' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
].map((l) => ({ value: l.value, label: l.label }));

export const CONTACT_FIELD_OPTIONS: { value: ContactField; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'orderId', label: 'Order ID' },
];

export const FEEDBACK_REASON_OPTIONS = [
  { value: 'INACCURATE', label: 'Inaccurate' },
  { value: 'NOT_HELPFUL', label: 'Not helpful' },
  { value: 'WRONG_SOURCE', label: 'Wrong source' },
  { value: 'INCOMPLETE', label: 'Incomplete' },
  { value: 'OTHER', label: 'Other' },
];

export const DAY_OPTIONS = [
  { value: 'MON', label: 'Monday' },
  { value: 'TUE', label: 'Tuesday' },
  { value: 'WED', label: 'Wednesday' },
  { value: 'THU', label: 'Thursday' },
  { value: 'FRI', label: 'Friday' },
  { value: 'SAT', label: 'Saturday' },
  { value: 'SUN', label: 'Sunday' },
] as const;

/** Every IANA timezone the runtime knows, for the business-hours picker. */
export function listTimezones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    if (supported) return supported('timeZone');
  } catch {
    // Fall through to the short list below.
  }
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles'];
}

/** Bounds mirrored from the server's `BOT_CONFIG_LIMITS`, for counters and clamping. */
export const LIMITS = {
  displayName: 60,
  customPersonality: 500,
  customInstructions: 4000,
  welcomeMessage: 500,
  inputPlaceholder: 120,
  fallbackMessage: 500,
  handoffMessage: 500,
  afterHoursMessage: 500,
  suggestedQuestionsMax: 6,
  suggestedQuestionLength: 120,
  thinkingMessagesMax: 5,
  thinkingMessageLength: 60,
  topKMin: 1,
  topKMax: 20,
  maxOutputTokensMin: 1,
  maxOutputTokensMax: 8192,
  starterHeadline: 80,
  starterBody: 300,
  starterCtaLabel: 30,
} as const;