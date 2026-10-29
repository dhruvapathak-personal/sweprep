import { authenticatedClient } from '@/lib/server/db/user-client';
import { errorResponse, json } from '@/lib/server/http';
import { readCatalog } from '@/lib/server/services/content';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const { db } = await authenticatedClient();
    return json(await readCatalog(db, request, 'question'));
  } catch (error) {
    return errorResponse(error);
  }
}
