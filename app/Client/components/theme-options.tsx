import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import type { ThemeMode } from '@/lib/theme-context';

export interface ThemeOption {
  value: ThemeMode;
  label: string;
  description: string;
  icon: LucideIcon;
}

/**
 * One list for both places the choice appears: the account menu and the profile page.
 * A second copy is how the two surfaces drift apart.
 */
export const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'light',
    label: 'Light',
    description: 'Always use the light theme',
    icon: Sun,
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Always use the dark theme',
    icon: Moon,
  },
  {
    value: 'system',
    label: 'System',
    description: 'Match your device setting',
    icon: Monitor,
  },
];
