'use client';

import { useState, type ReactNode } from 'react';

interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  /**
   * The tab to show, when the caller needs to drive it.
   *
   * Uncontrolled by default — the component owns which tab is active, which is what every
   * existing caller wants. Passing `activeTab` hands that ownership to the parent, and it
   * must then also pass `onTabChange`, or clicking a tab header would do nothing.
   */
  activeTab?: string;
  onTabChange?: (id: string) => void;
}

export function Tabs({ tabs, defaultTab, activeTab, onTabChange }: TabsProps) {
  const [internalActive, setInternalActive] = useState(defaultTab || tabs[0]?.id);
  const active = activeTab ?? internalActive;

  function select(id: string) {
    setInternalActive(id);
    onTabChange?.(id);
  }

  const activeTabContent = tabs.find((t) => t.id === active)?.content;

  return (
    <div>
      <div className="flex border-b border-border overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => select(tab.id)}
            className={`shrink-0 px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer border-b-2 -mb-px ${
              active === tab.id
                ? 'border-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="pt-5 animate-fade-in" key={active}>
        {activeTabContent}
      </div>
    </div>
  );
}
