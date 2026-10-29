'use client';

import { useEffect, useState } from 'react';
import {
  catalogPageSchema,
  categories,
  domains,
  type CatalogPage,
} from '@/lib/contracts/content';

export function ContentCatalog({
  disabled,
  start,
}: {
  disabled: boolean;
  start: (id: string) => void;
}) {
  const [kind, setKind] = useState('questions');
  const [domain, setDomain] = useState('');
  const [category, setCategory] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<CatalogPage>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const cursor = cursors.at(-1);
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams();
    if (domain) params.set('domain', domain);
    if (category && kind === 'questions') params.set('category', category);
    if (cursor) params.set('cursor', cursor);
    void fetch(`/api/content/${kind}?${params}`, {
      cache: 'no-store',
      signal: abort.signal,
    })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            value.error === 'CATALOG_CHANGED'
              ? 'The catalog changed. Restart from the first page.'
              : 'The catalog is unavailable. Retry without losing your history.',
          );
        return catalogPageSchema.parse(value);
      })
      .then((value) => {
        if (!abort.signal.aborted) setPage(value);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(String(reason.message));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [category, cursor, domain, kind, reload]);
  function reset() {
    setPage(undefined);
    setError('');
    setLoading(true);
    setCursors([]);
    setReload((value) => value + 1);
  }
  function turn(next: string[]) {
    setPage(undefined);
    setError('');
    setLoading(true);
    setCursors(next);
  }
  return (
    <section aria-labelledby="catalog-title">
      <h3 id="catalog-title">Qualified content catalog</h3>
      <p className="fine-print">
        Current versions only · author-estimated difficulty is uncalibrated.
        Term listings show names, not definitions or mastery.
      </p>
      <div className="catalog-filters">
        <div>
          <label htmlFor="catalog-kind">Content</label>
          <select
            id="catalog-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              reset();
            }}
          >
            <option value="questions">Questions</option>
            <option value="terms">Terms</option>
          </select>
        </div>
        <div>
          <label htmlFor="catalog-domain">Domain</label>
          <select
            id="catalog-domain"
            value={domain}
            onChange={(event) => {
              setDomain(event.target.value);
              reset();
            }}
          >
            <option value="">All domains</option>
            {domains.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="catalog-category">Category</label>
          <select
            id="catalog-category"
            value={category}
            disabled={kind === 'terms'}
            onChange={(event) => {
              setCategory(event.target.value);
              reset();
            }}
          >
            <option value="">All categories</option>
            {categories.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </div>
      </div>
      <div role="status" aria-live="polite">
        {loading
          ? 'Loading qualified content…'
          : error ||
            (page?.entries.length
              ? `Page ${cursors.length + 1} · ${page.entries.length} ${kind} · catalog revision ${page.catalogRevision}`
              : 'No content has qualified for these filters. Candidates are never offered for study.')}
      </div>
      {error && (
        <button className="secondary" onClick={reset}>
          Restart catalog
        </button>
      )}
      <div className="question-list">
        {page?.entries.map((value) =>
          kind === 'questions' ? (
            <button
              className="question-choice"
              key={value.id}
              disabled={disabled || loading}
              onClick={() => start(value.id)}
            >
              <span>
                <strong>{value.title}</strong>
                <small>
                  {value.domain} · {value.category} · v{value.version} ·{' '}
                  {value.qualificationPolicy} · uncalibrated
                </small>
              </span>
              <span aria-hidden="true">↗</span>
            </button>
          ) : (
            <p key={value.id}>
              <strong>{value.title}</strong>
              <br />
              <small>
                {value.domain} · v{value.version} · {value.qualificationPolicy}
              </small>
            </p>
          ),
        )}
      </div>
      <nav className="actions" aria-label="Catalog pages">
        <button
          className="secondary"
          disabled={loading || cursors.length === 0}
          onClick={() => turn(cursors.slice(0, -1))}
        >
          Previous page
        </button>
        <button
          className="secondary"
          disabled={loading || !page?.nextCursor}
          onClick={() =>
            page?.nextCursor && turn([...cursors, page.nextCursor])
          }
        >
          Next page
        </button>
      </nav>
    </section>
  );
}
