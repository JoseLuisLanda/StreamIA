# Text-Avatar: Login gate, Intent router, Per-assistant namespaces, Avatar 404 fix

This document covers the coordinated change set delivered on 2026-06-14: a login
gate on the conversational flow, a greeting-vs-RAG intent router, strict 1:1
namespace ownership per assistant, an assistant-driven RAG Admin, and the fix for
the avatar GLB 404. Nothing in the original modules (Avatar Manager, Gesture
Studio, lead/body/tail playback, lipsync, media popups) was removed.

## End-to-end loop

Sign in -> pick an assistant (its avatar loads from `avatars/{avatarId}.glbPath`)
-> say/type "hola" -> instant predefined reply spoken with lead/body/tail and
lipsync, **no** Cloud Function call -> ask "Cuales son las medidas...?" ->
answered from **that assistant's own** RAG namespace via `chatRag`, in character,
with media.

## 1. Login required

`/assistants` and `/text-avatar` are now guarded by `authGuard`
(`src/app/app.routes.ts`). An unauthenticated visit redirects to
`/login?redirect=...` and shows the login screen instead of failing mid
conversation. The Firebase ID token (force-refreshed) is attached to every
`chatRag`/callable request in `RagAvatarService.ask`, and `chatRag` keeps its
server-side auth requirement. This supersedes the earlier "public kiosk /
anonymous" idea: login is required.

## 2. Intent router (greeting vs query)

Files: `src/app/lib/intent/intent-router.ts`,
`src/app/services/conversation.service.ts`,
`src/app/services/llm.service.ts`.

Phase one is a fast **local** keyword/pattern classifier
(`classifyIntentLocal`). Routing happens only when RAG mode is active
(`ConversationService.dispatchRag`):

- **greeting** (salutation / small talk, short utterance, no query verb) ->
  `speakGreeting()` plays the per-assistant `greetingResponse` through the normal
  lead/body/tail + lipsync pipeline. No RAG/Function round-trip.
- **query** (question mark or a query verb) -> `runRagTurn()` hits the
  assistant's namespace through `chatRag`.
- **ambiguous** -> optional lightweight one-shot LLM call
  (`LlmService.classifyIntent`, returns `greeting | query`, defaults to `query`
  on error so an information request is never silently dropped). If no classifier
  is wired, ambiguous defaults to `query`.

The greeting list, query-verb list, and greeting reply are configurable per
assistant and merged with global defaults
(`DEFAULT_GREETING_KEYWORDS`, `DEFAULT_QUERY_VERBS`). The local heuristic is
explicitly marked phase-one and can be upgraded later (better tokenization,
multilingual lists, ML) without touching call sites. Spanish is primary, English
secondary; both default lists include es + en triggers.

Text-Avatar wires these in `setRagMode(true)`: it copies
`greetingResponse` / `greetingKeywords` / `queryVerbs` from the loaded assistant
onto the conversation service and sets
`intentClassifier = q => llm.classifyIntent(q)`. Turning RAG mode off clears them.

## 3. Per-assistant 1:1 namespace ownership

Each assistant **owns** one RAG namespace. `AssistantConfig.ragCollection` is the
canonical owned namespace; `ragNamespace` is an explicit alias. Convention: the
namespace usually equals the assistant id. `AssistantConfigService.save()`
defaults both to the assistant id when unset and writes them together;
`chatRag` reads `assistants/{id}.ragCollection` server-side (authoritative) and
only falls back to the client-supplied `namespace` hint when the assistant doc
has none. Documents, chunks, and media live under
`rag/{ragCollection}/{documents,chunks,media}`.

## 4. RAG Admin is assistant-driven

`src/app/pages/rag-admin/rag-admin.component.ts`: the sidebar is now an
**assistant selector** (avatar thumbnail + name + role). Selecting an assistant
sets the active namespace to its `ragCollection` and loads that namespace's
documents; uploads and ingestion therefore always target the selected
assistant's namespace. All data flows are unchanged underneath
(`RagAdminService` + `ingestDocument` + the same Firestore/Storage paths). A
"Manage assistants" link points to `/assistant-manager`. The chunk and media
tabs operate on the same resolved namespace.

## Updated data model

`AssistantConfig` (`src/app/lib/rag/rag.models.ts`) new/relevant fields:

```
id: string
name?, role?, description?, thumbnail?, topicTag?
avatarId: string                 // visual only -> avatars/{avatarId}
ragCollection: string            // OWNED namespace (authoritative, 1:1)
ragNamespace?: string            // explicit alias of the owned namespace
greetingResponse?: string        // instant reply for greetings (no RAG)
greetingKeywords?: string[]      // extra greeting triggers (merged w/ defaults)
queryVerbs?: string[]            // extra query verbs (merged w/ defaults)
systemPrompt?: string            // persona; read server-side by chatRag
language: string, voice: string
leadGestureId?, tailGestureId?, activationCommand?, allowAvatarSwitch?
enabled?: boolean, createdAt?, updatedAt?
```

Firestore layout:

```
assistants/{id}          AssistantConfig (namespace owner + persona + greeting/intent cfg)
avatars/{id}             Avatar (visual only: glbPath, defaultVoice, thumbnails)
rag/{namespace}/documents|chunks|media   ingested knowledge per owned namespace
rag_namespaces/{ns}      namespace metadata (legacy listing)
admins/{uid}             admin allowlist (enforced when enforceAdminRole=true)
```

Avatars stay separate and visual-only; assistants reference an avatar by id.

## 5. Avatar GLB 404 fix

`TextAvatarComponent.selectAvatar(id)` now resolves the model from the
`avatars/{id}` Firestore document's `glbPath` first (via
`AvatarManagerService.resolveUrl`), then falls back to the static catalog. If
neither resolves it logs and shows a clear error naming the attempted path
("Avatar \"x\" GLB not found (tried: ...)") instead of a silent 404, so a missing
file under `avatars/models/` is obvious. This fixes `mar-ia.glb` not loading for
`furniture-advisor`, whose avatar now resolves from its Firestore doc.

## Configuring TTS / providers / API keys

The intent ambiguity fallback and (non-RAG) chat use `LlmService`, configured in
the Text-Avatar settings (provider + per-provider config persisted to
`localStorage`). Providers: Ollama (local, no key), OpenAI, DeepSeek, Anthropic,
Gemini. TTS is Piper (local) or Web Speech. RAG answers come from the `chatRag`
Cloud Function (Vertex embeddings + Gemini), configured via `environment` and
Functions env; see `FUNCTIONS_README.md` and `RAG_ADMIN_README.md`.

The cloud-free first approach is satisfied by Ollama + Piper for chat/TTS and the
local intent classifier; the Azure/AWS viseme path remains a later option (see the
Phase-1 research comparison).

## Migration / seed note

Existing loose namespaces (e.g. `education`, `catalogo`, `museo`) keep working:
attach one to an assistant by setting that assistant's `ragCollection` (or
`ragNamespace`) to the existing namespace id. New assistants default their
namespace to their id, so ingest under the assistant in RAG Admin and the loop is
self-consistent.

## Known limitations

- Intent classification is phase-one keyword/pattern based; edge phrasings may be
  routed by the LLM fallback (one extra short call) or default to `query`.
- The greeting reply is a single static string per assistant (no templating yet).
- RAG Admin lists assistants from `assistants/*` (static fallback in dev); a
  namespace with no owning assistant won't appear in the sidebar.
- Build/deploy must be run locally (Windows `node_modules`, GCP creds); the
  sandbox here cannot run `ng build` / `firebase deploy`.
