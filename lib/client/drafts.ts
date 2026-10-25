import { z } from 'zod';
import { confidenceSchema, studyActionSchema } from '@/lib/contracts/study';

const snapshotSchema = z.object({
  userId: z.uuid(),
  itemId: z.uuid(),
  questionId: z.uuid(),
  writerId: z.uuid(),
  baseVersion: z.number().int().nonnegative(),
  answer: z.string().max(12000),
  confidence: confidenceSchema,
  assisted: z.boolean(),
  updatedAt: z.string(),
  submission: studyActionSchema.options[2].nullable(),
  timingDisconnected: z.boolean(),
});
export type DraftSnapshot = z.infer<typeof snapshotSchema>;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sweprep-drafts-v1', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('LOCAL_STORAGE_UNAVAILABLE'));
    request.onblocked = () => reject(new Error('LOCAL_STORAGE_UNAVAILABLE'));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', mode);
    const request = operation(tx.objectStore('snapshots'));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(new Error('LOCAL_STORAGE_UNAVAILABLE'));
    };
    tx.onabort = () => {
      db.close();
      reject(new Error('LOCAL_STORAGE_UNAVAILABLE'));
    };
  });
}

export async function readDraft(
  userId: string,
  itemId: string,
  writerId: string,
) {
  const values: unknown[] = await transaction('readonly', (store) =>
    store.getAll(),
  );
  const candidates = values
    .map((value) => snapshotSchema.safeParse(value))
    .flatMap((parsed) =>
      parsed.success &&
      parsed.data.userId === userId &&
      parsed.data.itemId === itemId
        ? [parsed.data]
        : [],
    );
  return (
    candidates.find((value) => value.writerId === writerId) ??
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
    null
  );
}

export async function writeDraft(snapshot: DraftSnapshot) {
  await transaction('readwrite', (store) =>
    store.put(
      snapshotSchema.parse(snapshot),
      `${snapshot.userId}:${snapshot.itemId}:${snapshot.writerId}`,
    ),
  );
}

export async function removeDraft(userId: string, itemId: string) {
  const keys = await transaction('readonly', (store) => store.getAllKeys());
  await Promise.all(
    keys
      .filter((key) => String(key).startsWith(`${userId}:${itemId}:`))
      .map((key) => transaction('readwrite', (store) => store.delete(key))),
  );
}

export async function clearDrafts() {
  await transaction('readwrite', (store) => store.clear());
}
