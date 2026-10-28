import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/contracts/database.types';
import { catalogPageSchema, catalogQuerySchema } from '@/lib/contracts/content';
import { dbError } from '@/lib/server/http';

export async function readCatalog(
  db: SupabaseClient<Database>,
  request: Request,
  kind: 'question' | 'term',
) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((name) => params.getAll(name).length !== 1))
    throw new Error('VALIDATION_ERROR');
  const parsed = catalogQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw new Error('VALIDATION_ERROR');
  const query = parsed.data;
  const { data, error } = await db.rpc('content_catalog', {
    p_kind: kind,
    p_domain: query.domain,
    p_category: query.category,
    p_cursor: query.cursor,
    p_limit: query.limit,
  });
  dbError(error);
  return catalogPageSchema.parse(data);
}
