'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** How long typing must pause before `onChange` fires. */
  delay?: number;
  className?: string;
}

/**
 * A search box that reports changes on a delay.
 *
 * Every keystroke would otherwise be a request — and the requests can arrive out of order,
 * so a fast typist can end up looking at the results for a prefix they have already moved
 * past. Debouncing is what makes the server's `search` filter usable per keystroke rather
 * than per submit.
 *
 * The input keeps its own state so typing stays responsive: the parent's value only
 * changes when the debounce fires, so a controlled input bound straight to the parent would
 * lag behind the keyboard by the delay. The effect below re-syncs local state when the
 * parent *resets* the value (a filter chip clearing the search), which is the case the
 * local copy would otherwise miss.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  delay = 300,
  className = '',
}: SearchInputProps) {
  const [text, setText] = useState(value);
  // Held in a ref so the debounce timer never captures a stale callback. Assigned in an
  // effect rather than during render: React may render a component it does not commit,
  // and a render-phase write would leak that abandoned callback into the ref.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Re-sync when the parent changes the value from outside, but not on every render —
  // otherwise a debounced update would fight the user's next keystroke.
  //
  // Adjusted during render rather than in an effect, which is React's own pattern for
  // "state derived from a prop that the child also owns": an effect would render the stale
  // text once before correcting it, so a parent-driven reset would visibly flicker.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(value);
  }

  useEffect(() => {
    if (text === value) return;

    const timer = setTimeout(() => onChangeRef.current(text), delay);
    return () => clearTimeout(timer);
    // `value` is intentionally not a dependency: including it would restart the timer on
    // every debounced round trip and the search would never settle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, delay]);

  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus:border-accent focus:outline-none"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            // Both, immediately: clearing is an explicit action, so waiting out the
            // debounce would make the button feel broken.
            setText('');
            onChangeRef.current('');
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
