'use client';

import Link from 'next/link';
import { Users, FolderOpen, Activity, FlaskConical, Cpu, ArrowRight, SlidersHorizontal } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';

/**
 * Platform administration overview.
 *
 * Reachability here is decided by `PlatformGuard` in the layout — by the time this
 * renders, the viewer is known to be a PLATFORM_OWNER.
 */
const sections = [
  {
    href: '/platform/users',
    label: 'Users',
    description: 'Every account on the platform and its platform role.',
    icon: Users,
  },
  {
    href: '/platform/workspaces',
    label: 'Workspaces',
    description: 'All tenants, their owners, and their size.',
    icon: FolderOpen,
  },
  {
    href: '/platform/system',
    label: 'System',
    description: 'Database and AI service health at a glance.',
    icon: Activity,
  },
  {
    href: '/platform/settings',
    label: 'Settings',
    description: 'Upload limits enforced across every workspace.',
    icon: SlidersHorizontal,
  },
  {
    href: '/platform/models',
    label: 'Models',
    description: 'Providers and the models workspaces may select.',
    icon: Cpu,
  },
  {
    href: '/platform/ai-lab',
    label: 'AI Lab',
    description: 'Inspect and exercise the AI/ML pipeline directly.',
    icon: FlaskConical,
  },
];

export default function PlatformPage() {
  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">Platform administration</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Cross-tenant views reserved for platform owners.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {sections.map(({ href, label, description, icon: Icon }) => (
          <Link key={href} href={href} className="group">
            <Card className="h-full transition-colors group-hover:border-accent">
              <CardBody>
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <Icon className="h-4 w-4 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium text-foreground">{label}</p>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                  </div>
                </div>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
