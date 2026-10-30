import type { ExperienceConfigSnapshot } from '@/lib/api/experience';
import {
  EXPERIENCE_LIMITS,
  isCssLength,
  isHexColor,
  isHttpUrl,
} from '@/lib/experience/config';

/**
 * Client-side validation mirroring `experience.schema.ts`.
 *
 * It exists so a save is blocked with the field marked, instead of a 400 arriving after
 * the request. The server remains the authority: anything this misses, or any rule that
 * drifts, still fails there and the message is shown in the save bar.
 *
 * Messages are ordered by the Design tab's sections, so the first one in the bar names
 * the field nearest the top of the screen.
 */

export type ExperienceErrors = Partial<
  Record<keyof ExperienceConfigSnapshot, string>
>;

export interface ExperienceValidationResult {
  errors: ExperienceErrors;
  messages: string[];
}

function tooLong(value: string | null | undefined, max: number): boolean {
  return (value ?? '').trim().length > max;
}

export function validateExperience(
  draft: ExperienceConfigSnapshot,
): ExperienceValidationResult {
  const errors: ExperienceErrors = {};
  const messages: string[] = [];

  function fail(field: keyof ExperienceConfigSnapshot, message: string) {
    if (errors[field]) return;
    errors[field] = message;
    messages.push(message);
  }

  // Branding
  if (tooLong(draft.displayName, EXPERIENCE_LIMITS.displayName)) {
    fail(
      'displayName',
      `The display name must be ${EXPERIENCE_LIMITS.displayName} characters or fewer.`,
    );
  }
  if (!isHexColor(draft.accentColor)) {
    fail('accentColor', 'The accent colour must be a hex value such as #rrggbb.');
  }
  if (draft.userBubbleColor && !isHexColor(draft.userBubbleColor)) {
    fail(
      'userBubbleColor',
      'The customer bubble colour must be a hex value, or left to inherit.',
    );
  }
  if (draft.botBubbleColor && !isHexColor(draft.botBubbleColor)) {
    fail(
      'botBubbleColor',
      'The bot bubble colour must be a hex value, or left to inherit.',
    );
  }
  if (draft.businessLogoUrl && !isHttpUrl(draft.businessLogoUrl)) {
    fail('businessLogoUrl', 'The logo must be an http or https image URL.');
  }
  if (tooLong(draft.businessLogoUrl, EXPERIENCE_LIMITS.url)) {
    fail(
      'businessLogoUrl',
      `The logo URL must be ${EXPERIENCE_LIMITS.url} characters or fewer.`,
    );
  }

  // Layout
  if (tooLong(draft.hostedPageTitle, EXPERIENCE_LIMITS.hostedPageTitle)) {
    fail(
      'hostedPageTitle',
      `The page title must be ${EXPERIENCE_LIMITS.hostedPageTitle} characters or fewer.`,
    );
  }
  if (tooLong(draft.hostedPageDescription, EXPERIENCE_LIMITS.hostedPageDescription)) {
    fail(
      'hostedPageDescription',
      `The page description must be ${EXPERIENCE_LIMITS.hostedPageDescription} characters or fewer.`,
    );
  }
  if (tooLong(draft.widgetLauncherLabel, EXPERIENCE_LIMITS.widgetLauncherLabel)) {
    fail(
      'widgetLauncherLabel',
      `The launcher label must be ${EXPERIENCE_LIMITS.widgetLauncherLabel} characters or fewer.`,
    );
  }

  const width = EXPERIENCE_LIMITS.widgetPanelWidth;
  if (
    !Number.isInteger(draft.widgetPanelWidth) ||
    draft.widgetPanelWidth < width.min ||
    draft.widgetPanelWidth > width.max
  ) {
    fail(
      'widgetPanelWidth',
      `The widget width must be between ${width.min} and ${width.max} pixels.`,
    );
  }

  const height = EXPERIENCE_LIMITS.widgetPanelHeight;
  if (
    !Number.isInteger(draft.widgetPanelHeight) ||
    draft.widgetPanelHeight < height.min ||
    draft.widgetPanelHeight > height.max
  ) {
    fail(
      'widgetPanelHeight',
      `The widget height must be between ${height.min} and ${height.max} pixels.`,
    );
  }

  if (!isCssLength(draft.iframeWidth)) {
    fail('iframeWidth', 'The iframe width must be a CSS length such as 100% or 600px.');
  }
  if (!isCssLength(draft.iframeHeight)) {
    fail('iframeHeight', 'The iframe height must be a CSS length such as 600px or 90vh.');
  }

  // Welcome
  if (tooLong(draft.welcomeMessage, EXPERIENCE_LIMITS.welcomeMessage)) {
    fail(
      'welcomeMessage',
      `The welcome message must be ${EXPERIENCE_LIMITS.welcomeMessage} characters or fewer.`,
    );
  }
  if (tooLong(draft.welcomeSubtitle, EXPERIENCE_LIMITS.welcomeSubtitle)) {
    fail(
      'welcomeSubtitle',
      `The welcome subtitle must be ${EXPERIENCE_LIMITS.welcomeSubtitle} characters or fewer.`,
    );
  }
  if (tooLong(draft.inputPlaceholder, EXPERIENCE_LIMITS.inputPlaceholder)) {
    fail(
      'inputPlaceholder',
      `The input placeholder must be ${EXPERIENCE_LIMITS.inputPlaceholder} characters or fewer.`,
    );
  }

  if (draft.suggestedQuestions.length > EXPERIENCE_LIMITS.suggestedQuestionsMax) {
    fail(
      'suggestedQuestions',
      `Use at most ${EXPERIENCE_LIMITS.suggestedQuestionsMax} suggested questions.`,
    );
  } else if (
    draft.suggestedQuestions.some(
      (question) =>
        question.trim().length === 0 ||
        question.trim().length > EXPERIENCE_LIMITS.suggestedQuestionLength,
    )
  ) {
    fail(
      'suggestedQuestions',
      `Each suggested question must be 1 to ${EXPERIENCE_LIMITS.suggestedQuestionLength} characters.`,
    );
  } else {
    const seen = new Set(
      draft.suggestedQuestions.map((question) => question.trim().toLowerCase()),
    );
    if (seen.size !== draft.suggestedQuestions.length) {
      fail('suggestedQuestions', 'Suggested questions must be unique.');
    }
  }

  // Chat behavior
  if (draft.privacyPolicyUrl && !isHttpUrl(draft.privacyPolicyUrl)) {
    fail('privacyPolicyUrl', 'The privacy policy link must be an http or https URL.');
  }
  if (tooLong(draft.privacyPolicyUrl, EXPERIENCE_LIMITS.url)) {
    fail(
      'privacyPolicyUrl',
      `The privacy policy link must be ${EXPERIENCE_LIMITS.url} characters or fewer.`,
    );
  }
  if (draft.termsUrl && !isHttpUrl(draft.termsUrl)) {
    fail('termsUrl', 'The terms link must be an http or https URL.');
  }
  if (tooLong(draft.termsUrl, EXPERIENCE_LIMITS.url)) {
    fail(
      'termsUrl',
      `The terms link must be ${EXPERIENCE_LIMITS.url} characters or fewer.`,
    );
  }

  return { errors, messages };
}
