# Cloud Functions + Project Consolidation (strimearia)

This delivers the `ingestDocument` callable (PDF -> extract -> chunk -> embed ->
Firestore VectorValue) and consolidates all Firebase config onto **strimearia**,
reverting the earlier cross-project (terapia-4bb02) setup.

---

## LATEST PASS: chatRag rewrite + dev-phase no-role gating

### `chatRag` (rewritten from scratch) -- `functions/src/chatRag.ts` + `api.ts`

Body-only RAG for the informational avatar. Mounted on the HTTP `api` Express
router at `POST /chatRag`:
`https://us-central1-strimearia.cloudfunctions.net/api/chatRag`.

- **Auth:** `validateFirebaseIdToken` (Bearer ID token). Signed-in users only,
  **no role to answer**. Token is implicitly scoped to strimearia (the Admin SDK
  `verifyIdToken` rejects other-project tokens).
- **Request:** `{ query, namespace?, deploymentId?, language?='es', k?=6 }`.
  Namespace resolves from `namespace`, else `deployments/{deploymentId}.ragCollection`;
  **400 if neither** (no hardcoded `terapia`). `k` clamped to 8.
- **Retrieval:** per-namespace `rag/{namespace}/chunks.findNearest({ vectorField:
  'embedding', queryVector, limit:k, distanceMeasure:'COSINE' })` (admin >= 12.2).
  No `collectionGroup`/`where('metadata.namespace')`, so no extra composite index.
  Sanity: 0 hits + non-empty collection -> **503**; empty collection -> **404**.
- **Generation:** `lib/llm.ts generateAnswer` (Vertex Gemini) -- body only, no
  greeting/closing/CTA, no inline `[n]` citations, answers strictly from context.
- **Gesture tags:** `lib/gestures.ts annotateGestures` adds conservative inline
  tags (`[thinking]`, `[surprise]`, `[laugh]`) -> `gestureCommands`. Rule-based
  (tradeoff: deterministic but generic; or have the LLM emit tags and skip it).
  Fails soft to the plain body.
- **Media:** metadata only from `rag/{namespace}/media` for ids referenced in
  matched chunks' `metadata.mediaIds` -> `{id,type,title,caption?,storagePath,
  thumbnailPath?}`; `[]` on none/err. No signed/public URLs.
- **Response:** `{ body, gestureCommands, media[], sources[] }`. Fail-soft:
  gesture/media errors still return a valid `body`; only auth/validation and a
  generation failure hard-fail (400/401/404/503/500, no internal leakage).
- **Removed vs the old chatRag:** preview/premium gating
  (`canPreview`/`assertPremium`/`markPreviewConsumed`), `users/{uid}/chat_history`
  writes, greeting/closing + inline `[1]` citations, and the `rag/terapia`
  default. (The old code lived in the separate repo; this is a clean rewrite in
  the consolidated `functions/`.)

### aiClient helpers: reused vs replaced

- `embedText` (`lib/embeddings.ts`): **shared** by `ingestDocument` (task_type
  `RETRIEVAL_DOCUMENT`) and `chatRag` (`RETRIEVAL_QUERY`) -- same model
  (`text-embedding-004`) + dimension (**768**), so ingest/query/index stay
  compatible.
- `generateAnswer` (`lib/llm.ts`): **NEW** here -- there was no prior generation
  helper in this consolidated package. If your old chatRag repo had an
  `aiClient`/`generateAnswer`, replace the body of `lib/llm.ts generateAnswer`
  (and optionally `embedText`) with calls to it for exact parity.

> **Embedding dimension must match across ingest + query + index.** All three use
> `text-embedding-004` = 768. If you change `EMBED_MODEL`, also change
> `EMBED_DIMENSIONS` and recreate the vector index with the new dimension.

### Dev-phase no-role gating -- single flag `ENFORCE_ADMIN_ROLE` / `enforceAdminRole`

Role logic is **kept, not deleted** -- just conditional. Default **false** (dev).

| Surface | flag = false (DEV, now) | flag = true (PROD) |
|---|---|---|
| `chatRag` | signed-in only (never checks a role) | unchanged (still no role to answer) |
| `ingestDocument` | **always** requires auth; any signed-in user may ingest | restores `assertAdmin` (claim / `admins/{uid}`) |
| client `adminGuard` | any signed-in user (redirect to /login if signed out) | admin-only (AdminService check) |
| Firestore/Storage rules | authenticated read/write on rag paths | admin-claim write (commented "PROD" blocks) |

Set the Functions flag: `functions/.env` -> `ENFORCE_ADMIN_ROLE=true`, or deploy
with `--set-env-vars ENFORCE_ADMIN_ROLE=true`. Set the client flag:
`environment.ts`/`environment.prod.ts` -> `enforceAdminRole: true`.

**Before production, flip BOTH flags to true AND restore the commented PROD rule
blocks** in `firestore.rules` + `storage.rules`. This also re-instates the
admin-claim Storage requirement (the earlier "claim-only" caveat is moot in dev,
since signed-in users can upload).

> Invariants confirmed: nothing is unauthenticated (every path requires
> sign-in), nothing is fully public (`if true`) for RAG paths, and the embedding
> dimension matches across ingest/query/index.

---

## 0. Cross-project audit + what changed

### Audit (what was found in THIS repo)

This is the **client** repo; the Functions/chatRag live in a separate codebase.
Cross-project configuration found here was limited to the Angular client:

| Location | Before | Cross-project? |
|---|---|---|
| `.firebaserc` default | `strimearia` | No (already correct) |
| `firebase.json` | hosting + rules, no functions | No |
| `src/app/firebase.config.ts` | `strimearia` web config | No (already correct) |
| `src/environments/environment.ts` `ragApiBase` | `https://us-central1-terapia-4bb02.cloudfunctions.net/api` | **Yes** |
| `src/environments/environment.ts` `ragMediaBucket` | `gs://terapia-4bb02.firebasestorage.app` | **Yes** |
| `src/environments/environment.prod.ts` | same two fields | **Yes** |
| service-account keys / `databaseURL` / IAM bindings | none in this repo | n/a (live in the Functions repo) |

