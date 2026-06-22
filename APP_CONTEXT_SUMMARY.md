# App Context Summary (for AI models)

> Purpose: a single, self-contained briefing that gives an AI model (or a new
> developer) the full mental model of this codebase — what the app does, the
> technologies, the RAG pipeline, the avatar/TTS/lipsync stack, the data model,
> security, and the non-obvious engineering decisions. Paste this as context.

---

## 1. What the app is

A **web platform for AR/VR + AI talking avatars**. Its flagship surface is a
**text-driven, RAG-grounded talking avatar** ("Text-Avatar"): the user types or
speaks a question, a Cloud Function answers it from a per-assistant knowledge
base (retrieval-augmented generation), and a 3D avatar **speaks the answer with
synchronized text-to-speech and real-time lip-sync**. The same rendering stack
also supports a camera-based **AR face-tracking** mode.

Assistants are branded personas (e.g. **AlexIA**, **Pastor-IA / Christ-IAN**,
**JosIA**, **MarIA**), each with its own 3D avatar, voice, persona prompt, and
isolated RAG knowledge namespace. Primary language is **Spanish**, secondary
**English**.

It runs entirely on the web (Angular SPA + Firebase). No native app.

---

## 2. Technology stack

**Frontend**
- **Angular 21** (standalone components, **signals / computed / effect**,
  **zoneless** change detection, inline templates+styles, lazy-loaded routes).
- **Three.js 0.182** for 3D rendering; **GLTFLoader** for `.glb` avatars
  (ReadyPlayer Me-style avatars with **ARKit-52 blendshapes / morph targets**).
- **@mediapipe/tasks-vision** (FaceLandmarker / pose) for AR camera face & body
  tracking.
- **@diffusionstudio/vits-web 1.0.3** = **Piper TTS** in the browser
  (onnxruntime-web WASM), run inside a **Web Worker**.
- **RxJS 7.8** (mostly for router observables; app state is signals).
- TypeScript 5.9, Vitest for tests.

**Backend / cloud**
- **Firebase** (project: `strimearia`): Auth, Firestore, Storage, Cloud
  Functions (`firebase` 12.9 client SDK, `firebase-admin` 14 server).
- **Cloud Functions** (Node, `firebase-functions` v2): RAG endpoint, document
  ingestion, LLM admin, role admin, response generation.
- **Google Vertex AI** for **text embeddings** (`text-embedding-004`, 768-dim)
  and **Firestore native vector search** (`findNearest`) for retrieval.
- **LLM generation** via configurable providers: **`gemini-api`** (Google
  Generative Language), **`openai`**, **`deepseek`**. API keys live in **Secret
  Manager**, never in client or Firestore.

**Build note:** uses the **stock `@angular/build:application`** builder. A
postinstall script (`scripts/patch-vits-web.mjs`) patches Piper's dist so it
bundles in the browser/worker (see §10).

---

## 3. Routes / pages (`src/app/app.routes.ts`)

| Path | Purpose | Guard |
|---|---|---|
| `/` , `/home` | Landing | public |
| `/login` | Auth | public |
| `/assistants` | Public assistant selector (kiosk) | public |
| `/text-avatar?assistant=<id>` | **Main talking-avatar experience** | public |
| `/live`, `/ar`, `/ar-viewer`, `/ar-face-tracking` | AR / camera modes | authGuard |
| `/gesture-studio` | Author avatar gestures | (admin) |
| `/admin`, `/rag-admin`, `/avatar-manager`, `/assistant-manager`, `/llm-admin`, `/role-admin`, `/llm-responses` | Admin tooling | (admin) |

---

## 4. Core feature: Text-Avatar (`src/app/pages/text-avatar/`)

Full-screen 3D avatar with floating glassmorphism overlays: status pill, chat
popup, hint-chip carousel (suggested prompts), live subtitles, related-media
panel, mic + settings controls.

