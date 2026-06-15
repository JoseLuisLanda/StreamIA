/**
 * RAG Admin contract (client side).
 *
 * Content is organized by NAMESPACE. Firestore layout used by this panel:
 *   rag_namespaces/{namespace}              - namespace registry (listable)
 *   rag/{namespace}/documents/{docId}       - uploaded-PDF metadata + ingest status
 *   rag/{namespace}/chunks/{chunkId}        - chunks+vectors written by the Function
 *   rag/{namespace}/media/{mediaId}         - media metadata for Text-Avatar popups
 *
 * Storage layout:
 *   rag-docs/{namespace}/{filename}.pdf     - uploaded source PDFs (admin write)
 *   rag-media/{namespace}/{file}            - media assets (admin write)
 *
 * The client only uploads bytes + writes metadata + orchestrates. Extraction,
 * chunking, embedding and vector writes happen in the ingestDocument Function.
 */

/** Namespace registry record. */
export interface RagNamespace {
  /** namespace id, also the Firestore segment (e.g. 'grabovoi', 'ia', 'terapia') */
  id: string;
  /** human label (defaults to id) */
  name?: string;
  /** epoch ms */
  createdAt?: number;
  /** denormalized counters (best-effort, may lag) */
  documentCount?: number;
  chunkCount?: number;
}

export type IngestionStatus = 'not-ingested' | 'processing' | 'done' | 'error';

/** Uploaded-document metadata record (rag/{ns}/documents/{docId}). */
export interface RagDocument {
  /** Firestore doc id (also passed to the Function as docId for re-processing) */
  id: string;
  namespace: string;
  filename: string;
  /** Storage object path to the uploaded PDF */
  storagePath: string;
  /** bytes */
  size: number;
  /** epoch ms */
  uploadedAt: number;
  status: IngestionStatus;
  /** number of chunks produced by the last successful ingest */
  chunks?: number;
  /** last error message (when status === 'error') */
  error?: string;
  /** epoch ms of last ingest attempt */
  ingestedAt?: number;
  contentType?: string;
}

/** Read-only chunk view (rag/{ns}/chunks/{chunkId}). Shape is tolerant: the
 *  Function owns the canonical schema; we only read common fields for display. */
export interface RagChunk {
  id: string;
  /** chunk text (field name tolerated: text | content | chunk) */
  text: string;
  /** owning document id, if the Function stamps it */
  docId?: string;
  /** ordinal within the document, if present */
  index?: number;
  /** arbitrary metadata bag */
  metadata?: Record<string, any>;
  /** whether an embedding/vector is present on the record */
  hasVector?: boolean;
}

export type MediaType = 'image' | 'video';

/**
 * Media metadata record (rag/{ns}/media/{mediaId}).
 *
 * MUST align with the Text-Avatar popup gallery shape (lib/rag/rag.models.ts ->
 * MediaItem): { id, type, title, caption?, storagePath, thumbnailPath? }. We add
 * namespace + linkedDocId for management; the RAG Function projects the MediaItem
 * subset into its responses. Bytes are fetched from Storage by the client on open.
 */
export interface RagMediaRecord {
  id: string;
  type: MediaType;
  title: string;
  caption?: string;
  /** Storage object path to the full asset */
  storagePath: string;
  /** Storage object path to a small thumbnail (optional) */
  thumbnailPath?: string;
  namespace: string;
  /** optional association to a source document */
  linkedDocId?: string;
  createdAt?: number;
}

/** ingestDocument callable request (built to the separately-implemented Function). */
export interface IngestDocumentRequest {
  namespace: string;
  /** Storage path to the uploaded PDF */
  storagePath: string;
  /** optional, for re-processing an existing document record */
  docId?: string;
  options?: { chunkSize?: number; overlap?: number };
}

/** ingestDocument callable response. */
export interface IngestDocumentResponse {
  docId: string;
  chunks: number;
  status: 'done' | 'error';
  message?: string;
}

/** Upload progress callback payload. */
export interface UploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  /** 0..100 */
  percent: number;
}

/** A page of chunks plus an opaque cursor for the next page. */
export interface ChunkPage {
  chunks: RagChunk[];
  /** pass back as `cursor` to fetch the next page; null = no more */
  nextCursor: unknown | null;
}
