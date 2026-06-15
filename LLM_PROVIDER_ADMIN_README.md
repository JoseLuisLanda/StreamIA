# LLM Provider Admin — configurable, key-based generation (OpenAI / DeepSeek / Gemini API)

Decouples chatRag text generation from a hardcoded provider. The provider, model,
params, and API key are configured from a web admin (`/llm-admin`) and swappable
without code changes. **Vertex AI has been removed** — all providers are
key-based. Embeddings and RAG retrieval are unchanged.

## Providers

`openai`, `deepseek` (OpenAI-compatible), `gemini-api` (Gemini via API key). Each
requires an API key stored server-side in Secret Manager. There is no
service-account / Vertex path anymore.

## Why a saved config didn't take effect (root cause)

Earlier, saving OpenAI in the UI but still getting a `gemini-vertex` error had two
causes — important if you see stale behavior again:

1. **The Functions were not redeployed.** The UI runs locally, but `chatRag` is the
   *deployed* Cloud Function. Until you run `firebase deploy --only functions`, the
   deployed `chatRag` keeps running its previous code (which hardcoded Vertex) and
   never reads `config/llm`. **Redeploying functions is mandatory after any change
   to the `functions/` code.**
2. **A silent Vertex default.** The old `loadLlmConfig()` returned a hardcoded
   Vertex default when `config/llm` was missing or its write was rejected (e.g. the
   `config/**` Firestore rule not deployed). A non-persisted save then looked
   identical to "config ignored."

Both are fixed: Vertex is gone, and `chatRag` now **errors clearly**
("LLM not configured — set a provider and API key in /llm-admin") instead of
falling back. It also logs the selected `provider`, `model`, and `keyFound` so the
active provider is verifiable in `firebase functions:log`.

## "Key saved OK but chatRag says No API key configured" (root cause)

Write (`secretmanager.versions.add`) and read (`secretmanager.versions.access`)
are SEPARATE IAM permissions. The runtime service account could create/add the
secret version (so the panel showed "Key saved"), but lacked **access** to read it
back — and the old `getApiKey` **swallowed** that PERMISSION_DENIED and returned
`''`, which surfaced as the misleading "No API key configured for provider".

Fixes:

- `getApiKey` (Option B, runtime fetch — no `defineSecret`/redeploy needed) now
  DISTINGUISHES errors: NOT_FOUND -> "" (genuinely unconfigured); PERMISSION_DENIED
  / API-disabled / other -> THROWS the real message, which chatRag returns in
  `detail` and logs. Only non-empty keys are cached, so a later save is picked up
  next request.
