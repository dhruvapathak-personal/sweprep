import { studyActionSchema } from '@/lib/contracts/study';
import { authenticatedClient } from '@/lib/server/db/user-client';
import {
  dbError,
  errorResponse,
  json,
  readJson,
  sameOrigin,
} from '@/lib/server/http';
import { changeStudy, readStudy } from '@/lib/server/services/study';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { db, user } = await authenticatedClient();
    return json(await readStudy(db, user));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { db, user } = await authenticatedClient();
    const parsed = studyActionSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new Error('VALIDATION_ERROR');
    const result = await changeStudy(db, parsed.data);
    return json({ result, state: await readStudy(db, user) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    const { db } = await authenticatedClient();
    const { error } = await db.auth.signOut();
    dbError(error);
    return json({ signedOut: true });
  } catch (error) {
    return errorResponse(error);
  }
}
