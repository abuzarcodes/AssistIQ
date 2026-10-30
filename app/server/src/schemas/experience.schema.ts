import { z } from 'zod';
import {
  EXPERIENCE_LIMITS as L,
  THEME_MODES,
  THEME_PRESETS,
  WIDGET_POSITIONS,
  WIDGET_MOBILE_BEHAVIORS,
  FIRST_OPEN_BEHAVIORS,
} from '../constants/experienceDefaults.js';

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const isHexColor = (val: string) => HEX_COLOR.test(val);

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .url('Must be a valid URL')
  .nullable();

const uniqueStrings = (values: string[]): boolean =>
  new Set(values.map((v) => v.trim().toLowerCase())).size === values.length;

export const experienceFields = {
  // --- Branding ---
  displayName: z.string().trim().max(L.displayName).nullable(),
  botAvatarUrl: optionalUrl,
  businessLogoUrl: optionalUrl,
  accentColor: z
    .string()
    .trim()
    .max(L.accentColor)
    .refine(isHexColor, { message: 'Accent color must be a valid hex color code (e.g. #ff6b35)' }),
  userBubbleColor: z
    .string()
    .trim()
    .max(9)
    .refine((val) => !val || isHexColor(val), { message: 'User bubble color must be a valid hex color' })
    .nullable(),
  botBubbleColor: z
    .string()
    .trim()
    .max(9)
    .refine((val) => !val || isHexColor(val), { message: 'Bot bubble color must be a valid hex color' })
    .nullable(),
  themeMode: z.enum(THEME_MODES),
  themePreset: z.enum(THEME_PRESETS).nullable(),

  // --- Layout ---
  hostedPageTitle: z.string().trim().max(L.hostedPageTitle).nullable(),
  hostedPageDescription: z.string().trim().max(L.hostedPageDescription).nullable(),
  widgetPosition: z.enum(WIDGET_POSITIONS),
  widgetLauncherLabel: z.string().trim().max(L.widgetLauncherLabel).nullable(),
  widgetPanelWidth: z
    .number()
    .int()
    .min(L.widgetPanelWidth.min, `Panel width must be at least ${L.widgetPanelWidth.min}px`)
    .max(L.widgetPanelWidth.max, `Panel width cannot exceed ${L.widgetPanelWidth.max}px`),
  widgetPanelHeight: z
    .number()
    .int()
    .min(L.widgetPanelHeight.min, `Panel height must be at least ${L.widgetPanelHeight.min}px`)
    .max(L.widgetPanelHeight.max, `Panel height cannot exceed ${L.widgetPanelHeight.max}px`),
  widgetMobileBehavior: z.enum(WIDGET_MOBILE_BEHAVIORS),
  iframeWidth: z.string().trim().max(L.iframeWidth),
  iframeHeight: z.string().trim().max(L.iframeHeight),

  // --- Welcome ---
  welcomeMessage: z.string().trim().max(L.welcomeMessage).nullable(),
  welcomeSubtitle: z.string().trim().max(L.welcomeSubtitle).nullable(),
  inputPlaceholder: z.string().trim().max(L.inputPlaceholder).nullable(),
  suggestedQuestions: z
    .array(z.string().trim().min(1).max(L.suggestedQuestions.item))
    .max(L.suggestedQuestions.max, `At most ${L.suggestedQuestions.max} suggested questions`)
    .refine(uniqueStrings, { message: 'Suggested questions must be unique' }),
  firstOpenBehavior: z.enum(FIRST_OPEN_BEHAVIORS),

  // --- Chat Behavior ---
  showTimestamps: z.boolean(),
  autoOpen: z.boolean(),
  privacyPolicyUrl: optionalUrl,
  termsUrl: optionalUrl,
  showBranding: z.boolean(),
} as const;

export const experienceDraftSchema = z.object(experienceFields);

export const updateExperienceSchema = experienceDraftSchema
  .partial()
  .extend({
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (data) =>
      Object.entries(data).some(([key, value]) => key !== 'expectedVersion' && value !== undefined),
    { message: 'Provide at least one experience setting to update.' }
  );

export type UpdateExperienceInput = z.infer<typeof updateExperienceSchema>;
export type ExperienceDraftInput = z.infer<typeof experienceDraftSchema>;

export const versionIdParamSchema = z.object({
  botId: z.string().uuid(),
  versionId: z.string().uuid(),
});

export const deploymentIdParamSchema = z.object({
  deploymentId: z.string().uuid(),
});

export const deploymentSlugParamSchema = z.object({
  slug: z.string().trim().min(1).max(80),
});

export const publishExperienceSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
});

export type PublishExperienceInput = z.infer<typeof publishExperienceSchema>;