- `setLlmApiKey` now does a read-back **probe** (`probeSecretAccess`) right after
  writing; if the key can't be read back it returns a real error
  ("Key stored, but the runtime cannot READ it back ... grant
  roles/secretmanager.secretAccessor") instead of a false "saved OK".
- Logging: key save (secret name + version), and generation (provider, model,
  keyFound, and any access error) — all in `firebase functions:log`.

Provider -> secret naming is a single constant `llm-key-<provider>` used on BOTH
write and read (`openai` -> `llm-key-openai`, etc.), so no name mismatch.

THE OPERATOR FIX: grant the Functions runtime service account
`roles/secretmanager.secretAccessor` (read) in addition to write — or simply
`roles/secretmanager.admin` (both) — and ensure the Secret Manager API is enabled,
then redeploy functions and save the key again.

## Provider abstraction (`functions/src/lib/llm-providers/`)

```
contract.ts       LlmProvider, GenerateInput, buildSystemPrompt (body-only + persona), buildUserText
openai.ts         OpenAiCompatibleProvider  -> OpenAI AND DeepSeek (/v1/chat/completions, Bearer key, baseUrl override)
gemini-api.ts     GeminiApiProvider          -> generativelanguage.googleapis.com (API key)
factory.ts        createProvider(config, apiKey) -> throws on unknown provider (no Vertex default)
gemini-vertex.ts  REMOVED (empty stub; safe to delete)
```

`lib/llm.ts` is the facade: it loads `config/llm`, requires a key, builds the
adapter, and exposes `generateAnswer(...)` / `generateAnswerWithMeta(...)`. If
`config/llm` is absent it throws "LLM not configured" (no hidden default). The
body-only / grounded contract + persona composition live once in `contract.ts`
(persona first, base rules appended after, so they take precedence).

## Config + secure key handling

Non-secret config in Firestore `config/llm`:

```
provider: 'openai' | 'deepseek' | 'gemini-api'
model, temperature, maxOutputTokens, topP?, baseUrl?
updatedAt, updatedBy
keyStatus: { <provider>: { updatedAt, updatedBy } }   // STATUS only, never the key
```

The API key is **never** in Firestore. It is stored server-side in Google Secret
Manager (secret id `llm-key-<provider>`), written by the `setLlmApiKey` callable.
`chatRag` reads it at runtime via ADC (`getApiKey`); the client only reads
`keyStatus` to show a masked "Key configured" state. The default form values are
OpenAI / `gpt-4o-mini` — these are initial field values only, NOT a runtime
fallback.

## `/llm-admin` web component

Admin-gated (respects `enforceAdminRole`), dark/purple theme, linked from the
Admin Hub. Pick provider, set model (per-provider suggestions), temperature /
max tokens / top_p / optional base URL; submit the API key (write-only, via
`setLlmApiKey`, shows masked "configured", never echoes the key); and **Test
connection** (calls `testLlmConnection` for a tiny generation, reporting success
or the real provider error). Saving writes only the non-secret config and surfaces
write errors in the UI.

## chatRag wiring

`chatRag` calls `generateAnswerWithMeta`, which reads `config/llm` + the
Secret-Manager key, builds the adapter via the factory, and generates. On failure
it returns `{ error:'generation failed', provider, model, detail }` (500) and logs
the same. Body-only contract, per-assistant persona, namespace resolution,
gestures and media are unchanged.

## What is intentionally unchanged

RAG retrieval (`findNearest`), per-assistant namespace + persona, **embeddings**
(`text-embedding-004`, Vertex — embeddings still use Vertex by design; only
*generation* moved off it), the intent router, lead/body/tail, and media.
Changing the embedding provider would require re-indexing every namespace, so it's
deliberately out of scope.

## Deploy / setup (required for it to work)

1. `cd functions && npm install` (adds `@google-cloud/secret-manager`).
2. Grant the Functions runtime service account Secret Manager access so
   `setLlmApiKey` can create/add versions and chatRag can read them:
   `roles/secretmanager.admin` (simplest) — or, more tightly,
   `roles/secretmanager.secretVersionAdder` + `roles/secretmanager.secretAccessor`
   (plus `roles/secretmanager.admin` once, to create the secret).
3. **`firebase deploy --only functions,firestore:rules`** — this ships the
   provider-aware `chatRag` AND the `config/llm` rule. Skipping this is the #1
   reason saves "don't take effect."
4. Open `/llm-admin`, choose provider/model, **Save key**, **Test connection**,
   then **Save configuration**.

Local/emulator fallback: keys can be supplied via env
(`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, or generic `LLM_API_KEY`)
when Secret Manager isn't reachable.

## End-to-end verification

- Set provider = OpenAI, model = `gpt-4o-mini`, save key → **Test connection**
  succeeds.
- Ask the assistant a question → no Vertex error; `firebase functions:log` shows
  `provider: openai, model: gpt-4o-mini, keyFound: true`.
- Switch provider (OpenAI <-> DeepSeek <-> Gemini-API) + Save → the next request
  uses the new provider (per-instance key cache refreshes on key write; config is
  read per request).

## Security summary

- The API key is write-only from the client, stored only in Secret Manager, never
  returned, never in Firestore. Firestore holds only non-secret config + key
  status. `config/llm` is authenticated read/write in dev (commented admin-only
  PROD block in `firestore.rules`); the callables additionally enforce admin when
  `ENFORCE_ADMIN_ROLE=true`.

## Known limitations

- Build/deploy run locally (Windows node_modules; GCP creds); this environment
  can't run `npm install` / `firebase deploy`.
- One key per provider (latest Secret Manager version wins).
- `testLlmConnection` runs a real (tiny) generation and may incur minimal cost on
  paid providers.
