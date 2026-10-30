// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContentCatalog } from '@/components/content-catalog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const entry = (title: string) => ({
  id: '40000000-0000-4000-8000-000000000001',
  stableId: title,
  version: 1,
  title,
  domain: 'cpp',
  category: 'Explain',
  qualificationPolicy: 'content-policy-v2',
  uncalibrated: true,
});
it('pages through authenticated results and resets the cursor when filters change', async () => {
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({
        entries: [entry('First synthetic page')],
        catalogRevision: '2',
        nextCursor: 'opaque',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        entries: [entry('Second synthetic page')],
        catalogRevision: '2',
        nextCursor: null,
      }),
    )
    .mockResolvedValue(
      Response.json({ entries: [], catalogRevision: '2', nextCursor: null }),
    );
  const start = vi.fn();
  render(<ContentCatalog disabled={false} start={start} />);
  await screen.findByText('First synthetic page');
  fireEvent.click(screen.getByRole('button', { name: /First synthetic page/ }));
  expect(start).toHaveBeenCalledWith(entry('').id);
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('Second synthetic page');
  expect(transport.mock.calls[1][0]).toBe(
    '/api/content/questions?cursor=opaque',
  );
  fireEvent.change(screen.getByLabelText('Domain'), {
    target: { value: 'python' },
  });
  await screen.findByText(/No content has qualified/);
  expect(transport.mock.calls[2][0]).toBe(
    '/api/content/questions?domain=python',
  );
  expect(screen.queryByText('Second synthetic page')).toBeNull();
});
it('does not silently continue a revision-changed catalog', async () => {
  const transport = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({
        entries: [entry('Synthetic current')],
        catalogRevision: '1',
        nextCursor: 'stale',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: 'CATALOG_CHANGED' }, { status: 409 }),
    )
    .mockResolvedValue(
      Response.json({ entries: [], catalogRevision: '2', nextCursor: null }),
    );
  render(<ContentCatalog disabled={false} start={() => {}} />);
  await screen.findByText('Synthetic current');
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('The catalog changed. Restart from the first page.');
  expect(screen.queryByText('Synthetic current')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Restart catalog' }));
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
  expect(transport.mock.calls[2][0]).toBe('/api/content/questions?');
});
