'use client';

import {
  Bell,
  Link2,
  LockKeyhole,
  type LucideIcon,
} from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { ThemeModeCards } from '@/components/theme-mode-cards';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/theme-context';

const COMING_SOON: {
  icon: LucideIcon;
  label: string;
  description: string;
}[] = [
  {
    icon: Bell,
    label: 'Notifications',
    description: 'Choose which product updates and support summaries reach your inbox.',
  },
  {
    icon: LockKeyhole,
    label: 'Password and security',
    description: 'Change your password and review the devices signed in to your account.',
  },
  {
    icon: Link2,
    label: 'Connected accounts',
    description: 'Link the tools your team already uses to the workspaces you own.',
  },
];

function initialOf(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export default function ProfilePage() {
  const { user, platformRole } = useAuth();
  const { mode, resolvedTheme } = useTheme();

  const name = user?.name ?? 'Your account';
  const roleLabel = platformRole === 'PLATFORM_OWNER' ? 'Platform owner' : 'Member';
  const themeStatus =
    mode === 'system'
      ? `Following your device — currently ${resolvedTheme}.`
      : `${mode === 'dark' ? 'Dark' : 'Light'} theme selected.`;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Profile"
        description="Your account details and how AssistIQ looks."
      />

      <div className="space-y-6">
        <Card>
          <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <span
              aria-hidden="true"
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent-bg text-xl font-semibold text-accent-bg-foreground"
            >
              {initialOf(name)}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                {name}
              </h2>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {user?.email ?? 'Signed in'}
              </p>
            </div>
            <Badge className="self-start sm:self-center">{roleLabel}</Badge>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Appearance</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose how AssistIQ looks. Your choice is saved on this device.
            </p>
          </CardHeader>
          <CardBody className="space-y-4">
            <ThemeModeCards />
            <p className="text-xs text-muted-foreground">{themeStatus}</p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Profile details</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className="grid gap-5 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Display name
                </dt>
                <dd className="mt-1 text-sm text-foreground">{name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Email address
                </dt>
                <dd className="mt-1 truncate text-sm text-foreground">
                  {user?.email ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">
                  Account role
                </dt>
                <dd className="mt-1 text-sm text-foreground">{roleLabel}</dd>
              </div>
            </dl>

            <p className="mt-5 rounded-lg bg-muted px-3.5 py-3 text-xs leading-5 text-muted-foreground">
              Profile editing is coming soon. Your name and email currently come
              from the account you signed in with.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">More settings</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Account preferences that will live here as they are built.
            </p>
          </CardHeader>
          <CardBody>
            <ul className="divide-y divide-border">
              {COMING_SOON.map(({ icon: Icon, label, description }) => (
                <li
                  key={label}
                  className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{label}</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {description}
                    </p>
                  </div>
                  <Badge className="shrink-0">Coming soon</Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
