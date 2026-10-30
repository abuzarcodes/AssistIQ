'use client';

import { CardRadioGroup } from '@/components/ui/card-radio-group';
import { Input } from '@/components/ui/input';
import { RadioGroup } from '@/components/ui/radio-group';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import {
  EXPERIENCE_LIMITS,
  isHexColor,
  EXPERIENCE_DEFAULTS,
} from '@/lib/experience/config';
import type {
  ExperienceResponse,
  WidgetMobileBehavior,
  WidgetPosition,
} from '@/lib/api/experience';
import { ExperienceSection } from './experience-section';
import type { ExperienceChange } from './experience-types';
import type { ExperienceErrors } from './experience-validation';

interface ExperienceLayoutSectionProps {
  draft: ExperienceResponse;
  errors: ExperienceErrors;
  disabled: boolean;
  onChange: ExperienceChange;
}

const POSITION_ALIGN: Record<WidgetPosition, string> = {
  'bottom-right': 'items-end justify-end',
  'bottom-left': 'items-end justify-start',
  'top-right': 'items-start justify-end',
  'top-left': 'items-start justify-start',
};

const POSITION_OPTIONS: { value: WidgetPosition; label: string }[] = [
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'top-left', label: 'Top left' },
];

const MOBILE_OPTIONS: { value: WidgetMobileBehavior; label: string }[] = [
  { value: 'fullscreen', label: 'Full screen' },
  { value: 'modal', label: 'Modal panel' },
  { value: 'bottom-sheet', label: 'Bottom sheet' },
];

function PositionPreview({
  position,
  accent,
}: {
  position: WidgetPosition;
  accent: string;
}) {
  return (
    <span className="flex h-14 w-full flex-col justify-between rounded-lg border border-border bg-muted/40 p-2">
      <span className="h-1 w-8 rounded-full bg-border" />
      <span className={`flex flex-1 items-end ${POSITION_ALIGN[position]}`}>
        <span
          className="block h-3 w-9 rounded-full"
          style={{ backgroundColor: accent }}
        />
      </span>
    </span>
  );
}

/**
 * Layout: where the chat appears and how much room it takes in each delivery format.
 *
 * The three formats are separate because a dimension that suits a hosted page is wrong
 * for a floating widget. The controls are grouped by format for the same reason, with
 * the widget's own numbers kept in pixels the server can bound.
 */
export function ExperienceLayoutSection({
  draft,
  errors,
  disabled,
  onChange,
}: ExperienceLayoutSectionProps) {
  const accent = isHexColor(draft.accentColor)
    ? draft.accentColor
    : EXPERIENCE_DEFAULTS.accentColor;

  return (
    <ExperienceSection
      id="experience-layout"
      title="Layout"
      description="Page copy for the hosted chat, and the widget and iframe dimensions."
    >
      <div className="space-y-4">
        <span className="block text-sm font-medium text-foreground">
          Hosted page
        </span>
        <Input
          id="experience-hosted-title"
          label="Page title"
          value={draft.hostedPageTitle ?? ''}
          maxLength={EXPERIENCE_LIMITS.hostedPageTitle}
          disabled={disabled}
          error={errors.hostedPageTitle}
          placeholder="Chat with our team"
          onChange={(event) =>
            onChange('hostedPageTitle', event.target.value || null)
          }
        />
        <Textarea
          id="experience-hosted-description"
          label="Page description"
          value={draft.hostedPageDescription ?? ''}
          maxLength={EXPERIENCE_LIMITS.hostedPageDescription}
          disabled={disabled}
          error={errors.hostedPageDescription}
          placeholder="Ask about orders, returns or anything else."
          onChange={(event) =>
            onChange('hostedPageDescription', event.target.value || null)
          }
        />
      </div>

      <div className="space-y-4">
        <span className="block text-sm font-medium text-foreground">Widget</span>

        <div className="space-y-2">
          <span className="block text-sm font-medium text-foreground">
            Launcher position
          </span>
          <CardRadioGroup<WidgetPosition>
            label="Launcher position"
            value={draft.widgetPosition as WidgetPosition}
            columns={4}
            disabled={disabled}
            options={POSITION_OPTIONS.map((option) => ({
              ...option,
              preview: (
                <PositionPreview position={option.value} accent={accent} />
              ),
            }))}
            onChange={(value) => onChange('widgetPosition', value)}
          />
        </div>

        <Input
          id="experience-launcher-label"
          label="Launcher label"
          value={draft.widgetLauncherLabel ?? ''}
          maxLength={EXPERIENCE_LIMITS.widgetLauncherLabel}
          disabled={disabled}
          error={errors.widgetLauncherLabel}
          placeholder="Chat with us"
          onChange={(event) =>
            onChange('widgetLauncherLabel', event.target.value || null)
          }
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Slider
            id="experience-panel-width"
            label="Panel width"
            value={draft.widgetPanelWidth}
            min={EXPERIENCE_LIMITS.widgetPanelWidth.min}
            max={EXPERIENCE_LIMITS.widgetPanelWidth.max}
            step={10}
            valueText={`${draft.widgetPanelWidth} px`}
            disabled={disabled}
            onChange={(value) => onChange('widgetPanelWidth', value)}
          />
          <Slider
            id="experience-panel-height"
            label="Panel height"
            value={draft.widgetPanelHeight}
            min={EXPERIENCE_LIMITS.widgetPanelHeight.min}
            max={EXPERIENCE_LIMITS.widgetPanelHeight.max}
            step={10}
            valueText={`${draft.widgetPanelHeight} px`}
            disabled={disabled}
            onChange={(value) => onChange('widgetPanelHeight', value)}
          />
        </div>

        <div className="space-y-2">
          <RadioGroup<WidgetMobileBehavior>
            name="experience-mobile-behavior"
            label="On a phone"
            value={draft.widgetMobileBehavior as WidgetMobileBehavior}
            options={MOBILE_OPTIONS}
            disabled={disabled}
            onChange={(value) => onChange('widgetMobileBehavior', value)}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Full screen gives the conversation the whole viewport; a bottom sheet
            keeps the page visible behind it.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <span className="block text-sm font-medium text-foreground">Iframe</span>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            id="experience-iframe-width"
            label="Width"
            value={draft.iframeWidth}
            maxLength={EXPERIENCE_LIMITS.iframeWidth}
            disabled={disabled}
            error={errors.iframeWidth}
            placeholder="100%"
            spellCheck={false}
            onChange={(event) => onChange('iframeWidth', event.target.value)}
          />
          <Input
            id="experience-iframe-height"
            label="Height"
            value={draft.iframeHeight}
            maxLength={EXPERIENCE_LIMITS.iframeHeight}
            disabled={disabled}
            error={errors.iframeHeight}
            placeholder="600px"
            spellCheck={false}
            onChange={(event) => onChange('iframeHeight', event.target.value)}
          />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          A CSS length — <span className="whitespace-nowrap">100%</span>,{' '}
          <span className="whitespace-nowrap">600px</span> or{' '}
          <span className="whitespace-nowrap">90vh</span>. The embed takes this size
          inside its container.
        </p>
      </div>
    </ExperienceSection>
  );
}
