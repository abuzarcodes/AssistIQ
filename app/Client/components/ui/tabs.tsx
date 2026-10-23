'use client';

import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

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
  ariaLabel?: string;
}

export function Tabs({
  tabs,
  defaultTab,
  activeTab,
  onTabChange,
  ariaLabel = 'Tabs',
}: TabsProps) {
  const [internalActive, setInternalActive] = useState(defaultTab || tabs[0]?.id);
  const active = activeTab ?? internalActive;
  const instanceId = useId().replace(/:/g, '');
  const tabId = (id: string) => `${instanceId}-tab-${id}`;
  const panelId = `${instanceId}-panel`;

  function select(id: string) {
    setInternalActive(id);
    onTabChange?.(id);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const lastIndex = tabs.length - 1;
    let nextIndex: number | null = null;

    if (event.key === 'ArrowRight') nextIndex = index === lastIndex ? 0 : index + 1;
    if (event.key === 'ArrowLeft') nextIndex = index === 0 ? lastIndex : index - 1;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = lastIndex;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    select(nextTab.id);
    document.getElementById(tabId(nextTab.id))?.focus();
  }

  const activeTabContent = tabs.find((t) => t.id === active)?.content;

  return (
    <div>
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className="flex overflow-x-auto border-b border-border"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={tabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={panelId}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => select(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            className={`-mb-px shrink-0 cursor-pointer border-b-2 px-2.5 py-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:px-4 sm:text-sm ${
              active === tab.id
                ? 'border-accent text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={active ? tabId(active) : undefined}
        className="pt-5 animate-fade-in"
        key={active}
      >
        {activeTabContent}
      </div>
    </div>
  );
}
