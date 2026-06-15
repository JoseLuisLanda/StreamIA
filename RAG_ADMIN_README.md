# RAG Admin Panel

Admin-only module for managing RAG content: namespaces, PDF upload + ingestion,
read-only chunk inspection, and media association for the Text-Avatar popups.

Same client/server split as the rest of the solution: the **client** does UI,
uploads, metadata writes, and orchestration; the **Cloud Function**
(`ingestDocument`, implemented separately) does text extraction, chunking,
embedding, and vector writes. The client never holds embedding API keys.

Route: `/rag-admin` (lazy, `adminGuard`). Phase one: **PDF only**, ingestion
triggered by a manual admin button.

---

## What was added (client)

| File | Purpose |
|------|---------|
| `src/app/services/admin.service.ts` | Admin check: `role=='admin'` claim OR `admins/{uid}` allowlist (UX gate only). |
| `src/app/guards/admin.guard.ts` | Route guard; redirects non-admins (login if signed out, home if not admin). |
| `src/app/lib/rag/rag-admin.models.ts` | Types: `RagNamespace`, `RagDocument`, `RagChunk`, `RagMediaRecord`, `IngestDocumentRequest/Response`, etc. |
| `src/app/services/rag-admin.service.ts` | Namespaces, PDF upload (resumable, progress), document list, `ingestDocument` callable, paginated chunk reads, media CRUD. |
| `src/app/pages/rag-admin/rag-admin.component.ts` | Shell: namespace sidebar + Documents/Chunks/Media tabs. |
| `src/app/pages/rag-admin/components/rag-chunk-list.component.ts` | Read-only, cursor-paginated chunk inspector. |
| `src/app/pages/rag-admin/components/rag-media-manager.component.ts` | Media upload + metadata CRUD (matches Text-Avatar `MediaItem`). |
| `src/app/services/firebase-client.ts` | *(extended)* `getFirebaseFirestoreClient()`, `getFirebaseFunctionsClient()`. |
| `src/app/app.routes.ts` | *(extended)* `/rag-admin` route behind `adminGuard`. |
| `firestore.rules`, `storage.rules` | *(extended)* admin-scoped rules (REVIEW before deploy). |

Nothing in Text-Avatar, Gesture Studio, gesture/avatar catalogs, or the
lead/main/tail playback was modified. This is purely additive.

---

## Data model

Firestore:

```
rag_namespaces/{namespace}            registry (listable): { name, createdAt }
rag/{namespace}/documents/{docId}     PDF metadata + ingest status
rag/{namespace}/chunks/{chunkId}      chunks + vectors (written by the Function)
rag/{namespace}/media/{mediaId}       popup media metadata
admins/{uid}                          optional admin allowlist
```

Storage:

```
rag-docs/{namespace}/{docId}__{filename}.pdf   source PDFs (admin only)
rag-media/{namespace}/{mediaId}__{file}         media assets (admin write)
```

> Listing namespaces: Firestore cannot list implicit subcollection parents, so a
> namespace is registered as a doc in `rag_namespaces`. **Existing namespaces**
> (`grabovoi`, `ia`, `terapia`) won't appear until registered. The "Add" box is
> idempotent (`setDoc merge`), so typing an existing id just registers it — its
> chunks are untouched.

Media records use the **same shape the Text-Avatar popup gallery consumes**
(`lib/rag/rag.models.ts` -> `MediaItem`: `id, type, title, caption?,
storagePath, thumbnailPath?`), plus `namespace`/`linkedDocId` for management. The
RAG Function should project the `MediaItem` subset into its responses; the public
client fetches bytes from Storage on open (metadata only over the wire).

---

## The `ingestDocument` callable (client built to this contract)

```ts
// request
ingestDocument({
  namespace: string,
  storagePath: string,        // path to the uploaded PDF
  docId?: string,             // present here for re-processing (we always send it)
  options?: { chunkSize?: number; overlap?: number }
})
// response
{ docId: string, chunks: number, status: 'done' | 'error', message?: string }
```

Client flow per document: set the record `status = 'processing'`, call the
callable, then write back `status` (`done`/`error`), `chunks`, and `error`
message. **Non-blocking**: the UI shows a spinner per row and reads status from
Firestore, so you can navigate away and return to see the result.

### Assumptions to align on the Function side

