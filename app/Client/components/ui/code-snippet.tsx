'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CodeSnippetProps {
  /** The exact text the owner pastes — copied verbatim, never reformatted. */
  code: string;
  /** Short label naming the language, e.g. "HTML" or "URL". */
  language: string;
  /** Accessible name for the copy button when several snippets share a page. */
  copyLabel: string;
  disabled?: boolean;
}

type TokenKind = 'text' | 'tag' | 'attr' | 'string' | 'comment';

interface Token {
  text: string;
  kind: TokenKind;
}

/**
 * Split an HTML snippet into tag/attribute/string/comment runs for highlighting.
 *
 * Deliberately small and dependency-free: installation snippets are one or two
 * tags, so a purpose-built tokenizer beats a highlighter library. Three muted
 * tones only — code blocks are the one place monospace and colour-coding belong,
 * and they still should not look like a rainbow.
 */
function tokenizeHtml(code: string): Token[] {
  const tokens: Token[] = [];
  const commentPattern = /<!--[\s\S]*?-->/g;
  let rest = code;

  for (const match of code.matchAll(commentPattern)) {
    const index = match.index ?? 0;
    if (index > 0) {
      tokenizeMarkup(rest.slice(0, index), tokens);
      rest = rest.slice(index);
    }
    tokens.push({ text: match[0], kind: 'comment' });
    rest = rest.slice(match[0].length);
  }
  tokenizeMarkup(rest, tokens);

  return tokens;
}

function tokenizeMarkup(chunk: string, tokens: Token[]): void {
  const tagPattern = /<\/?[a-zA-Z][^<>]*>?/g;
  let last = 0;

  for (const match of chunk.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      tokens.push({ text: chunk.slice(last, index), kind: 'text' });
    }
    tokenizeTag(match[0], tokens);
    last = index + match[0].length;
  }

  if (last < chunk.length) {
    tokens.push({ text: chunk.slice(last), kind: 'text' });
  }
}

function tokenizeTag(tag: string, tokens: Token[]): void {
  const partPattern = /("[^"]*"|'[^']*'|[^\s"'=<>`]+|=|<|\/|\s+|\/?>)/g;

  for (const match of tag.matchAll(partPattern)) {
    const part = match[0];
    if (/^\s+$/.test(part) || part === '>' || part === '/>') {
      tokens.push({ text: part, kind: 'text' });
    } else if (
      part.startsWith('<') ||
      part === '=' ||
      part === '="' ||
      part === "='"
    ) {
      tokens.push({ text: part, kind: 'tag' });
    } else if (/^["']/.test(part)) {
      tokens.push({ text: part, kind: 'string' });
    } else if (/=$/.test(part)) {
      tokens.push({ text: part.slice(0, -1), kind: 'attr' });
      tokens.push({ text: '=', kind: 'tag' });
    } else {
      tokens.push({ text: part, kind: 'attr' });
    }
  }
}

const TOKEN_CLASSES: Record<TokenKind, string> = {
  text: 'text-muted-foreground',
  tag: 'text-foreground',
  attr: 'text-muted-foreground',
  string: 'text-accent-strong',
  comment: 'text-muted-foreground/70 italic',
};

/** Copy helper shared with callers that put Copy on their own buttons. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * A code block with one-click copy (CP-12.6).
 *
 * The snippet is rendered from tokens when it is HTML, verbatim otherwise —
 * either way the copied text is the exact `code` prop. Copy feedback lives on
 * the button ("Copied" for two seconds, an error line when the clipboard
 * refuses), so a failed copy is visible instead of silent.
 */
export function CodeSnippet({ code, language, copyLabel, disabled = false }: CodeSnippetProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const isHtml = /^\s*</.test(code);
  const tokens = isHtml ? tokenizeHtml(code) : [{ text: code, kind: 'text' as TokenKind }];

  async function handleCopy() {
    setCopyError(false);
    const ok = await copyTextToClipboard(code);
    if (ok) {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } else {
      setCopyError(true);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{language}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={disabled}
          aria-label={copyLabel}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copied ? (
            <>
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
              Copied
            </>
          ) : (
            <>
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto px-3 py-2.5 text-xs leading-5">
        <code>
          {tokens.map((token, index) => (
            <span key={index} className={TOKEN_CLASSES[token.kind]}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
      {copyError && (
        <p role="alert" className="border-t border-border px-3 py-1.5 text-xs text-destructive">
          Copy failed — select the code manually.
        </p>
      )}
    </div>
  );
}
