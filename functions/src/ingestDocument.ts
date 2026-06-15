/**
 * Callable Function: ingestDocument
 *
 * PDF -> extract -> chunk -> embed -> Firestore (VectorValue). Admin-only. All
 * heavy work + the embedding credentials stay server-side; the client only
 * orchestrates and reads status.
 *
 * Request:
 *   { namespace, storagePath, docId?, options?: { chunkSize?, overlap? } }
 * Response:
 *   { docId, chunks, status: 'done'|'error', message? }
 *
 * Errors are returned as { status:'error', message } (not thrown) so the client
 * gets a clean result, EXCEPT auth failures which throw HttpsError (so the SDK
 * surfaces unauthenticated/permission-denied distinctly). Details are logged.
 */
import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db, bucket } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';
import { extractPdfText } from './lib/pdf';
import { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP } from './lib/chunk';
import { embedText, EMBED_MODEL, EMBED_DIMENSIONS } from './lib/embeddings';

interface IngestRequest {
  namespace: string;
  storagePath: string;
  docId?: string;
  options?: { chunkSize?: number; overlap?: number };
}

interface IngestResponse {
  docId: string;
  chunks: number;
  status: 'done' | 'error';
  message?: string;
}

const WRITE_BATCH_LIMIT = 400; // < Firestore's 500 ops/batch

export const ingestDocument = onCall<IngestRequest, Promise<IngestResponse>>(
  // generic <RequestData, Return>; Return = Promise<IngestResponse> (async handler)
  // cors:true lets the callable reflect the request Origin. NOTE: this does NOT
  // bypass the Cloud Run public-invoker requirement -- if you still get a CORS
  // preflight error, the function isn't deployed/public (see CORS_FIX.md).
  { region: 'us-central1', timeoutSeconds: 540, memory: '1GiB', cors: true },
  async (request: CallableRequest<IngestRequest>): Promise<IngestResponse> => {
    // 1) Auth. ALWAYS require a signed-in user. The admin-role requirement is
    //    gated by ENFORCE_ADMIN_ROLE: false in dev (any signed-in user may
    //    ingest), true in production (restores the original admin check).
    assertSignedIn(request.auth);
    if (ENFORCE_ADMIN_ROLE) {
      await assertAdmin(request.auth);
    }

    const { namespace, storagePath } = request.data ?? ({} as IngestRequest);
    let docId = request.data?.docId;

    // Basic validation -> returned as error result (not thrown).
    if (!namespace || !storagePath) {
      return errorResult(docId ?? '', 'namespace and storagePath are required.');
    }
    if (!/^rag-docs\//.test(storagePath)) {
      return errorResult(docId ?? '', `storagePath must be under rag-docs/ (got "${storagePath}").`);
    }

    // Stable docId: reuse on re-processing, else derive a new one.
    // NOTE: status lives at rag/{ns}/documents/{docId} to MATCH the admin panel
    // (RagAdminService). The task brief said `docs`; we use `documents` so the
    // already-shipped panel sees status. Flagged in FUNCTIONS_README.md.
    if (!docId) docId = db.collection('rag').doc(namespace).collection('documents').doc().id;

    const docRef = db.collection('rag').doc(namespace).collection('documents').doc(docId);
    const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
    // Recover the original filename by stripping our "{docId}__" upload prefix.
    const filename = (storagePath.split('/').pop() || storagePath).replace(/^[A-Za-z0-9]+__/, '');

    try {
      // Mark processing.
      await docRef.set(
        { status: 'processing', filename, sourcePath: storagePath, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );

      // 2) Download the PDF from strimearia Storage.
      const file = bucket.file(storagePath);
      const [exists] = await file.exists();
      if (!exists) return await fail(docRef, docId, `PDF not found at ${storagePath}.`);
      const [buffer] = await file.download();

      // 3) Extract text.
      const { text, pages } = await extractPdfText(buffer);
      if (!text || text.length < 10) {
        return await fail(docRef, docId, 'No extractable text in PDF (is it scanned/image-only?).');
      }

      // 4) Chunk.
      const chunkSize = request.data?.options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
      const overlap = request.data?.options?.overlap ?? DEFAULT_OVERLAP;
      const pieces = chunkText(text, { chunkSize, overlap });
      if (!pieces.length) return await fail(docRef, docId, 'Chunking produced no chunks.');

      // 5) Embed (model/dimensions must match the vector index).
      const vectors = await embedText(pieces);
      if (vectors[0]?.length !== EMBED_DIMENSIONS) {
        logger.warn('ingestDocument: embedding dim != EMBED_DIMENSIONS', {
          got: vectors[0]?.length,
          expected: EMBED_DIMENSIONS,
          model: EMBED_MODEL,
        });
      }

      // 7) Re-processing: delete this doc's existing chunks before writing.
      const removed = await deleteChunksForDoc(namespace, docId);

      // 6) Write chunks with a proper VectorValue + metadata.
      let written = 0;
      for (let i = 0; i < pieces.length; i += WRITE_BATCH_LIMIT) {
        const batch = db.batch();
        const sliceEnd = Math.min(i + WRITE_BATCH_LIMIT, pieces.length);
        for (let j = i; j < sliceEnd; j++) {
          const ref = chunksCol.doc(`${docId}_${j}`);
          batch.set(ref, {
            text: pieces[j],
            embedding: FieldValue.vector(vectors[j]),
            metadata: {
              namespace,
              docId,
              sourcePath: storagePath,
              chunkIndex: j,
            },
            docId, // top-level too, for cheap equality filters / cleanup
            chunkIndex: j,
            createdAt: FieldValue.serverTimestamp(),
          });
          written++;
        }
        await batch.commit();
      }

      // 8) Status record.
      await docRef.set(
        {
          status: 'done',
          chunks: written,
          pages,
          filename,
          sourcePath: storagePath,
          embedModel: EMBED_MODEL,
          embedDimensions: vectors[0]?.length ?? EMBED_DIMENSIONS,
          replacedChunks: removed,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      logger.info('ingestDocument done', { namespace, docId, chunks: written, removed });
      return { docId, chunks: written, status: 'done' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('ingestDocument failed', { namespace, docId, storagePath, error: message });
      return await fail(docRef, docId, message);
    }
  },
);

/** Delete all chunks for a doc (batched). Returns the count removed. */
async function deleteChunksForDoc(namespace: string, docId: string): Promise<number> {
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  let total = 0;
  // Loop until no more match (handles >500 chunks safely).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await chunksCol.where('docId', '==', docId).limit(WRITE_BATCH_LIMIT).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < WRITE_BATCH_LIMIT) break;
  }
  return total;
}

async function fail(
  docRef: FirebaseFirestore.DocumentReference,
  docId: string,
  message: string,
): Promise<IngestResponse> {
  try {
    await docRef.set(
      { status: 'error', error: message, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } catch {
    /* best-effort status write */
  }
  return { docId, chunks: 0, status: 'error', message };
}

function errorResult(docId: string, message: string): IngestResponse {
  logger.warn('ingestDocument bad request', { docId, message });
  return { docId, chunks: 0, status: 'error', message };
}