1. **Callable, not HTTPS** — invoked via `firebase/functions` `httpsCallable`,
   region `environment.functionsRegion` (`us-central1`). The Auth ID token is
   attached automatically; verify `context.auth` and enforce admin server-side.
   (We use raw `firebase/functions` rather than `@angular/fire/functions`
   because `@angular/fire` is not wired in this app — the SDK attaches the token
   either way. Easy to swap if you add `@angular/fire` providers.)
2. **Function name** is exactly `ingestDocument`, deployed in the consolidated
   project / region above.
3. **It reads the PDF** from `storagePath` via the Admin SDK (bypasses Storage
   rules) and **writes** `rag/{namespace}/chunks/*`. Recommended to stamp each
   chunk with `docId`, an `index`, the chunk `text` (or `content`), and the
   embedding under `embedding`/`vector` — the inspector reads those field names.
4. **Re-processing**: when `docId` is supplied it should replace that document's
   existing chunks (delete-then-write) so chunk counts stay correct.
5. **Response `chunks`** is the count written; the client displays it and stores
   it on the document record.
6. **Cleanup on delete** (see below) is ideally a Function/trigger too.

---

## Delete + chunk cleanup

Deleting a document removes the Storage PDF and the `documents/{docId}` record,
and does a **best-effort client-side cascade** of `chunks` where `docId` matches
(batched, capped at 5000). For large documents, prefer a server cleanup: pass
`cleanupChunks=false` and have a Function (or an `onDelete` Firestore trigger on
`documents/{docId}`) remove the chunks. Client cascade requires admin write on
`rag/{ns}/chunks` (granted by the rules below).

---

## Access control + security rules (REVIEW before deploy)

The panel is gated client-side by `adminGuard` + `AdminService`, but **real
enforcement is in the rules and the callable**. Admin = `role == 'admin'` custom
claim OR an `admins/{uid}` doc.

`firestore.rules` (added): `isAdmin()` now checks the claim **or** an
`admins/{uid}` doc; admin-scoped writes on `rag_namespaces/**` and
`rag/{namespace}/**`; signed-in read; `admins/{uid}` is self-readable only,
writes managed out-of-band (console / Admin SDK).

`storage.rules` (added): `rag-docs/{namespace}/**` admin read+write.

> **Storage caveat:** Storage rules use the **custom claim only** (no Firestore
> allowlist lookup across services), so an allowlist-only admin can manage
> Firestore metadata but **cannot upload PDFs/media** until granted the
> `role == 'admin'` claim. Grant the claim for full admin. Set it with the Admin
> SDK: `admin.auth().setCustomUserClaims(uid, { role: 'admin' })`.

```bash
firebase deploy --only firestore:rules,storage
```

These are intentionally not permissive — review for your tenancy first.

---

## Consolidated project + environment

This module assumes a **single consolidated Firebase project** (Storage +
Firestore + Auth + Functions). The app initializes one Firebase app from
`src/app/firebase.config.ts` and every admin call uses it.

`src/environments/environment.ts`:

```ts
functionsRegion: 'us-central1',   // region of ingestDocument
ragMediaBucket: 'gs://...'        // for full consolidation set to '' to use the
                                  // default app bucket (no cross-project hop)
```

To finish consolidation: point `firebase.config.ts` at the consolidated project,
set `ragMediaBucket: ''` so Text-Avatar media also resolves from the default
bucket, and deploy `ingestDocument` + the rules into that project.

---

## Existing functionality preserved

Text-Avatar public flow, Gesture Studio, gesture catalog/cache, avatar catalog,
and lead/main/tail playback are untouched. New code is isolated under
`pages/rag-admin/**`, `services/{admin,rag-admin}.service.ts`,
`guards/admin.guard.ts`, and `lib/rag/rag-admin.models.ts`, plus additive
exports in `firebase-client.ts` and one new route.

## Known limitations (phase one)

- PDF only; other types rejected client-side.
- Ingestion is a manual per-document button (no batch / auto-trigger yet).
- Chunk inspector orders by document id for stable pagination; it does not yet
  support full-text search within chunks.
- Client chunk-cleanup on delete is best-effort/capped — large docs should use a
  server-side cascade.
- Build note: the in-repo `node_modules` was installed on Windows; run `npm ci`
  on your platform, then `ng build` / `ng serve` to verify.
