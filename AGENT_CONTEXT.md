# Project Context (for an AI agent)

> Functionality overview of the whole system. Keep this current when features change.
> Last updated: 2026-06 (Text-Avatar full-screen redesign + media history + Stop/Repeat).

## What this is
A **web app for AR/VR + AI avatars**. Core product: a 3D talking avatar ("Text-Avatar")
that answers questions from a per-assistant knowledge base (RAG) and performs lip-sync +
gestures while speaking. Around that core there is a full **admin suite**: a knowledge-base
manager, an assistant manager, an avatar manager, LLM provider/profile management, role
management, and per-assistant conversational content. It also includes AR face-tracking
experiments and a gesture authoring studio.

Everything runs on a single Firebase project: **`strimearia`** (Auth, Firestore,
Storage, Cloud Functions). An earlier cross-project setup (`terapia-4bb02`) was
fully reverted/consolidated into `strimearia`.

## Tech stack
- **Frontend:** Angular 21 - standalone components, **signals**, **zoneless change
  detection** (`provideZonelessChangeDetection`). Inline templates/styles. Dark/violet theme.
- **3D / AR:** Three.js (GLB avatars, morph targets/blendshapes), MediaPipe
  `@mediapipe/tasks-vision` (face tracking).
- **TTS / lip-sync:** Piper neural voices in-browser via `@diffusionstudio/vits-web`
  (web worker); viseme/timeline-driven mouth blendshapes; ES primary, EN secondary.
  Performance compiler pre-synthesizes audio and builds a viseme/gesture timeline.
- **STT:** Web Speech API (Chrome/Edge) with auto-retry on the implicit ~8s no-speech timeout.
- **Backend:** Firebase Cloud Functions (firebase-functions **v2**, Node 20, TypeScript,
  CommonJS) in `functions/`. Vertex AI for embeddings (`text-embedding-004`, **768 dims**)
  and generation (Gemini, `chatRag`). Firestore **vector search** (`findNearest`, COSINE).
- **Pluggable LLM providers:** ollama / openai / gemini / anthropic / deepseek, configured
  via LLM profiles; provider keys stored server-side in Secret Manager (never client-readable).
- **Client caches:** IndexedDB for avatars (central AvatarService) and conversational content
  (read-through cache); in-memory layer over both.
- **SDK:** Firebase JS SDK v12 (modular). NOTE: `@angular/fire` is a `0.0.0` placeholder
  and is NOT wired - use the raw `firebase/*` modular SDK.

## Routes (`src/app/app.routes.ts`)
Public / user-facing:
- `/` (and `/home`) home, `/login`
- `/assistants` - assistant picker (auth-guarded); launches `/text-avatar?assistant=ID`
- `/text-avatar` - the RAG avatar experience (auth-guarded; voice + text chat)
- `/live`, `/ar`, `/ar-viewer`, `/ar-face-tracking` - AR/3D experiences (auth-guarded)
- `/gesture-studio` - gesture authoring

Admin (guarded by `adminGuard`; honors `enforceAdminRole`):
- `/admin` - Admin Hub (central card menu to all admin tools)
- `/rag-admin` - RAG knowledge-base manager (namespaces, PDFs, chunks, doc-scoped media)
- `/assistant-manager` - create/edit assistants (avatar, voice, namespace, gestures, LLM, content)
- `/avatar-manager` - avatar inventory (GLB upload, Three.js viewer, rig conformance report)
- `/llm-admin` - global LLM profile manager (providers, models, keys via Secret Manager)
- `/llm-responses` - global + per-assistant conversational responses manager
- `/role-admin` - user role management (grant/revoke admin)

## Text-Avatar experience (`src/app/pages/text-avatar/`)
Full-screen-avatar, streamer-style layout. All conversation flow is owned by
`ConversationService` (explicit state machine); the component is a thin view.
- **Full-screen 3D avatar** as the base layer. The canvas is **resized** (camera aspect +
  renderer) via the avatar-tts `ResizeObserver`, never recreated - the cached GLB, WebGL
  context, and avatar state persist across layout changes (e.g. PiP).
- **Floating top bar:** back arrow + assistant name + "Active Instance" status line; an
  admin-only Studio toggle and an admin-only settings gear on the right.
- **Right chat panel** (full-height, glass, text-only): user/assistant bubbles with karaoke
  reveal in sync with speech; fade-in; icon-only content **reload** with hover tooltip showing
  last-updated; "Limpiar" clear.
- **Left "Contenido relacionado" media panel** (compact, glass): scrollable media history
  (one carousel per response that has media), shows newest by default (auto-scrolls to newest),
  scroll up for older; click opens the full-screen image-only carousel viewer; hidden when empty;
  themed scrollbar (transparent track, blue outline).
- **Floating bottom cluster:** "Esperando..." status pill; circular controls (Stop<->Repeat
  toggle, mic, mute); suggested-prompt chips; message input ("Envia un mensaje a {assistant}...").
