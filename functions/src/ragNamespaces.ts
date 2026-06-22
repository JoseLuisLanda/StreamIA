/**
 * RAG namespace management callables (strimearia) -- Admin SDK, server-side.
 *
 * Namespaces are first-class, independent entities (a namespace may be shared by
 * many assistants). rag_namespaces/{id} is the source of truth for which exist;
 * rag/{id}/{documents|chunks|media} holds the content.
 *
 *   - listNamespaces()          -> all rag_namespaces docs, each with a live
 *                                  documentCount (count of rag/{ns}/documents) so
 *                                  the UI can tell empty namespaces apart.
 *   - createNamespace({ name }) -> validate (non-empty, lowercase [a-z0-9_-], no
 *                                  spaces, unique) and create rag_namespaces/{name}.
 *   - deleteNamespace({ name }) -> delete ONLY when rag/{ns}/{documents,chunks,
 *                                  media} are ALL empty; otherwise reject.
 *
 * Auth: signed-in always; admin enforced when ENFORCE_ADMIN_ROLE (mirrors
 * ingestDocument's dev/prod gate). This module does NOT touch the rag/{ns}/...
 * storage layout or any ingestion / embedding / retrieval logic.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

/** Allowed namespace id: lowercase letters, digits, '-' and '_' only. */
const NS_RE = /^[a-z0-9_-]+$/;

interface NamespaceRow {
  id: string;
  name: string;
  createdAt?: number;
  documentCount: number;
}

/** Auth gate: signed-in always; admin only when ENFORCE_ADMIN_ROLE is on. */
async function gate(auth: Parameters<typeof assertSignedIn>[0]): Promise<void> {
  assertSignedIn(auth);
  if (ENFORCE_ADMIN_ROLE) await assertAdmin(auth);
}

function toMs(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return undefined;
}

/** Server-side count of a rag/{ns}/{sub} subcollection (aggregation query). */
async function subCount(ns: string, sub: string): Promise<number> {
  const snap = await db.collection('rag').doc(ns).collection(sub).count().get();
  return snap.data().count;
}

export const listNamespaces = onCall<unknown, Promise<{ namespaces: NamespaceRow[] }>>(
  CALL_OPTS,
  async (req): Promise<{ namespaces: NamespaceRow[] }> => {
    await gate(req.auth);
    const snap = await db.collection('rag_namespaces').get();
    const rows = await Promise.all(
      snap.docs.map(async (d) => {
        const data = d.data() as any;
        const documentCount = await subCount(d.id, 'documents').catch(() => 0);
        return {
          id: d.id,
          name: (data.name as string) ?? d.id,
          createdAt: toMs(data.createdAt),
          documentCount,
        };
      }),
    );
    rows.sort((a, b) => a.id.localeCompare(b.id));
    return { namespaces: rows };
  },
);

export const createNamespace = onCall<{ name?: string }, Promise<{ ok: true; id: string; name: string }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true; id: string; name: string }> => {
    await gate(req.auth);
    const raw = (req.data?.name ?? '').trim();
    if (!raw) throw new HttpsError('invalid-argument', 'Namespace name is required.');
    const id = raw.toLowerCase();
    if (!NS_RE.test(id)) {
      throw new HttpsError(
        'invalid-argument',
        "Invalid namespace. Use only lowercase letters, digits, '-' and '_' (no spaces).",
      );
    }
    const ref = db.collection('rag_namespaces').doc(id);
    const existing = await ref.get();
    if (existing.exists) {
      throw new HttpsError('already-exists', `Namespace "${id}" already exists.`);
    }
    await ref.set({ name: id, createdAt: FieldValue.serverTimestamp() });
    logger.info('createNamespace', { by: req.auth?.uid, id });
    return { ok: true, id, name: id };
  },
);

export const deleteNamespace = onCall<{ name?: string }, Promise<{ ok: true; id: string }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true; id: string }> => {
    await gate(req.auth);
    const id = (req.data?.name ?? '').trim().toLowerCase();
    if (!id) throw new HttpsError('invalid-argument', 'Namespace name is required.');

    const ref = db.collection('rag_namespaces').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', `Namespace "${id}" not found.`);

    // Delete only when EVERY content subcollection is empty.
    const [documents, chunks, media] = await Promise.all([
      subCount(id, 'documents').catch(() => 0),
      subCount(id, 'chunks').catch(() => 0),
      subCount(id, 'media').catch(() => 0),
    ]);
    if (documents > 0 || chunks > 0 || media > 0) {
      throw new HttpsError(
        'failed-precondition',
        `Namespace is not empty; remove its documents first ` +
          `(documents: ${documents}, chunks: ${chunks}, media: ${media}).`,
      );
    }

    await ref.delete();
    logger.info('deleteNamespace', { by: req.auth?.uid, id });
    return { ok: true, id };
  },
);
