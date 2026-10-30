/**
 * Single source of truth for Bot Experience Studio configuration defaults and limits.
 */

export const EXPERIENCE_DEFAULTS = {
  // Branding
  displayName: null,
  botAvatarUrl: null,
  businessLogoUrl: null,
  accentColor: '#ff6b35',
  userBubbleColor: null,
  botBubbleColor: null,
  themeMode: 'system',
  themePreset: null,

  // Layout
  hostedPageTitle: null,
  hostedPageDescription: null,
  widgetPosition: 'bottom-right',
  widgetLauncherLabel: null,
  widgetPanelWidth: 400,
  widgetPanelHeight: 600,
  widgetMobileBehavior: 'fullscreen',
  iframeWidth: '100%',
  iframeHeight: '600px',

  // Welcome
  welcomeMessage: null,
  welcomeSubtitle: null,
  inputPlaceholder: null,
  suggestedQuestions: [] as string[],
  firstOpenBehavior: 'welcome',

  // Chat Behavior
  showTimestamps: true,
  autoOpen: false,
  privacyPolicyUrl: null,
  termsUrl: null,
  showBranding: true,
} as const;

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export const THEME_PRESETS = ['minimal', 'professional', 'friendly', 'dark'] as const;
export const WIDGET_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
export const WIDGET_MOBILE_BEHAVIORS = ['fullscreen', 'modal', 'bottom-sheet'] as const;
export const FIRST_OPEN_BEHAVIORS = ['welcome', 'empty', 'prompt'] as const;

export const EXPERIENCE_LIMITS = {
  displayName: 60,
  botAvatarUrl: 500,
  businessLogoUrl: 500,
  accentColor: 9,
  themeMode: 10,
  themePreset: 20,

  hostedPageTitle: 120,
  hostedPageDescription: 500,
  widgetPosition: 20,
  widgetLauncherLabel: 40,
  widgetPanelWidth: { min: 280, max: 800 },
  widgetPanelHeight: { min: 400, max: 1000 },
  widgetMobileBehavior: 20,
  iframeWidth: 20,
  iframeHeight: 20,

  welcomeMessage: 500,
  welcomeSubtitle: 200,
  inputPlaceholder: 120,
  suggestedQuestions: { max: 10, item: 120 },
  firstOpenBehavior: 20,

  privacyPolicyUrl: 500,
  termsUrl: 500,
} as const;
