# Project Context (for an AI agent)

## What this is
A **web app for AR/VR + AI avatars**. Core product: a 3D talking avatar ("Text-Avatar")
that answers questions from a knowledge base (RAG) and performs lip-sync + gestures
while speaking. It also includes AR face-tracking experiments, a gesture authoring
studio, and an admin panel to manage the RAG knowledge base.

Everything runs on a single Firebase project: **`strimearia`** (Auth, Firestore,
Storage, Cloud Functions). An earlier cross-project setup (`terapia-4bb02`) was
fully reverted/consolidated into `strimearia`.

## Tech stack
- **Frontend:** Angular 21 — standalone components, **signals**, **zoneless change
  detection** (`provideZonelessChangeDetection`). Inline templates/styles. Dark/violet theme.
- **3D / AR:** Three.js (GLB avatars, morph targets/blendshapes), MediaPipe
  `@mediapipe/tasks-vision` (face tracking).
- **TTS / lip-sync:** Piper neural voices in-browser via `@diffusionstudio/vits-web`
  (web worker); viseme/timeline-driven mouth blendshapes; ES primary, EN secondary.
- **Backend:** Firebase Cloud Functions (firebase-functions **v2**, Node 20, TypeScript,
  CommonJS) in `functions/`. Vertex AI for embeddings (`text-embedding-004`, **768 dims**)
  and generation (Gemini, `chatRag`). Firestore **vector search** (`findNearest`, COSINE).
- **SDK:** Firebase JS SDK v12 (modular). NOTE: `@angular/fire` is a `0.0.0` placeholder
  and is NOT wired — use the raw `firebase/*` modular SDK.

## Routes (`src/app/app.routes.ts`)
- `/` home, `/login`
- `/live`, `/ar`, `/ar-viewer`, `/ar-face-tracking` — AR/3D experiences (auth-guarded)
- `/text-avatar` — **public-facing** RAG avatar (voice + text chat, lead-in/body/tail playback)
- `/gesture-studio` — admin-only gesture authoring
- `/rag-admin` — admin-only RAG knowledge-base manager (namespaces, PDFs, chunks, media)

## Key client structure
- `src/app/services/` — `rag-avatar.service.ts` (calls `chatRag`), `rag-admin.service.ts`
  (namespaces/docs/ingest/chunks/media), `conversation.service.ts` (turn state machine:
  lead-in gesture → body speech → tail gesture), `tts-lipsync.service.ts`, `gesture-player.service.ts`,
  `auth.service.ts`, `admin.service.ts`, `firebase-client.ts` (app/auth/firestore/functions/storage getters).
- `src/app/lib/rag/` — models + config (`rag.models.ts`, `rag-admin.models.ts`, `rag.config.ts`).
- `src/app/pages/rag-admin/` — `rag-admin.component.ts` (shell + Documents view) +
  `components/rag-chunk-list.component.ts` (read-only paginated chunks) +
  `components/rag-media-manager.component.ts` (media card grid CRUD).
- `src/environments/environment.ts` (+ `.prod.ts`) — `ragApiBase`, `ragChatPath`,
  `ragMediaBucket` (''=default bucket), `functionsRegion`, `enforceAdminRole`.

## Backend (`functions/src/`)
- **`ingestDocument`** (callable): PDF (Storage `rag-docs/{ns}/...`) → extract (`pdf-parse`)
  → chunk (~800 tokens / ~100 overlap) → embed → write `rag/{ns}/chunks/{id}` with
  `embedding: FieldValue.vector(...)` + metadata; updates status at `rag/{ns}/documents/{id}`;
  re-ingest deletes old chunks first; returns `{docId, chunks, status, message?}`.
- **`api`** (HTTP Express, mounts `POST /chatRag`): signed-in only; resolves namespace from
  request or `deployments/{id}.ragCollection`; `findNearest` over `rag/{ns}/chunks`;
  Gemini generates **body-only** answer; adds inline gesture tags (`gestureCommands`);
  returns `{body, gestureCommands, media[], sources[]}`. CORS for app origins.
- Shared `lib/embeddings.ts` (`embedText`) is used by both (same model/dims as the index).

## Firestore / Storage data model
```
rag_namespaces/{ns}                       namespace registry (listable)
rag/{ns}/documents/{docId}                PDF metadata + ingest status/chunk count
rag/{ns}/chunks/{chunkId}                 text + embedding(VectorValue) + metadata
rag/{ns}/media/{mediaId}                  popup media metadata (matches Text-Avatar MediaItem)
deployments/{id}                          avatar + ragCollection + lead/tail gestures
admins/{uid}                              admin allowlist
Storage: rag-docs/{ns}/*.pdf , rag-media/{ns}/* , avatars/*
Vector index: collection-group `chunks`, field `embedding`, dim 768, COSINE
```

## Auth / dev-phase gating
- Single flag **`ENFORCE_ADMIN_ROLE`** (Functions env) / **`enforceAdminRole`** (client env),
  default **false** (dev). Off = any signed-in user may use admin features; on = restores
  admin role (claim `role=='admin'` OR `admins/{uid}`). Must be `true` before production.
- Security rules (`firestore.rules`, `storage.rules`) are currently **dev-permissive but
  authenticated** (never public); the production admin-scoped rules are preserved commented
  with restore notes.

## Current functionality status
- Text-Avatar RAG flow, gesture studio, avatar/gesture catalogs, lip-sync/motion playback: working.
- RAG admin panel: full-height shell + Documents/Chunks/Media views with loading/empty states;
  wired to all services; works from an empty DB (create namespace → upload PDF → ingest → chunks).
- `chatRag` + `ingestDocument`: implemented in `functions/`; **not yet deployed/verified from
  this environment** (see gotchas).

## Gotchas for an agent working here
1. **Cannot build/deploy in the sandbox:** `node_modules` was installed on Windows (wrong-platform
   esbuild/rollup binaries) and the npm registry is blocked. Run `ng build` / `firebase deploy`
   on the user's machine. Run `cd functions && npm install && npm run build` before deploying functions.
2. **The file-write path corrupts non-ASCII** (inserts NUL bytes / truncates lines at multi-byte
   chars). Write source files **ASCII-only** (use `&gt;`/`&middot;` HTML entities, `->` not arrows,
   inline SVG not emoji). Verify after writing: `tr -cd '\000' < file | wc -c` and `grep -cP '[^\x00-\x7F]'`.
3. **Zoneless Angular:** prefer signals/`computed()` over plain methods for reactive template gating.
4. **Embedding dimension must match** across ingest + query + vector index (768 / `text-embedding-004`).
   If you swap the model, update `EMBED_DIMENSIONS` and recreate the index.
5. Keep `chatRag` body-only (no greeting/closing/inline citations); media is metadata-only
   (Storage bytes fetched client-side on open).

## Reference docs in repo
`RAG_AVATAR_README.md`, `RAG_ADMIN_README.md`, `FUNCTIONS_README.md`, `VOICE_PLAN.md`,
`GESTURE_STUDIO_PLAN.md`, `AVATAR_CATALOG_README.md`, `lipsync.md`.