- **Stop<->Repeat toggle:** while speaking, a Stop button cleanly halts audio + lip-sync and
  returns the avatar to neutral pose (no mid-word freeze); when idle/finished it becomes Repeat
  (replays the last response with voice + gestures).
- **"Ver mas"** (compact green outline, appears only after a message finishes typing and only
  when `detail` exists) opens a text-only full-screen detail overlay with the avatar in PiP.
- **Admin Studio overlay** (hidden by default, opened from the top-bar mask icon): the Response
  Editor (author responses with inline gesture markup, lead-in/tail, LLM-command preview) plus
  the manual "Modo directo" TTS mode.
- **Settings slide-over** (admin gear): LLM provider/model/key, conversation options, voice
  engine + language + voice, avatar catalog picker, and RAG mode/endpoint/assistant controls.

## Conversation flow + content
- **Intent router** (`lib/intent/`): greeting/farewell answered instantly (no RAG); info queries
  go to the assistant namespace; ambiguous utterances fall back to a one-shot LLM classification.
- **Staged playback:** lead-in gesture (covers RAG latency) -> contextual info-ack filler ->
  body speech (TTS + inline gesture motion) -> tail gesture. Keep-alive "thinking" micro-gesture
  loop during generation.
- **Summary + detail split:** `chatRag` returns a short spoken `summary` plus a full `detail`;
  the avatar speaks the summary, "Ver mas" reveals the detail (text-only).
- **Per-assistant conversational content:** greetings, farewells, info-acknowledgements, and
  suggested prompts, with a flag-driven global-vs-custom resolution; IndexedDB read-through cache
  with change detection and a manual sync (the top-of-chat reload icon).

## Key client structure (`src/app/`)
- `services/` - `rag-avatar.service.ts` (calls `chatRag`, normalizes summary/detail/media),
  `rag-admin.service.ts` (namespaces/docs/ingest/chunks/media), `conversation.service.ts`
  (turn state machine), `tts-lipsync.service.ts`, `gesture-player.service.ts`,
  `avatar.service.ts` (central resolve + two-layer cache: mem -> IndexedDB -> Storage),
  `avatar-manager.service.ts`, `avatar-catalog.service.ts`, `assistant-config.service.ts`,
  `conversation-content.service.ts`, `llm.service.ts` (client LLM + intent classify),
  `image-optimization.service.ts` (Canvas WebP + thumbnails), `speech-recognition.service.ts`,
  `auth.service.ts`, `admin.service.ts`, `firebase-client.ts` (app/auth/firestore/functions/storage getters).
- `lib/` - `rag/` (models + config + assistant schema/migration), `intent/` (intent router),
  `lipsync/` (viseme map, speech timeline, text-to-visemes), `performance/` (performance compiler,
  progressive split, plan cache, timing), `gestures/`, `conversation-content/`, `llm-admin/`, `avatars/`.
- `pages/` - one folder per route above (each a standalone component, usually with inline subcomponents).
- `src/environments/environment.ts` (+ `.prod.ts`) - `ragApiBase`, `ragChatPath`,
  `ragMediaBucket` (''=default bucket), `functionsRegion`, `enforceAdminRole`.

## Backend (`functions/src/`)
Exports (see `functions/src/index.ts`):
- **`ingestDocument`** (callable): PDF (Storage `rag-docs/{ns}/...`) -> extract (`pdf-parse`)
  -> chunk (~800 tokens / ~100 overlap) -> embed -> write `rag/{ns}/chunks/{id}` with
  `embedding: FieldValue.vector(...)` + metadata; updates `rag/{ns}/documents/{id}` status;
  re-ingest deletes old chunks first; returns `{docId, chunks, status, message?}`.
- **`api`** (HTTP Express, mounts `POST /chatRag`): signed-in only; resolves namespace from
  request or `assistants/{id}.ragCollection`; `findNearest` over `rag/{ns}/chunks`; resolves the
  assistant's LLM profile + active key (ownership enforced); Gemini/provider generates a
  **summary + detail** answer with inline gesture tags; gathers doc-scoped media by retrieved
  docIds + LLM relevance selection; returns `{summary, detail, body, gestureCommands, media[], sources[]}`.
- **`setLlmApiKey`, `testLlmConnection`** (callable): legacy single-key admin path.
- **`saveLlmProfile`, `deleteLlmProfile`, `setLlmProfileKey`, `setActiveLlmKey`,
  `deleteLlmProfileKey`, `setSystemDefaultProfile`, `testLlmProfile`, `migrateLegacyLlmConfig`**
  (callable): LLM profile lifecycle; keys live in Secret Manager, never in client-readable Firestore.
