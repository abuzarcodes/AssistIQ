'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, FileText } from 'lucide-react';
import { testRetrieval, type RetrievalResult } from '@/lib/api/knowledgeChunks';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api-client';

interface RetrievalTabProps {
  botId: string;
}

const TOP_K_OPTIONS = [
  { value: '3', label: 'Top 3' },
  { value: '5', label: 'Top 5' },
  { value: '10', label: 'Top 10' },
  { value: '20', label: 'Top 20' },
];

/**
 * Retrieval testing (section 15.7).
 *
 * Runs the same search a chat reply runs, so the results are the ones the bot would
 * actually have used — including the exclusion of disabled chunks, which happens in SQL
 * rather than here. That makes this the honest way to answer "why did the bot say that?":
 * a chunk missing from these results is a chunk the bot could not have cited.
 */
export function RetrievalTab({ botId }: RetrievalTabProps) {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState('5');
  const [results, setResults] = useState<RetrievalResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  // The query the current results belong to. Kept apart from `query` so the heading of the
  // result list keeps naming the search that produced it while the user types the next one.
  const [answeredQuery, setAnsweredQuery] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    setError('');

    try {
      const response = await testRetrieval(botId, query.trim(), Number(topK));
      setResults(response.results);
      setAnsweredQuery(response.query);
    } catch (err) {
      setResults(null);
      setError(
        err instanceof ApiError
          ? err.message
          : 'The retrieval service did not respond. Check that the AI service is running.',
      );
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[220px]">
          <label htmlFor="retrieval-query" className="text-sm font-medium text-foreground">
            Query
          </label>
          <input
            id="retrieval-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask what a customer would ask…"
            className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-accent focus:outline-none"
          />
        </div>

        <div className="w-32">
          <Select
            id="retrieval-top-k"
            label="Results"
            value={topK}
            onChange={(e) => setTopK(e.target.value)}
            options={TOP_K_OPTIONS}
          />
        </div>

        <Button type="submit" size="md" loading={searching} disabled={!query.trim()}>
          <Search className="h-3.5 w-3.5" />
          Test
        </Button>
      </form>

      {error && (
        <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
          {error}
        </div>
      )}

      {searching && (
        <div className="flex items-center justify-center py-16">
          <Spinner size="lg" />
        </div>
      )}

      {!searching && results === null && !error && (
        <EmptyState
          icon={Search}
          title="Test what the bot retrieves"
          description="Enter a question to see which chunks the bot would pull from its knowledge base, and how closely each one matched."
        />
      )}

      {!searching && results !== null && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {results.length === 0
              ? `Nothing matched “${answeredQuery}”.`
              : `${results.length} match${results.length === 1 ? '' : 'es'} for “${answeredQuery}”`}
          </p>

          {results.length === 0 && (
            <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
              Either nothing in the knowledge base is close enough to that question, or every
              matching chunk is disabled. Disabled chunks are excluded from retrieval, which is
              why they never appear here.
            </div>
          )}

          {results.map((result, index) => (
            <div key={result.chunkId} className="rounded-xl border border-border px-4 py-3">
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-medium text-muted-foreground tabular-nums shrink-0">
                    #{index + 1}
                  </span>
                  {result.source ? (
                    <Link
                      href={`/dashboard/bots/${botId}/knowledge/sources/${result.sourceId}`}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors min-w-0"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{result.source.filename}</span>
                      {result.pageNumber !== null && <span className="shrink-0">· p.{result.pageNumber}</span>}
                    </Link>
                  ) : (
                    // A vector with no matching source row is a FAQ entry's, not a bug; the
                    // id it carries is the knowledge entry's. Labelled rather than hidden,
                    // because "where did this come from?" is the question this tab answers.
                    <span className="text-xs text-muted-foreground">FAQ entry</span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <div className="hidden sm:block h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.max(0, Math.min(1, result.score)) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-foreground tabular-nums">
                    {result.score.toFixed(3)}
                  </span>
                </div>
              </div>

              <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                {result.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