### Changed (in this repo)

- `environment.ts` / `environment.prod.ts`:
  - `ragApiBase` -> `https://us-central1-strimearia.cloudfunctions.net/api`
  - `ragMediaBucket` -> `''` (use the default **strimearia** app bucket via
    `getStorage(app)` -- no cross-project hop, no token-audience mismatch)
  - `functionsRegion` -> `us-central1`
- `rag-avatar.service.ts`: updated the doc comment (behavior already falls back to
  the default bucket when `ragMediaBucket === ''`).
- `firebase.json`: added a `functions` codebase (source `functions/`, nodejs20,
  predeploy build) so `firebase deploy --only functions` targets strimearia.
- New `functions/` package (below), Admin SDK initialized with **default
  credentials** (no service-account key) + `storageBucket =
  strimearia.firebasestorage.app`.

### Needs YOUR review (separate Functions repo -- not in this repo)

Audit and remove these in the chatRag/Functions codebase before/after migration:

1. `initializeApp({ credential: cert(<terapia-4bb02 service account>) , ... })`
   -> replace with `initializeApp()` (default creds when running in strimearia).
2. Any `databaseURL` / `storageBucket` pointing at `terapia-4bb02` -> strimearia.
3. `GOOGLE_APPLICATION_CREDENTIALS` / mounted key files for terapia-4bb02 ->
   remove.
4. IAM bindings that granted the strimearia client/SA access to terapia-4bb02
   (Storage Object Viewer, Token Creator, etc.) -> remove once nothing uses them.
5. `chatRag` retrieval: must read from **strimearia** `rag/{namespace}/chunks`
   (see snippet in section 2) and resolve media from the strimearia bucket. Its
   structured `{ body, gestureCommands, media }` response behavior is unchanged.

> Flagged, not deleted: I can't see the Functions repo from here, so I've listed
> the likely cross-project items rather than removing them blindly.

---

## 1. `ingestDocument` (callable)

`functions/src/ingestDocument.ts`. Region `us-central1`, 540s timeout, 1GiB.

Request / response:

```ts
ingestDocument({ namespace, storagePath, docId?, options?: { chunkSize?, overlap? } })
// -> { docId, chunks, status: 'done'|'error', message? }
```

Pipeline: assert admin (claim `role=='admin'`/`admin==true` OR `admins/{uid}`) ->
download PDF from strimearia Storage -> `pdf-parse` text extraction -> chunk
(~800 "tokens"/words, ~100 overlap, overridable) -> `embedText` (Vertex AI, see
section below) -> write `rag/{namespace}/chunks/{docId}_{i}` with
`embedding: FieldValue.vector(...)` + `metadata { namespace, docId, sourcePath,
chunkIndex }` (and top-level `docId`/`chunkIndex` for cheap filters) -> update the
status record -> return counts. Re-processing (`docId` present) deletes that
doc's existing chunks first. Failures return `{ status:'error', message }` (logged
server-side); only auth failures throw `HttpsError`.

### Path alignment flag (please confirm)

The brief specified the status record at `rag/{namespace}/docs/{docId}`. The
already-shipped Angular admin panel (`RagAdminService`) reads/writes
`rag/{namespace}/documents/{docId}`. **I used `documents`** so the panel shows
status. If you prefer `docs`, change the two `collection('documents')` calls in
`ingestDocument.ts` AND the client's `RagAdminService`/models together.

