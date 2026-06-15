# Assistant Manager

Admin CRUD for the `assistants/{id}` collection. An **assistant** binds an
**avatar** (visual, from the avatars catalog) + a **RAG namespace** (its
knowledge base) + a **persona** (system prompt) + voice/role/description. The
public `/assistants` selector lists the enabled ones; each answers from its own
namespace, in character.

## Placement & access
- Route: **`/assistant-manager`**, behind `adminGuard` (respects
  `environment.enforceAdminRole`: dev = any signed-in user, prod = admin).
- Linked in the top nav of `/assistants` and `/avatar-manager` ("Assistant Mgr").

## Files
- `lib/rag/rag.models.ts` -- `AssistantConfig` extended with `enabled`,
  `createdAt`, `updatedAt`.
- `services/assistant-config.service.ts` -- added `save(cfg)` + `deleteAssistant(id)`;
  `mapDoc` now reads `enabled` (default true). `listAssistants()` still returns all
  (manager) with the `STATIC_ASSISTANTS` fallback when the collection is empty.
- `pages/assistant-manager/assistant-manager.component.ts` -- list + create/edit form.

## What it does
- **List:** rows with avatar thumbnail, name + role pill, namespace, language,
  an inline **Enabled** toggle (saves immediately), and Test / Edit / Delete.
  Missing avatar/namespace references are flagged (amber "(missing)") rather than
  crashing. Loading + empty states.
- **Create/Edit form:**
  - Name, Role, Description, Topic tag.
  - **Avatar picker** -- dropdown from the `avatars` collection (shows id +
    thumbnail preview); selecting prefills the voice from the avatar's
    `defaultVoice`.
  - **RAG namespace picker** -- dropdown from `rag_namespaces` (only existing
    namespaces are selectable).
  - **Persona** -- system prompt textarea.
  - Voice (defaults to avatar default, overridable), Language, Lead-in + Tail
    gesture pickers (from the gesture catalog), optional activation command,
    Enabled toggle.
  - **Save/Cancel** -> writes `assistants/{id}` (id = slug of the name).
    **Test** -> opens `/text-avatar?assistant={id}`.
- **Validation:** Name + `avatarId` + `ragCollection` are required to save (no
  avatar-less or namespace-less assistants).

## End-to-end loop (live RAG)
1. `/assistants` lists `enabled` assistants from Firestore (static fallback only
   when the collection is empty/unreachable).
2. Selecting one -> `/text-avatar?assistant={id}` -> Text-Avatar loads the
   `AssistantConfig`, resolves `avatarId` -> `avatars/{id}` GLB (via
   `getDownloadURL`), applies voice/lead/tail/language, RAG mode ON.
3. On each query the client sends only `{ query, assistantId }`. **chatRag**
   reads `ragCollection` + `systemPrompt` from `assistants/{assistantId}`
   server-side (client can't tamper), runs `findNearest` on
   `rag/{ragCollection}/chunks`, and applies the persona -- body-only, grounded
   in that namespace, with lead/body/tail playback + media popups.

(chatRag already did this from a prior change; no Function edit was needed.)

## Security rules
`firestore.rules` already has `match /assistants/{assistantId}` -- signed-in
read/write (DEV); the PROD admin-claim version is kept commented. Deploy with
`firebase deploy --only firestore:rules` (from the project dir).

## Seeding (optional)
The static Sofia/Alex/Elena remain as the empty-collection fallback. To make them
real, create them via the form (or add docs to `assistants/{id}`), each pointing
at an avatar id (from Avatar Manager) and an ingested namespace (from RAG Admin).

## Untouched
Avatar Manager, Text-Avatar, Gesture Studio, RAG Admin, gesture playback,
lead/body/tail, lipsync/motion blend, media popups -- all unchanged. This is the
additive editor + the selector swap (static -> live enabled) + reuse of the
existing server-side persona/namespace resolution.
