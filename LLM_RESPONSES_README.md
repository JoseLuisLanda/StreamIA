# Conversational responses — flags, global defaults, per-assistant overrides, AI generation

Three-layer conversational content with explicit per-category resolution flags,
editable global defaults, per-assistant overrides, AI-assisted generation, and a
flag-aware read-through cache. Builds on the previous content/cache/intent work.

## 1. Resolution flags (the key addition)

`assistants/{id}.useCustomResponses` (per category):

```
useCustomResponses: { greetings, infoAcknowledgements, farewells, suggestedPrompts: boolean }
```

- `true` → the assistant has its own content → read that category's subcollection.
- `false`/absent (default) → never configured → serve the GLOBAL defaults, with
  **no subcollection read** for that category.
- Auto-set `true` the first time content is saved/generated for that category
  (`markCustom` / `replaceCategory`); toggle back via "Revertir a global"
  (`revertCategory`, optionally clearing the docs).

Per-category by design (custom greetings + default farewells). A single global
boolean would be a trivial simplification.

## 2. Three layers

1. **Global defaults** — editable in Firestore `config/responses` (one doc with the
   four category arrays + `modifiedAt`), seeded from code on first use, with a
   hardcoded last-resort fallback if the doc is missing.
2. **Per-assistant overrides** — subcollections under `assistants/{id}`, read only
   when the category flag is `true`.
3. **Resolution** (`ConversationContentService.sync`): per category, flag true →
   fetch subcollection; false → use the global category. Always yields phrases.

## 3. `/llm-responses` admin manager

Dark/purple, gated by `enforceAdminRole`, linked from the Admin Hub + admin navs.

- **Global tab**: CRUD the global defaults (per category lists; Guardar persists
  the whole category, bumps `config/responses.modifiedAt`).
- **Por asistente tab**: pick an assistant → per-category **Custom/Global**
  indicator; Generar con IA → editable drafts → "Aceptar y guardar"
  (`replaceCategory`, sets flag true); "Revertir a global" (flag false).

## 4. AI generation (on demand)

`generateResponses` callable (admin) uses the assistant's resolved LLM profile
(system-default profile for the global tab) + the assistant context (name, role,
description, topicTag, language, persona) to produce on-topic drafts. Returns
DRAFTS only — never auto-saved. Available in `/llm-responses` (both tabs, with
draft review) and in Assistant Manager → Conversación ("Generar con IA" appends
editable entries; full draft review lives in `/llm-responses`).

Generation rules (system prompt): on-topic, ~8-18 words (3-6 s Spanish TTS), no
profanity, language-matched, varied; suggested prompts are `label`+`prompt` pairs
answerable from the RAG namespace. Client soft validation (`phraseWarnings`) warns
on too-short (<5)/too-long (>25)/possible profanity — never hard-blocks.

## 5. Cache + change detection (flag-aware)

IndexedDB cache keyed by assistantId stores the resolved content +
`syncedModifiedAt` (assistant) + `syncedGlobalAt` (global) + a **flags snapshot**.
Warm loads do cheap reads of the assistant doc (`contentModifiedAt` + flags) and
the global doc `modifiedAt`:

- in sync → serve cache, **zero subcollection reads**.
- assistant newer, OR a flag flipped, OR (a category uses global AND the global
  doc changed) → "changes to sync" indicator; keep serving cache until Sync.

Manual Sync always re-fetches. Text-Avatar shows the last-synced date + indicator +
Sync button (unchanged from the previous turn; now flag-aware via the service).

## 6. Intent router (unchanged behavior, flag-aware content)

Greeting / farewell → instant random non-repeating pick from the resolved content
(custom if flag true, else global), no cloud function. Info query / chip → optional
info-ack filler, then `chatRag`. Ambiguous → LLM fallback.

## Files

- `lib/conversation-content/conv-content.models.ts` — `UseCustomResponses`, `GlobalResponses`, cache fields.
- `services/conversation-content.service.ts` — flag-driven resolution, globals load/CRUD, per-assistant CRUD, `replaceCategory`/`revertCategory`/`markCustom`, `generate()`, `phraseWarnings`.
- `functions/src/generateResponses.ts` + `lib/llm.ts` `generateRawFromProfile` + adapter `rawUser` — AI generation.
- `pages/llm-responses/llm-responses.component.ts` — the manager (route + hub card + nav).
- `pages/assistant-manager/...` — Conversación "Generar con IA" + (existing) CRUD; seeds globals on assistant save.
- `lib/rag/rag.models.ts` + `services/assistant-config.service.ts` — `useCustomResponses` on the assistant.

## Firestore rules

`config/{docId}` already covers `config/responses` (signed-in read/write dev; PROD
admin). The `assistants/{id}/{sub}/{docId}` subcollection rule from the previous
turn covers overrides. Deploy: `firebase deploy --only functions,firestore:rules`.

## Confirm

- A `false`-flag assistant issues ZERO subcollection reads and serves globals.
- Saving/generating+accepting custom content flips the flag true and reads its
  subcollection thereafter.
- Admins edit globals or any assistant's responses from `/llm-responses`.
- AI generation respects the rules with human approval (drafts → accept).
- In-sync loads do zero subcollection reads (one/two cheap doc reads).
- Greetings/farewells never hit the cloud function.

## Notes / limitations

- Generation needs a working LLM profile + key (see LLM_PROFILES_README).
- Assistant Manager "Generar con IA" appends saved editable entries (flag set);
  the full draft-review-before-save workflow is in `/llm-responses`.
- Build/deploy run locally; not runnable in this environment.
