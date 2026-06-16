# Fix: older assistants ignore global responses + schema-versioning pattern

## Root cause

`alexia` (created before the response-resolution system) always replied with the
same fixed "¡Hola! ¿En qué puedo ayudarte?" because of three compounding issues:

1. **Missing flags.** Its doc lacks `useCustomResponses`. (The resolver already
   normalized missing flags to `false`/global, so this alone wasn't fatal — but
   see #3.)
2. **Hardcoded single-phrase fallback.** `ConversationService.pickGreeting`/
   `pickFarewell` ended in a single fixed string when the resolved list was empty
   — so it returned the SAME phrase every time (no randomness).
3. **Stale, incompatible IndexedDB cache.** `alexia` was cached by the PRE-flag
   code (envelope without `flags`/`syncedGlobalAt`). The new change-detector either
   served that empty cache or threw, so the resolved greetings stayed empty and
   #2's hardcode won — explaining the repeated identical phrase.

## Fixes

### 1. Defensive resolver (no single hardcode, always random)

`pickGreeting`/`pickFarewell` now use `this.greetings`/`this.farewells` if present,
else a **small code list** (`CODE_GREETINGS`/`CODE_FAREWELLS`, es+en), and always
pick via the random non-repeating selector. There is no single fixed phrase left.
Missing `useCustomResponses` still resolves every category to the global defaults
(`normalizeUseCustom`), and the service's code-fallback globals are also a list.

### 2. Cache schema guard

`CachedConvContent.cacheSchema` (`CACHE_SCHEMA = 2`) is stamped on write and
validated on read (`validEnvelope`): old/incompatible envelopes are treated as a
miss and re-synced, so pre-flag caches can't serve stale/empty content.

### 3. One-time backfill

`backfillAssistants` callable (admin) iterates `assistants/*` and adds any missing
`useCustomResponses` (all false), `contentModifiedAt`, and `schemaVersion`,
reporting `{ scanned, updated, ids }`. Trigger from **/llm-responses → "Normalizar
asistentes"**, or call the callable directly. Run once to normalize the DB.

### 4. Schema versioning + lazy migration (the durable fix)

`lib/rag/assistant-schema.ts` defines `ASSISTANT_SCHEMA_VERSION` (currently 2) and
an ordered `ASSISTANT_MIGRATIONS` list. `AssistantConfigService`:

- On read (`load`/`listAssistants`) runs `migrateAssistantData(raw)`; the upgraded
  data is used immediately AND **written back lazily** (`writeBackMigration`,
  fire-and-forget) so each doc self-heals the first time it's accessed.
- On `save` it stamps `schemaVersion` + writes all current fields, so **new
  assistants are born at the current version** with every field present.

**Adding a future field (the pattern):**

1. Bump `ASSISTANT_SCHEMA_VERSION`.
2. Append a `MigrationStep { to, apply(d) }` that fills the new field's default on
   old docs.
3. Set the field on new docs in `AssistantConfigService.save`.
4. (Optional) update `backfillAssistants` + its `ASSISTANT_SCHEMA_VERSION` mirror
   for a one-shot pass.

Old docs then self-heal on next load; no scattered "if field missing" checks.

## Verify

- `alexia` now resolves greetings from the global defaults and varies them
  (random non-repeating) — not the same fixed phrase. (Tap "Recargar contenido"
  once if a stale cache predates this build; the cache guard also forces a re-sync.)
- A brand-new assistant is saved with `schemaVersion`, `useCustomResponses`, etc.
- An assistant missing future fields self-heals on load (lazy write-back) and
  works immediately even before the write-back lands (in-memory migration).

## Deploy

`firebase deploy --only functions,firestore:rules` (ships `backfillAssistants`),
then `ng build`. Click "Normalizar asistentes" in /llm-responses once, or rely on
lazy per-doc healing as assistants are opened.

## Kept intact

Intent router, override subcollections, `useCustomResponses`, read-through cache,
/llm-responses, AI generation, body-only contract, lead/body/tail, LLM profiles —
unchanged. This adds defensive resolution + cache guard + backfill + the
schema-version/auto-migration pattern.
