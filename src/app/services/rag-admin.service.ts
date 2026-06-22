import { Injectable, signal } from '@angular/core';
import {
  QueryDocumentSnapshot,
  collection,
  deleteDoc,
  doc,
  documentId,
  getCountFromServer,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { deleteObject, ref, uploadBytesResumable } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import {
  getFirebaseFirestoreClient,
  getFirebaseFunctionsClient,
  getFirebaseStorageClient,
} from './firebase-client';
import {
  ChunkPage,
  ChunkStrategy,
  IngestDocumentRequest,
  IngestDocumentResponse,
  MediaType,
  RagChunk,
  RagDocument,
  RagMediaRecord,
  RagNamespace,
  UploadProgress,
} from '../lib/rag/rag-admin.models';

/**
 * Client transport + orchestration for the RAG Admin panel. Pure metadata +
 * Storage uploads + a single callable; NO embedding keys or vectorization here.
 *
 * Firestore layout (see rag-admin.models.ts):
 *   rag_namespaces/{ns}, rag/{ns}/documents/{id}, rag/{ns}/chunks/{id},
 *   rag/{ns}/media/{id}.
 */
@Injectable({ providedIn: 'root' })
export class RagAdminService {
  /** last operation error, for a shared banner */
  readonly error = signal<string>('');

  private db() {
    return getFirebaseFirestoreClient();
  }

  // ----------------------------------------------------------- namespaces

  /**
   * List namespaces via the admin callable `listNamespaces`. The server returns a
   * live documentCount per namespace (count of rag/{ns}/documents) so the UI can
   * disable delete on non-empty namespaces.
   */
  async listNamespaces(): Promise<RagNamespace[]> {
    const callable = httpsCallable<unknown, { namespaces: Array<{ id: string; name: string; createdAt?: number; documentCount: number }> }>(
      getFirebaseFunctionsClient(),
      'listNamespaces',
    );
    const res = await callable({});
    return (res.data?.namespaces ?? []).map((n) => ({
      id: n.id,
      name: n.name ?? n.id,
      createdAt: n.createdAt,
      documentCount: n.documentCount,
    }));
  }

  /**
   * Create a namespace via the admin callable `createNamespace`. The server
   * validates the id (lowercase [a-z0-9_-], non-empty, unique) and rejects with a
   * clear error otherwise. The display name equals the id.
   */
  async createNamespace(id: string): Promise<RagNamespace> {
    const callable = httpsCallable<{ name: string }, { ok: true; id: string; name: string }>(
      getFirebaseFunctionsClient(),
      'createNamespace',
    );
    const res = await callable({ name: id });
    return { id: res.data.id, name: res.data.name, createdAt: Date.now(), documentCount: 0 };
  }

  /**
   * Delete an EMPTY namespace via the admin callable `deleteNamespace`. The server
   * rejects (failed-precondition) if documents/chunks/media are not all empty.
   */
  async deleteNamespace(id: string): Promise<void> {
    const callable = httpsCallable<{ name: string }, { ok: true; id: string }>(
      getFirebaseFunctionsClient(),
      'deleteNamespace',
    );
    await callable({ name: id });
  }

  // ------------------------------------------------------------ documents

  async listDocuments(namespace: string): Promise<RagDocument[]> {
    const col = collection(this.db(), 'rag', namespace, 'documents');
    const snap = await getDocs(query(col, orderBy('uploadedAt', 'desc')));
    return snap.docs.map((d) => this.toDocument(namespace, d.id, d.data()));
  }

  /**
   * Upload a PDF to Storage with progress, then write its metadata record
   * (status 'not-ingested'). Returns the new RagDocument.
   */
  async uploadPdf(
    namespace: string,
    file: File,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<RagDocument> {
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      throw new Error('Only PDF files are supported in phase one.');
    }
    const id = doc(collection(this.db(), 'rag', namespace, 'documents')).id;
    const safe = this.sanitizeFilename(file.name);
    const storagePath = `rag-docs/${namespace}/${id}__${safe}`;
    const storageRef = ref(getFirebaseStorageClient(), storagePath);

    await new Promise<void>((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, file, { contentType: 'application/pdf' });
      task.on(
        'state_changed',
        (snap) => {
          const total = snap.totalBytes || file.size || 1;
          onProgress?.({
            bytesTransferred: snap.bytesTransferred,
            totalBytes: total,
            percent: Math.round((snap.bytesTransferred / total) * 100),
          });
        },
        (err) => reject(err),
        () => resolve(),
      );
    });

    const record: Omit<RagDocument, 'id'> = {
      namespace,
      filename: file.name,
      storagePath,
      size: file.size,
      uploadedAt: Date.now(),
      status: 'not-ingested',
      contentType: 'application/pdf',
    };
    await setDoc(doc(this.db(), 'rag', namespace, 'documents', id), {
      ...record,
      uploadedAt: serverTimestamp(),
    });
    return { id, ...record };
  }

  /**
   * Delete a document: removes the Storage object and the metadata record.
   *
   * Chunk cleanup: by default we do a best-effort client-side cascade (deletes
   * chunks whose `docId` matches, in batches). For large documents prefer the
   * Function/server cleanup -- pass cleanupChunks=false and let the
   * ingestDocument/cleanup Function remove `rag/{ns}/chunks` for the doc.
   * Returns the number of chunks deleted client-side.
   */
  async deleteDocument(d: RagDocument, cleanupChunks = true): Promise<number> {
    // Storage (best-effort: ignore "object not found").
    try {
      await deleteObject(ref(getFirebaseStorageClient(), d.storagePath));
    } catch (e: any) {
      if (!String(e?.code ?? '').includes('object-not-found')) throw e;
    }
    let deleted = 0;
    if (cleanupChunks) deleted = await this.deleteChunksForDoc(d.namespace, d.id);
    await deleteDoc(doc(this.db(), 'rag', d.namespace, 'documents', d.id));
    return deleted;
  }

  /** Best-effort batched delete of chunks for a doc. Capped to avoid runaway. */
  private async deleteChunksForDoc(namespace: string, docId: string, cap = 5000): Promise<number> {
    const col = collection(this.db(), 'rag', namespace, 'chunks');
    let total = 0;
    while (total < cap) {
      const snap = await getDocs(query(col, where('docId', '==', docId), limit(300)));
      if (snap.empty) break;
      const batch = writeBatch(this.db());
      snap.docs.forEach((c) => batch.delete(c.ref));
      await batch.commit();
      total += snap.size;
      if (snap.size < 300) break;
    }
    return total;
  }

  // ------------------------------------------------------------- ingestion

  /**
   * Trigger ingestion via the callable `ingestDocument` and reflect the result
   * back into the document record. The ID token is attached automatically by the
   * Functions SDK. Non-blocking by design: callers fire this and update UI from
   * the returned promise / refreshed record.
   */
  async ingest(
    d: RagDocument,
    options?: { chunkSize?: number; overlap?: number },
    strategy: ChunkStrategy = 'auto',
  ): Promise<IngestDocumentResponse> {
    const recordRef = doc(this.db(), 'rag', d.namespace, 'documents', d.id);
    await updateDoc(recordRef, { status: 'processing', error: '' });

    const callable = httpsCallable<IngestDocumentRequest, IngestDocumentResponse>(
      getFirebaseFunctionsClient(),
      'ingestDocument',
    );

    try {
      const res = await callable({
        namespace: d.namespace,
        storagePath: d.storagePath,
        docId: d.id,
        strategy,
        options,
      });
      const data = res.data;
      const status = data.status === 'done' ? 'done' : 'error';
      await updateDoc(recordRef, {
        status,
        chunks: data.chunks ?? 0,
        error: status === 'error' ? data.message ?? 'Ingestion failed.' : '',
        ingestedAt: serverTimestamp(),
      });
      return data;
    } catch (e: any) {
      // Surface the callable's real diagnostics. e.code like 'functions/internal'
      // (often "didn't reach the function": CORS / not-deployed / not public),
      // 'functions/unauthenticated', etc. e.details carries any server payload.
      const code = e?.code ? ` (${e.code})` : '';
      const detail = e?.details
        ? `: ${typeof e.details === 'string' ? e.details : JSON.stringify(e.details)}`
        : '';
      const message = `${e?.message ?? String(e)}${code}${detail}`;
      await updateDoc(recordRef, { status: 'error', error: message, ingestedAt: serverTimestamp() });
      throw new Error(message);
    }
  }

  // -------------------------------------------------------- chunk inspection

  /**
   * Read a page of chunks (read-only). Ordered by document id for stable
   * pagination regardless of the Function's field schema. Pass the previous
   * page's `nextCursor` to continue. Optionally filter by docId.
   */
  async listChunks(
    namespace: string,
    opts: { pageSize?: number; cursor?: unknown | null; docId?: string } = {},
  ): Promise<ChunkPage> {
    const pageSize = opts.pageSize ?? 25;
    const col = collection(this.db(), 'rag', namespace, 'chunks');
    const clauses: any[] = [];
    if (opts.docId) clauses.push(where('docId', '==', opts.docId));
    clauses.push(orderBy(documentId()));
    if (opts.cursor) clauses.push(startAfter(opts.cursor as QueryDocumentSnapshot));
    clauses.push(limit(pageSize));

    const snap = await getDocs(query(col, ...clauses));
    const chunks: RagChunk[] = snap.docs.map((c) => this.toChunk(c.id, c.data()));
    const nextCursor = snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1] : null;
    return { chunks, nextCursor };
  }

  /** Best-effort total chunk count for a namespace (server aggregation). */
  async countChunks(namespace: string, docId?: string): Promise<number> {
    const col = collection(this.db(), 'rag', namespace, 'chunks');
    const q = docId ? query(col, where('docId', '==', docId)) : query(col);
    const snap = await getCountFromServer(q);
    return snap.data().count;
  }

  // ----------------------------------------------------------------- media

  async listMedia(namespace: string): Promise<RagMediaRecord[]> {
    const col = collection(this.db(), 'rag', namespace, 'media');
    const snap = await getDocs(query(col, orderBy('createdAt', 'desc')));
    return snap.docs.map((d) => this.toMedia(namespace, d.id, d.data()));
  }

  /** Media attached to a specific document (the PDF), sorted by order. */
  async listMediaByDoc(namespace: string, docId: string): Promise<RagMediaRecord[]> {
    const col = collection(this.db(), 'rag', namespace, 'media');
    const snap = await getDocs(query(col, where('linkedDocId', '==', docId)));
    return snap.docs
      .map((d) => this.toMedia(namespace, d.id, d.data()))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  private toMedia(namespace: string, id: string, data: any): RagMediaRecord {
    return {
      id,
      type: (data.type as MediaType) ?? 'image',
      title: data.title ?? id,
      caption: data.caption,
      description: data.description,
      storagePath: data.storagePath ?? '',
      thumbnailPath: data.thumbnailPath,
      namespace,
      linkedDocId: data.linkedDocId,
      order: typeof data.order === 'number' ? data.order : undefined,
      enabled: data.enabled !== false,
      createdAt: this.toMs(data.createdAt),
    };
  }

  /**
   * Upload a media asset (+ optional thumbnail) to Storage and create its
   * metadata record matching the Text-Avatar MediaItem shape.
   */
  async uploadMedia(
    namespace: string,
    file: File,
    meta: { type: MediaType; title: string; caption?: string; description?: string; linkedDocId?: string; order?: number },
    thumbnail?: File,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<RagMediaRecord> {
    const id = doc(collection(this.db(), 'rag', namespace, 'media')).id;
    // Doc-scoped storage path: rag-media/{namespace}/{docId}/{file} when linked.
    const folder = meta.linkedDocId ? `${namespace}/${meta.linkedDocId}` : namespace;
    const storagePath = `rag-media/${folder}/${id}__${this.sanitizeFilename(file.name)}`;
    await this.uploadResumable(storagePath, file, onProgress);

    let thumbnailPath: string | undefined;
    if (thumbnail) {
      thumbnailPath = `rag-media/${folder}/${id}__thumb__${this.sanitizeFilename(thumbnail.name)}`;
      await this.uploadResumable(thumbnailPath, thumbnail);
    }

    // caption maps to description (used by the LLM + as the preview caption).
    const description = meta.description?.trim() || meta.caption?.trim() || '';
    const record: RagMediaRecord = {
      id,
      type: meta.type,
      title: meta.title?.trim() || file.name,
      caption: description,
      description,
      storagePath,
      thumbnailPath,
      namespace,
      linkedDocId: meta.linkedDocId || undefined,
      order: meta.order ?? 0,
      enabled: true,
      createdAt: Date.now(),
    };
    try {
      // stripUndefined: Firestore rejects `undefined` (e.g. absent thumbnailPath /
      // linkedDocId). Omit undefined keys rather than writing them.
      await setDoc(
        doc(this.db(), 'rag', namespace, 'media', id),
        stripUndefined({ ...record, createdAt: serverTimestamp() }),
      );
    } catch (e: any) {
      // Save failed AFTER the bytes uploaded -> clean up the orphaned objects.
      for (const p of [storagePath, thumbnailPath].filter(Boolean) as string[]) {
        try { await deleteObject(ref(getFirebaseStorageClient(), p)); } catch { /* best-effort */ }
      }
      throw new Error(`No se pudo guardar el registro de media: ${e?.message ?? String(e)}`);
    }
    return record;
  }

  /** Edit mutable media fields (no re-upload). */
  async updateMedia(
    namespace: string,
    id: string,
    patch: Partial<Pick<RagMediaRecord, 'title' | 'caption' | 'description' | 'type' | 'linkedDocId' | 'order' | 'enabled'>>,
  ): Promise<void> {
    await updateDoc(doc(this.db(), 'rag', namespace, 'media', id), stripUndefined({ ...patch }));
  }

  async deleteMedia(m: RagMediaRecord): Promise<void> {
    for (const path of [m.storagePath, m.thumbnailPath].filter(Boolean) as string[]) {
      try {
        await deleteObject(ref(getFirebaseStorageClient(), path));
      } catch (e: any) {
        if (!String(e?.code ?? '').includes('object-not-found')) throw e;
      }
    }
    await deleteDoc(doc(this.db(), 'rag', m.namespace, 'media', m.id));
  }

  // ----------------------------------------------------------------- helpers

  private uploadResumable(
    storagePath: string,
    file: File,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<void> {
    const storageRef = ref(getFirebaseStorageClient(), storagePath);
    return new Promise<void>((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, file, {
        contentType: file.type || 'application/octet-stream',
      });
      task.on(
        'state_changed',
        (snap) => {
          const total = snap.totalBytes || file.size || 1;
          onProgress?.({
            bytesTransferred: snap.bytesTransferred,
            totalBytes: total,
            percent: Math.round((snap.bytesTransferred / total) * 100),
          });
        },
        (err) => reject(err),
        () => resolve(),
      );
    });
  }

  private toDocument(namespace: string, id: string, data: any): RagDocument {
    return {
      id,
      namespace,
      filename: data.filename ?? id,
      storagePath: data.storagePath ?? '',
      size: Number(data.size ?? 0),
      uploadedAt: this.toMs(data.uploadedAt) ?? 0,
      status: (data.status as RagDocument['status']) ?? 'not-ingested',
      chunks: data.chunks,
      error: data.error || undefined,
      ingestedAt: this.toMs(data.ingestedAt),
      contentType: data.contentType,
      chunkStrategy: data.chunkStrategy || undefined,
      chunkStrategyDetected: data.chunkStrategyDetected || undefined,
      maxChunkTokens: typeof data.maxChunkTokens === 'number' ? data.maxChunkTokens : undefined,
    };
  }

  private toChunk(id: string, data: any): RagChunk {
    const text = data.text ?? data.content ?? data.chunk ?? data.pageContent ?? '';
    return {
      id,
      text: typeof text === 'string' ? text : JSON.stringify(text),
      docId: data.docId ?? data.documentId,
      index: data.index ?? data.order ?? data.chunkIndex,
      metadata: data.metadata ?? undefined,
      hasVector: !!(data.embedding || data.vector || data.values),
    };
  }

  /** Firestore Timestamp | number | undefined -> epoch ms | undefined. */
  private toMs(v: any): number | undefined {
    if (v == null) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v?.toMillis === 'function') return v.toMillis();
    if (typeof v?.seconds === 'number') return v.seconds * 1000;
    return undefined;
  }

  private sanitizeId(value: string): string {
    return (value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '');
  }

  private sanitizeFilename(value: string): string {
    return (value || 'file')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '');
  }
}

/**
 * Remove keys whose value is `undefined` from a Firestore write payload.
 * Firestore rejects `undefined` ("Unsupported field value"); omit such keys so
 * an empty optional field (caption/thumbnailPath/linkedDocId/order/...) never
 * breaks the write. `null` and '' are valid and kept.
 */
function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out as Partial<T>;
}
