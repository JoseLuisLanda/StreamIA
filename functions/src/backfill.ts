/**
 * backfillAssistants callable (admin) -- one-time normalization of existing
 * assistant docs to the current schema. Adds any missing recently-added fields
 * with sensible defaults so old and new assistants behave identically.
 *
 *   - useCustomResponses -> all false (inherit global default responses)
 *   - contentModifiedAt  -> serverTimestamp() if missing
 *   - schemaVersion      -> current
 *
 * Keep this in sync with the client lib/rag/assistant-schema.ts version.
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

/** Mirror of ASSISTANT_SCHEMA_VERSION (client). Bump together when adding fields. */
const ASSISTANT_SCHEMA_VERSION = 2;

interface BackfillResult {
  scanned: number;
  updated: number;
  ids: string[];
}

export const backfillAssistants = onCall<unknown, Promise<BackfillResult>>(
  CALL_OPTS,
  async (req: CallableRequest<unknown>): Promise<BackfillResult> => {
    assertSignedIn(req.auth);
    if (ENFORCE_ADMIN_ROLE) await assertAdmin(req.auth);

    const snap = await db.collection('assistants').get();
    const ids: string[] = [];
    let scanned = 0;

    // Chunk into batches of <=400 writes.
    let batch = db.batch();
    let pending = 0;
    const commits: Promise<unknown>[] = [];

    for (const docSnap of snap.docs) {
      scanned++;
      const d = docSnap.data() as any;
      const patch: any = {};
      if (!d.useCustomResponses || typeof d.useCustomResponses !== 'object') {
        patch.useCustomResponses = {
          greetings: false, infoAcknowledgements: false, farewells: false, suggestedPrompts: false,
        };
      }
      if (d.contentModifiedAt == null) patch.contentModifiedAt = FieldValue.serverTimestamp();
      if (Number(d.schemaVersion ?? 0) < ASSISTANT_SCHEMA_VERSION) patch.schemaVersion = ASSISTANT_SCHEMA_VERSION;

      if (Object.keys(patch).length) {
        batch.set(docSnap.ref, patch, { merge: true });
        ids.push(docSnap.id);
        pending++;
        if (pending >= 400) {
          commits.push(batch.commit());
          batch = db.batch();
          pending = 0;
        }
      }
    }
    if (pending > 0) commits.push(batch.commit());
    await Promise.all(commits);

    if (!ENFORCE_ADMIN_ROLE) {
      // Surface a hint in logs that this also runs lazily on read client-side.
      logger.info('backfillAssistants (dev): normalized assistants', { scanned, updated: ids.length });
    }
    logger.info('backfillAssistants done', { scanned, updated: ids.length, ids });
    return { scanned, updated: ids.length, ids };
  },
);

// Avoid an unused-import lint if HttpsError ends up unreferenced in some builds.
void HttpsError;
