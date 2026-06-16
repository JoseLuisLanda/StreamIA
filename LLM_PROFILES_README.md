# LLM Config Profiles — reusable scoped configs with labeled keys

Refactors LLM configuration from a single global `config/llm` doc into reusable
**config profiles**. Each profile = provider + model + params + N labeled API keys
(one active, chosen manually). Two scopes: **global** (admin-managed, reusable,
one system default) and **assistant-private** (same schema, usable only by its
owner assistant). Embeddings and RAG retrieval are unchanged.

## Data model

`LlmConfigProfile` (`functions/src/lib/llm-profiles.ts`, client mirror in
`src/app/lib/llm-admin/llm-profile.models.ts`):

```
id, name, scope: 'global' | 'assistant', ownerAssistantId?
provider: 'openai' | 'deepseek' | 'gemini-api', model, temperature, maxOutputTokens, topP?, baseUrl?
keys: LlmKeyRef[]            // N labeled keys; exactly one active
isSystemDefault?            // global only; exactly one true
createdAt, updatedAt
```

`LlmKeyRef`: `{ id, label, secretName, active, updatedAt }` — the key VALUE lives
only in Secret Manager under `secretName`; Firestore stores metadata only.

### Firestore layout (chosen)

A single collection **`llm_profiles/{id}`** holds both scopes (distinguished by
`scope` + `ownerAssistantId`). This keeps chatRag resolution a single doc lookup
and makes listing simple. Exactly one global profile has `isSystemDefault:true`.

Secret naming (consistent on write + read): `llm-key-<profileId>-<keyId>`. The
migrated default reuses the legacy `llm-key-<provider>` secret as its active key.

## Assignment + resolution

`AssistantConfig.llmProfileId` references a global profile id OR one of the
assistant's own private profile ids. Resolution in `chatRag` at request time
(`resolveProfileForAssistant`):

1. If `llmProfileId` is set → load that profile.
   - **Private** profile: must be owned by this assistant, otherwise **rejected**
     (security — a private profile/secret can't be used by another assistant).
   - **Global** profile: allowed.
   - Missing referenced profile → falls back to the system default (logged).
2. Else → the **system-default** global profile.
3. From the resolved profile: provider/model/params + the **active** labeled key,
   whose `secretName` value is read from Secret Manager **at request time** (no
   redeploy when keys/active selection change). Clear errors on: no system default,
   no key, key unreadable (the IAM/PERMISSION_DENIED case is surfaced verbatim).

Server logs (`firebase functions:log`): `profile resolved` (source/scope) and
`profile selected` (provider/model/key/keyFound).

## Keys: N labeled, one active, manual

Managed via admin-gated callables (`functions/src/llmProfiles.ts`):

- `setLlmProfileKey({ profileId, keyId?, label, key })` — writes the value to
  Secret Manager (`writeSecret` + read-back `probeSecret`), records the `LlmKeyRef`
  (first key auto-active). Replacing a value reuses the same `keyId`/secret.
- `setActiveLlmKey({ profileId, keyId })` — metadata-only active switch (no key re-entry).
- `deleteLlmProfileKey({ profileId, keyId })` — deletes the Secret Manager secret + ref (promotes next to active).
- `saveLlmProfile`, `deleteLlmProfile` (also deletes its secrets), `setSystemDefaultProfile`, `testLlmProfile`, `migrateLegacyLlmConfig`.

All key writes surface real Secret Manager errors (no false "saved"); the SA needs
read + write (`roles/secretmanager.admin`, or `secretAccessor` + `secretVersionAdder` + creation).

## Access scoping (enforced)

- **Global** profiles: admin-managed; readable for assignment; usable by any
  assigned assistant.
- **Private** profiles: only the owner assistant can use them — `chatRag` rejects
  a private profile referenced by a different assistant (server-side validation).
  Firestore rules (`llm_profiles`) are dev-permissive (signed-in read/write) with a
  commented admin-only PROD block; the real ownership boundary is in chatRag.

## UI

- **`/llm-admin`** = global profile manager: list (provider/model, key count,
  active key, system-default badge), create/edit/delete, mark system default,
  migrate legacy config. Each profile opens a shared editor
  (`LlmProfileEditorComponent`) for params + labeled keys (add/replace/delete/set
  active) + Test.
- **Assistant Manager → LLM section**: assign via a dropdown of global profiles +
  this assistant's private profiles (or "- system default -"), shows the effective
  config ("Global: OpenAI Produccion / gpt-4o-mini, llave: Cuenta principal" or
  "Propia: DeepSeek / deepseek-chat"), a **Probar LLM** test, and a "+ Perfil
  privado" action that opens the same editor scoped to this assistant. Keys are
  always write-only (never echoed).

## Migration

`migrateLegacyLlmConfig` (button in `/llm-admin`, "Migrar config/llm"): if no
global profile exists and a legacy `config/llm` is present, it creates one global
profile (`isSystemDefault:true`) with the legacy provider/model/params and a single
active labeled key whose `secretName` is the existing `llm-key-<provider>` secret —
so the current key keeps working with NO re-entry. Idempotent (skips if globals exist).

## Deploy / setup

1. `cd functions && npm install` (uses `@google-cloud/secret-manager`).
2. SA needs Secret Manager read + write (`roles/secretmanager.admin`).
3. `firebase deploy --only functions,firestore:rules`.
4. `/llm-admin` → "Migrar config/llm" (or create a profile), add labeled keys, mark
   a system default. Assign profiles per assistant in Assistant Manager.

## Verification checklist

- Multiple profiles per scope; N labeled keys with manual active selection.
- Two assistants sharing a provider via different profiles/keys.
- A private profile referenced by another assistant → chatRag rejects it.
- An assistant with no `llmProfileId` → uses the system default.
- Switching the active key (metadata only) changes the next request's key with no redeploy.

## Kept intact

RAG retrieval, embeddings, per-assistant persona/namespace, intent router,
body-only contract, lead/body/tail. Only LLM config moved to scoped profiles.

## Notes / limitations

- Build/deploy run locally (Windows node_modules; GCP creds) — not runnable here.
- The legacy `setLlmApiKey`/`testLlmConnection` callables + `config/llm` remain for
  the migration path; new UI uses the profile callables.
- Private-profile editing is centralized in the shared editor (same component as
  global), embedded in the Assistant Manager scoped to the owner assistant.