- **`bootstrapFirstAdmin`, `setUserRole`, `listUsers`** (callable): role management.
- **`generateResponses`** (callable): AI-generate conversational content using an LLM profile.
- **`backfillAssistants`** (callable): schema migration/backfill for assistant docs.
- Shared `lib/embeddings.ts` (`embedText`) is used by ingest + query (same model/dims as the index).

## Firestore / Storage data model
```
rag_namespaces/{ns}                       namespace registry (listable)
rag/{ns}/documents/{docId}                PDF metadata + ingest status/chunk count
rag/{ns}/chunks/{chunkId}                 text + embedding(VectorValue) + metadata
rag/{ns}/media/{mediaId}                  doc-scoped media metadata (Text-Avatar MediaItem)
assistants/{id}                           avatar + ragCollection + voice/lang + lead/tail
                                          gestures + greeting/intent config + LLM profile ref
                                          + conversational content + schemaVersion
  assistants/{id}/...                     per-assistant conversational content (custom)
global_responses/...                      global greetings/farewells/info-acks/prompts
llm_profiles/{id}                         LLM provider profiles (keys NOT here; Secret Manager)
avatars/{id}                              avatar registry (glbPath, defaultVoice, thumbnail)
users/{uid}                               user registry (created on sign-in)
admins/{uid}                              admin allowlist
Storage: rag-docs/{ns}/*.pdf , rag-media/{ns}/* , avatars/models/*
Secret Manager: per-profile LLM API keys
Vector index: collection-group `chunks`, field `embedding`, dim 768, COSINE
```

## Auth / dev-phase gating
- Single flag **`ENFORCE_ADMIN_ROLE`** (Functions env) / **`enforceAdminRole`** (client env).
  Off = any signed-in user may use admin features; on = restores admin role (claim `role=='admin'`
  OR `admins/{uid}`). Must be `true` before production. (An admin claim has been added for the
  primary account; the client `AdminService` checks claim first, then the `admins/{uid}` allowlist.)
- Security rules (`firestore.rules`, `storage.rules`) are currently **dev-permissive but
  authenticated** (never public); production admin-scoped rules are preserved commented with restore notes.

## Current functionality status
- Text-Avatar RAG flow (full-screen redesign, media history panel, Stop/Repeat, summary+detail,
  Ver mas, content sync), gesture studio, avatar/gesture catalogs, lip-sync/motion playback: working.
- Admin suite (Admin Hub, RAG admin, Assistant Manager, Avatar Manager, LLM admin, LLM responses,
  Role admin): implemented and wired to services.
- `chatRag` + `ingestDocument` + the other callables: implemented in `functions/`; deploy/verify
  from the user's machine (see gotchas).

## Gotchas for an agent working here
1. **Cannot build/deploy in the sandbox:** `node_modules` was installed on Windows (wrong-platform
   esbuild/rollup binaries) and the registry is blocked. Run `ng build` / `ng serve` / `firebase deploy`
   on the user's machine. Run `cd functions && npm install && npm run build` before deploying functions.
2. **Sandbox bash mount is stale/odd-encoding:** `tsc`/`cat` over the mount may report bogus
   whole-codebase parse errors. Trust the Read/Grep tools (authoritative). Verify edits there.
3. **The file-write path can corrupt non-ASCII** (NUL bytes / truncation at multi-byte chars).
   Write source files **ASCII-only** (use `->` not arrows, inline SVG not emoji in code). Verify:
   count NUL bytes via python (`open(f,'rb').read().count(b'\x00')`) after writing.
4. **Zoneless Angular:** prefer signals/`computed()` over plain methods for reactive template gating.
5. **Embedding dimension must match** across ingest + query + vector index (768 / `text-embedding-004`).
   If you swap the model, update `EMBED_DIMENSIONS` and recreate the index.
6. **Keep secrets out of git/client:** LLM/service-account keys live in Secret Manager / local env
   only. `serviceAccountKey.json` is git-ignored (rotate it - it was previously committed to history).
7. Collection is **`assistants/{id}`** (renamed from the old `deployments/{id}`).

## Reference docs in repo
`RAG_AVATAR_README.md`, `RAG_ADMIN_README.md`, `FUNCTIONS_README.md`, `ASSISTANT_MANAGER_README.md`,
`AVATAR_MANAGER_README.md`, `AVATAR_SERVICE_README.md`, `AVATAR_CATALOG_README.md`,
`LLM_PROVIDER_ADMIN_README.md`, `LLM_PROFILES_README.md`, `LLM_RESPONSES_README.md`,
`ROLE_ADMIN_README.md`, `CONVERSATION_CONTENT_README.md`, `SUMMARY_DETAIL_README.md`,
`DOC_MEDIA_README.md`, `IMAGE_OPTIMIZATION_README.md`, `SCHEMA_MIGRATION_README.md`,
`TEXT_AVATAR_INTENT_LOGIN_README.md`, `VOICE_PLAN.md`, `GESTURE_STUDIO_PLAN.md`, `lipsync.md`.
