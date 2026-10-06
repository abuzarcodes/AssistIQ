'use client';

import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';

interface FileInputProps {
  id: string;
  label: string;
  /** Comma-separated accept list, e.g. `image/png,image/jpeg,image/webp`. */
  accept: string;
  onSelect: (file: File) => void;
  hint?: string;
  error?: string;
  disabled?: boolean;
  /** Rendered inside the drop target, e.g. "PNG, JPEG or WebP, up to 512 KB". */
  acceptLabel?: string;
}

/**
 * A keyboard-operable file picker with a drag-and-drop target.
 *
 * The native `<input type="file">` is kept (visually hidden but focusable) so the control
 * retains its real semantics; the visible surface forwards clicks and drops to it. Keyboard
 * users reach it by tab and open the picker with Enter or Space, exactly as a native input.
 */
export function FileInput({
  id,
  label,
  accept,
  onSelect,
  hint,
  error,
  disabled = false,
  acceptLabel,
}: FileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) onSelect(file);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? 'border-accent bg-muted' : 'border-border'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(e) => handleFiles(e.target.files)}
          className="sr-only"
        />
        <Upload className="h-4 w-4 text-muted-foreground" />
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="text-sm font-medium text-accent cursor-pointer disabled:cursor-not-allowed"
        >
          Choose a file
        </button>
        <p className="text-xs text-muted-foreground">{acceptLabel ?? 'or drag and drop'}</p>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}