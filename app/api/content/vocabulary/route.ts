import { z } from 'zod';
import {
  linkedTermsSchema,
  termDefinitionSchema,
  vocabularyLookupSchema,
} from '@/lib/contracts/content';
import { authenticatedClient } from '@/lib/server/db/user-client';
import {
  dbError,
  errorResponse,
  json,
  readJson,
  sameOrigin,
} from '@/lib/server/http';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { db } = await authenticatedClient();
    const params = new URL(request.url).searchParams;
    const query = z
      .object({ itemId: z.uuid() })
      .strict()
      .safeParse(Object.fromEntries(params));
    if (!query.success || params.getAll('itemId').length !== 1)
      throw new Error('VALIDATION_ERROR');
    const { data, error } = await db.rpc('item_vocabulary', {
      p_item: query.data.itemId,
    });
    dbError(error);
    return json(linkedTermsSchema.parse(data));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { db } = await authenticatedClient();
    const parsed = vocabularyLookupSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new Error('VALIDATION_ERROR');
    const { data, error } = await db.rpc('lookup_vocabulary', {
      p_item: parsed.data.itemId,
      p_term: parsed.data.termId,
      p_key: parsed.data.key,
    });
    dbError(error);
    return json(termDefinitionSchema.parse(data));
  } catch (error) {
    return errorResponse(error);
  }
}
