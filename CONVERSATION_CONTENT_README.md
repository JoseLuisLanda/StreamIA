# Per-assistant conversational content + read-through cache + change-detection sync

Adds per-assistant greetings / info-acknowledgements / farewells / suggested
prompts as nested Firestore subcollections, cached locally (IndexedDB) after the
first full read, re-synced only when the server signals changes, and wired into
the Text-Avatar intent router. RAG, embeddings, persona, LLM profiles, lead/body/
tail, lipsync and media are unchanged.

## Storage (nested subcollections under `assistants/{id}`)

```
assistants/{id}/greetings/{id}            -> { text, order, enabled, createdAt }
assistants/{id}/infoAcknowledgements/{id} -> { text, order, enabled }   // said WHILE fetching
assistants/{id}/farewells/{id}            -> { text, order, enabled }
assistants/{id}/suggestedPrompts/{id}     -> { label, prompt, order, enabled }
```

Each phrase/prompt is its own document (individually editable/deletable/orderable
/scalable — not an inline array). Optional short trigger keywords
(`greetingKeywords`, `farewellKeywords`) stay as small fields on the parent
assistant doc. New assistants are seeded with Spanish defaults (suggested prompts
adapt to the role).

## Change marker

`assistants/{id}.contentModifiedAt` (serverTimestamp) is bumped by the Assistant
Manager on ANY conversational write (add/edit/delete/reorder/toggle/seed). It is
the single source of truth for "content changed at X".

## Read-through cache (IndexedDB) + change detection

`ConversationContentService` resolves content in order: **in-session memory →
IndexedDB → Firestore (full fetch on miss)**. The IndexedDB envelope
(`textavatar-conv` DB, keyed by assistantId) stores the four subcollections plus
`syncedModifiedAt` (the contentModifiedAt synced against) and `lastSyncAt`.

On each assistant selection:

1. **Cold cache / miss** → `sync()`: fetch all four subcollections in parallel
   (suggestedPrompts first), filter `enabled`, sort by `order`, write the cache,
   record `syncedModifiedAt = contentModifiedAt`.
2. **Warm cache** → `checkForUpdates()` does ONE cheap read of the assistant doc's
   `contentModifiedAt` and compares to `syncedModifiedAt`:
   - equal/older → serve cache, **zero subcollection reads**.
   - server newer → keep serving cache, surface the "changes to sync" indicator.

Manual **Sync** always forces a full re-fetch, overwrites the cache, updates
`syncedModifiedAt` + the last-sync date, and clears the indicator.

## Response flow (extends the intent router)

Per user message (`ConversationService.dispatchRag`), in order:

1. **Greeting** → instant random non-repeating pick from cached greetings, spoken
   via lead/body/tail + lipsync. No cloud function.
2. **Farewell** → random pick from farewells, instant, no RAG.
3. **Info query** (query verb / `?` / tapped chip) → optionally speak a random
   `infoAcknowledgement` as a latency filler (started concurrently with the RAG
   fetch), then `chatRag` for the real answer.
4. **Ambiguous** → existing lightweight LLM classifier decides greeting vs query.

Random picks avoid repeating the previous phrase per category.

## Text-Avatar UI

- Suggested-prompt **chips** near the input (tap → straight to the info/RAG path
  via `sendSuggestedPrompt`). Hidden gracefully when empty.
- **Last-synced date**: "Contenido actualizado: …".
- **"Hay cambios nuevos — Sincronizar"** badge when `contentModifiedAt >
  syncedModifiedAt`; the Sync button forces a full re-fetch.

## Assistant Manager — CRUD

A "Conversación / Personalidad" section (shown when editing an existing assistant):
add/edit (inline, on blur)/delete/toggle-enabled/reorder (↑↓) for greetings,
info-acknowledgements, farewells, and suggested prompts (label + prompt), plus the
optional greeting/farewell keyword overrides. Every write bumps `contentModifiedAt`.
Creating an assistant seeds sensible defaults.

## Files

- `src/app/lib/conversation-content/conv-content.models.ts` — types + seed defaults.
- `src/app/lib/conversation-content/conv-content-cache.ts` — IndexedDB wrapper.
- `src/app/services/conversation-content.service.ts` — read-through + change-detect + CRUD + seed.
- `src/app/lib/intent/intent-router.ts` — added `farewell` intent + farewell keywords.
- `src/app/services/conversation.service.ts` — greeting/farewell/infoAck arrays, random non-repeating picks, `sendSuggestedPrompt`.
- `src/app/pages/text-avatar/text-avatar.component.ts` — load content, chips, date, sync indicator/action.
- `src/app/pages/assistant-manager/assistant-manager.component.ts` — CRUD section + seed on create.

## Firestore rules

Firestore rules do NOT cascade to subcollections, and `match /assistants/{id}` is
single-segment, so an explicit nested rule was added:

```
match /assistants/{assistantId}/{sub}/{docId} {
  allow read: if isSignedIn();   // Text-Avatar cache reads
  allow write: if isSignedIn();  // DEV; PROD: isAdmin()
}
```

Deploy with `firebase deploy --only firestore:rules` or the subcollection
reads/writes will be denied by the default-deny rule.

## Verification checklist

- First selection of an assistant → full sync (4 parallel reads), cache populated.
- In-sync re-selection → one cheap assistant-doc read, zero subcollection reads.
- Editing content in Assistant Manager → Text-Avatar shows "Hay cambios nuevos".
- Tapping Sync → picks up new content + updates the date + clears the indicator.
- Greetings/farewells never call the cloud function; info queries do.

## Notes / limitations

- IndexedDB unavailable (private mode) → falls back to Firestore each load (cache
  best-effort).
- Build/deploy run locally; not runnable in this environment.