Flow: user input (typed or speech) -> **intent router** classifies
greeting / farewell / capabilities / RAG-query -> the RAG fetcher calls the
Cloud Function -> the answer is **spoken** by the TTS+lipsync engine while the
avatar animates, with karaoke-style subtitles. Idle avatar does subtle blinking
+ breathing.

Key subsystems:
- **`ConversationService`** (root singleton, the source of truth): an explicit
  **state machine** (`idle -> listening -> sending -> waiting_llm -> speaking ->
  idle`), holding `messages` (signal), badge counters, and a generation token so
  in-flight turns can be cancelled. `interrupt()` stops everything; `resetSession()`
  wipes state for leave/switch.
- **Cleanup on leave/switch:** navigating back or changing `?assistant=` stops
  TTS, cancels in-flight requests, and resets conversation/media/badges so
  nothing stale carries over. The 3D canvas is never recreated (resize only).
- **Conversation history persistence** (per user, per assistant) — see §8.

---

## 5. Avatar rendering + gestures (`components/avatar-tts/`, `lib/avatars/`)

- Three.js scene loads a `.glb` avatar; the rig is normalized
  (`buildNormalizedRig`) and scored for **ARKit-52 conformance** ("Fully conforms
  — 52/52 ARKit, head bone").
- The avatar is driven by **morph-target (blendshape) weights**, not camera
  input in Text-Avatar mode. Mouth shapes come from **visemes**; gestures (head
  nods, expressions) come from a **gesture library** (`lib/gestures/`) with
  inline markup tags the LLM/timeline can emit.
- A **ResizeObserver** resizes the renderer; the model/scene is reused across
  avatar swaps (GLB swap only).
- Avatars are a reusable catalog in Firestore (`avatars/{id}`) + Storage GLBs.

---

## 6. TTS + lip-sync pipeline (`services/tts-lipsync.service.ts`, `lib/lipsync/`, `lib/performance/`)

- **Providers:** `piper` (default, offline/in-browser) and `webspeech`
  (fallback). Languages `es` / `en`. Voice ids like `es_MX-claude-high`.
- **Piper** runs in a **Web Worker** (`workers/piper.worker.ts`) via
  `@diffusionstudio/vits-web` -> onnxruntime-web WASM. **Single-thread WASM**
  (`numThreads=1`, no SharedArrayBuffer) deliberately, because enabling
  cross-origin isolation (COOP/COEP) would break Firebase Storage media. Voice
  models are downloaded from Hugging Face and cached in **OPFS**.
- **Text -> visemes:** `text-to-visemes` produces a viseme timeline; visemes map
  to ARKit mouth morphs (`VISEME_TO_ARKIT`). A **performance compiler**
  (`lib/performance/`) builds a timeline of audio + morph keyframes + gestures,
  with a **plan cache** for replay.
- **Sync target:** audio and mouth stay within ~50 ms. Progressive/streaming
  summary speech minimizes time-to-first-word; numbers are spoken digit-by-digit.
- Subtitles reuse the same reveal timing (`revealedChars()`) for karaoke effect.

---

## 7. RAG functionality (the core AI feature)

### 7.1 Ingestion (admin) — `functions/src/ingestDocument.ts`
Callable, admin-only. **PDF -> extract text -> chunk (size+overlap) -> embed ->
Firestore** as `VectorValue`. Embeddings: **Vertex AI `text-embedding-004`,
768 dims**, task type `RETRIEVAL_DOCUMENT`. Chunks are stored under a per-
assistant **namespace** (`rag/{namespace}/...`). All credentials/heavy work stay
server-side; the client only orchestrates and reads status.

### 7.2 Retrieval + answering — `functions/src/chatRag.ts`
HTTPS endpoint `POST /chatRag` (mounted by `api.ts`, behind
`validateFirebaseIdToken`; **signed-in users only**). Scoped to one namespace's
chunks via Firestore **`findNearest`** vector search (k≈6, max 8), query embedded
with `text-embedding-004` (task `RETRIEVAL_QUERY`, same model/dims so it's
index-compatible).

It returns a **body-only answer + inline gesture tags + media metadata +
sources** — no greeting/closing, no `[n]` citations. Media is returned as
**Storage paths only**; the client lazy-fetches bytes via the SDK (rules enforced
at fetch time).

**Answer modes** (the key design — a two-stage + helpers flow):
- **`rag`** (default) = **Stage 1: summary only** — short spoken answer
  (~1-2 sentences, `SUMMARY_MAX_TOKENS=160`) + media + the chunk ids used. Fast
  time-to-speech.
- **`detail`** = **Stage 2 on-demand** — long-form analysis shown on "Ver más",
  **reusing the same chunk ids** from stage 1 (no re-embed, no `findNearest`).
  `DETAIL_MAX_TOKENS=768`. NOT spoken.
- **`capabilities`** = metadata-only answer about what the assistant can do (no
  retrieval/media).
- **`suggestions`** = 3 follow-up prompts as strict JSON, reusing stage-1 chunks
  (`SUGGESTIONS_MAX_TOKENS=128`). Generated asynchronously after the summary,
  NotebookLM-style.

### 7.3 LLM profiles & per-stage models — `functions/src/lib/llm-profiles.ts`, `llm.ts`
- A **profile** = provider + model + params + persona. Resolved per assistant
  (`resolveProfileForAssistant`) with **per-stage overrides** (summary vs detail
  can use different models, e.g. detail on `gemini-2.5-flash`) via
  `resolveStageProfile` / `loadRagStageModels`, falling back to a global default
  (`config/ragModels`) then the system default.
- Providers: `openai`, `deepseek`, `gemini-api`. Keys come from Secret Manager;
  `setLlmApiKey` writes them (Admin SDK), `listProviderModels` lists available
  models server-side (key never returned to client).

### 7.4 Client transport — `services/rag-avatar.service.ts`
`ask(query, {assistantId, language, voice, mode, chunkIds, ...})` POSTs to the
endpoint with the Firebase ID token; normalizes the structured response
(`summary`/`detail`/`gestureCommands`/`media`/`sources`/`suggestions`) and
tolerates a legacy `{answer}` shape.

---

## 8. Conversation history persistence (per user, per assistant)

- **Storage:** Firestore `users/{uid}/conversations/{conversationId}`.
- **Schema:** `uid, email, assistantId, assistantName, avatarId, title`
  (first user message, truncated), `messageCount, createdAt, updatedAt`
  (epoch ms), `messages[]` = `{ id, role, content, at, meta?, kind?, detail?,
  detailAvailable?, sourceIds?, srcQuery?, media? }`. (Compiled audio plans and
  suggestions are NOT stored; restored assistant turns are `replayable:false`.)
- **Grouping:** **one doc per visit/session per assistant**, created **lazily on
  the first real message** (never empty records), updated in place as turns
  happen. A new visit starts a new doc.
- **Login required:** only persists when a Firebase user is signed in; otherwise
  ephemeral.
- **Save trigger:** an `effect` on `conv.messages()` -> debounced (700 ms)
  write, guarded by signed-in + ≥1 user turn + content-signature change. Flushed
  before the leave/switch cleanup clears state, so nothing is lost.
- **History UI:** in the Settings (Ajustes) panel — a list (newest first) of the
  current assistant's conversations (title + timestamp + msg count). **Restore is
  on-demand only (never auto)**; restoring replaces the chat log and continuing
  appends to that same doc. Per-row delete with a confirm. Signed-out users see a
  "Inicia sesión para guardar tu historial" note.
- **Firestore rule (owner-scoped, rules don't cascade so the nested match is
  required):**
  ```
  match /users/{uid}/conversations/{conversationId} {
    allow read, write: if isSignedIn() && request.auth.uid == uid;
  }
  ```
- Settings gear is shown to admins **or** any signed-in user (so users can reach
  their history).

---

## 9. Conversational content & intent routing

- **Intent router** (`lib/intent/`): classifies a turn locally as greeting /
  farewell / capabilities / query (ES+EN keyword sets, optional LLM fallback).
  Greetings/farewells/capabilities can be answered instantly without a RAG call.
- **Three-layer conversational content** (`services/conversation-content.service.ts`):
  per-assistant custom content vs editable global defaults vs code fallbacks, for
  greetings, info-acknowledgement fillers (spoken during RAG latency), farewells,
  and suggested prompts. Flag-driven resolution + read-through cache.

---

## 10. Notable engineering decisions / gotchas

- **Piper `fs`/`path` patch:** vits-web's emscripten bundle has dead Node-only
  `require("fs"/"path")` calls. esbuild must still resolve them, and a **module
  worker has no import map**, so they'd break the worker -> Piper would fall back
  to **main-thread synthesis (UI freeze, numThreads=32)**. Fix:
  `scripts/patch-vits-web.mjs` (postinstall) rewrites those requires to `({})`
  so esbuild stubs them in both main and worker chunks. `externalDependencies`
  for fs/path was removed. Custom esbuild builders are **incompatible with
  Angular 21**, hence this approach.
- **No cross-origin isolation (COOP/COEP):** intentionally avoided — it breaks
  Firebase Storage media. Therefore Piper WASM is single-threaded.
- **Zoneless Angular:** all reactivity is signals/computed/effect; route changes
  use `ActivatedRoute` observables; cleanup in `ngOnDestroy`.
- **Source hygiene:** Cloud Functions source must be **ASCII-only** (use `->`
  not arrows, no emojis) to avoid NUL/encoding corruption; verify 0 NUL bytes.
- **Secrets:** LLM/API keys only in Secret Manager; callables never return/log
  keys. Embedding credentials are runtime default credentials (no key in code).
- **Avatar default:** ReadyPlayer Me hosting shut down 2026-01-31; default avatar
  is a hosted RPM-style sample GLB with ARKit morphs.

---

## 11. Data model (Firestore, high level)

- `assistants/{id}` — persona, avatarId, voice, language, `ragCollection`
  (namespace), per-stage LLM profile overrides, custom-content flags,
  greeting/farewell/capabilities config. Public-read kiosk config.
- `assistants/{id}/{greetings|farewells|infoAcknowledgements|suggestedPrompts}/*`
  — per-assistant content.
- `rag/{namespace}/...` — ingested document chunks with `VectorValue` embeddings.
- `avatars/{id}` — reusable avatar catalog (GLB path, thumbnail, conformance).
- `config/*` — non-secret LLM config, global responses, `ragModels` defaults.
- `llm_profiles/{id}` — provider/model/params/persona profiles.
- `users/{uid}` — registry (email + lastLogin); `users/{uid}/conversations/*` —
  chat history (§8).
- `admins/{uid}` — admin allowlist (written server-side only).

**Security model (dev phase):** rules require `request.auth != null`
(signed-in). Role enforcement is currently OFF in dev (any signed-in user can
read/write RAG/admin config); PROD admin-scoped rules are preserved in comments
in `firestore.rules`. Conversation history is always owner-scoped.

---

## 12. Cloud Functions (`functions/src/`)

`ingestDocument`, `api` (Express; mounts `/chatRag`), `setLlmApiKey`,
`testLlmConnection`, `bootstrapFirstAdmin`, `setUserRole`, `listUsers`,
`generateResponses`, `backfillAssistants`, `listProviderModels`.

---

## 13. Known limitations / current notes

- Piper WASM single-threaded (slower synth than multi-thread, but stable + media
  works).
- Restored conversations can't replay cached audio (plans are in-memory only);
  they show as text and can be re-spoken by recompiling.
- History list filters to the current assistant (all-assistants would be a
  one-line change).
- Dev-phase Firestore rules are permissive for signed-in users (tighten before
  production via the PROD blocks in `firestore.rules`).

---

*Project root:* `rpm-face-tracking-angular` (Angular 21 + Firebase `strimearia`).
*Extensive per-feature docs exist as `*_README.md` files at the repo root.*
