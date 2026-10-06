import type { ReactNode } from 'react';
import { Sidebar } from '@/components/sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="lg:pl-60">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pt-14 lg:pt-6">
          {children}
        </div>
      </main>
    </div>
  );
}