---

## 2. Vector index (strimearia) + chatRag retrieval

Chunks store `embedding` as a Firestore **VectorValue** (`FieldValue.vector`).
For `findNearest` to work, create a vector index in strimearia. Chunks live in the
`chunks` subcollection under each namespace, so use a **COLLECTION**-scope index
on the `chunks` collection group:

```bash
gcloud firestore indexes composite create \
  --project=strimearia \
  --collection-group=chunks \
  --query-scope=COLLECTION \
  --field-config=field-path=embedding,vector-config='{"dimension":768,"flat":{}}'
```

- `dimension` MUST equal the embedding model's output dim (default
  `text-embedding-004` = **768**). If you use a different model, change both
  `EMBED_DIMENSIONS` and this number.
- `COSINE` is passed at query time (`distanceMeasure`); the index itself is
  dimension + `flat`.
- If chatRag adds an equality filter alongside the vector search (e.g.
  `where('docId','==',...)`), Firestore will prompt for a composite index -- use
  the link in that error, or add a matching `--field-config` for the filtered
  field plus the vector config.
- Don't assume the index exists in strimearia -- create it before first query
  (build can take minutes for existing data).

chatRag retrieval against the new path (firebase-admin >= 12.2):

```ts
import { FieldValue } from 'firebase-admin/firestore';

const queryVec = await embedText([query]);            // SAME model as ingestion
const chunks = db.collection('rag').doc(namespace).collection('chunks');
const snap = await chunks.findNearest({
  vectorField: 'embedding',
  queryVector: FieldValue.vector(queryVec[0]),
  limit: 6,
  distanceMeasure: 'COSINE',
}).get();
const context = snap.docs.map(d => d.get('text')).join('\n---\n');
// media: read associated rag/{namespace}/media records (storagePath only).
```

> `namespace` replaces the old `deploymentId -> ragCollection` lookup if you move
> to per-namespace retrieval; keep whichever scoping chatRag already uses, just
> point it at strimearia `rag/{ns}/chunks`.

---

## Embeddings (model/dimensions must match the index)

`functions/src/lib/embeddings.ts` calls Vertex AI text embeddings via REST with
the runtime's default credentials (no key in code). Env-configurable:
`EMBED_MODEL` (default `text-embedding-004`), `EMBED_DIMENSIONS` (768),
`EMBED_LOCATION` (us-central1).

**If you already have an `embedText`/`aiClient` in the chatRag codebase, replace
the body of `embedText` with a call to it** so ingestion and query embeddings are
byte-for-byte the same model/dimensions -- otherwise `findNearest` results degrade.

---

## 3. Storage layout (strimearia)

- PDFs: `rag-docs/{namespace}/{docId}__{filename}.pdf` (admin panel uploads here;
  the callable reads here).
- Media: `rag-media/{namespace}/{file}` (admin panel uploads; chatRag returns
  `storagePath` metadata; the public client fetches bytes on open).

These match the Angular admin panel and the Text-Avatar popup gallery.

---

## 4. Security rules (review)

Already in this repo (admin-scoped; review before deploy):

- `firestore.rules`: `isAdmin()` = claim `role=='admin'` OR `admins/{uid}`;
  admin write on `rag/**` and `rag_namespaces/**`; signed-in read; `admins/{uid}`
  self-readable only.
- `storage.rules`: admin read+write on `rag-docs/**`; admin write + signed-in
  read on `rag-media/**`.

The callable uses the Admin SDK and bypasses these (they govern the client).

```bash
firebase deploy --only firestore:rules,storage
```

---

## 5. Deploy + client wiring

With `strimearia` as the active project (`firebase use strimearia`):

```bash
cd functions && npm install && npm run build && cd ..
firebase deploy --only functions          # deploys ingestDocument (+ chatRag if consolidated here)
```

- **Callable name:** `ingestDocument` (region us-central1). The Angular client
  calls it by name -- no URL/CORS needed. With `@angular/fire`:
  `httpsCallable(getFunctions(app,'us-central1'), 'ingestDocument')`. (This repo
  currently uses the raw `firebase/functions` `httpsCallable`, which is
  equivalent and already wired in `RagAdminService`.)
- **chatRag (HTTP `api` router):** if it was deployed in terapia-4bb02, redeploy
  it to strimearia. New base URL:
  `https://us-central1-strimearia.cloudfunctions.net/api`
  (already set as `environment.ragApiBase`). Being an HTTP function it still needs
  CORS for the app origin (the callable does not).

> I could not deploy or `npm install`/build from this environment (no GCP creds
> and the npm registry is blocked here). Run the commands above locally; the code
> is written to compile under `functions/tsconfig.json` (CommonJS, nodejs20).
```
