# Text-Avatar — RAG Informational Mode

Phase-one "OK-Google-style" kiosk: a deployment locks `/text-avatar` to an
**avatar + RAG topic + activation command**. The client stays "dumb" — it sends
the query + deployment id, receives one structured payload from the Cloud
Function, wraps it with stored lead-in/tail gestures, plays it in the avatar's
voice, and renders media on demand.

The orchestration **Function lives in a separate repo** (Vertex AI Gemini +
Firestore vector search, Express endpoint behind `validateFirebaseIdToken`).
This repo contains only the **client** + the contract + recommended rules.

---

## What was added (client)

| File | Purpose |
|------|---------|
| `src/environments/environment.ts` / `environment.prod.ts` | **Endpoint config** — `ragApiBase`, `ragChatPath`, `ragMediaBucket`. Not hardcoded in components. `fileReplacements` swaps prod at build time (`angular.json`). |
| `src/app/lib/rag/rag.models.ts` | Contract types: `RagRequest`, `RagResponse`, `RagAvatarResponse`, `RagAskOptions`, `RagSource`, `LegacyRagResponse`, `MediaItem`, `DeploymentConfig`. |
| `src/app/lib/rag/rag.config.ts` | Composes endpoint (base + path) from `environment`; localStorage override layer; `getRagMediaBucket()`. |
| `src/app/services/rag-avatar.service.ts` | `ask(query, opts)` with Bearer ID token (force-refreshed), typed `RagAvatarError` states, legacy-shape tolerance; lazy **cross-project** media fetch via Storage SDK (`getBlob`). |
| `src/app/services/firebase-client.ts` | *(extended)* `getStorageForBucket(bucket)` targets the cross-project RAG media bucket. |
| `src/app/services/deployment-config.service.ts` | Loads `deployments/{id}` from Firestore. |
| `src/app/components/media-gallery/media-gallery.component.ts` | Thumbnail gallery + browsable popup (lazy full-asset fetch). |
| `src/app/services/conversation.service.ts` | *(extended)* `ragFetcher` + `runRagTurn` reuse the exact lead→body→tail + lipsync pipeline; `media` on `ConvMessage`. |
| `src/app/pages/text-avatar/text-avatar.component.ts` | *(extended)* RAG-mode toggle + endpoint/deployment settings; renders the gallery in answers. |
| `firestore.rules`, `storage.rules`, `firebase.json` | Recommended rules (review before deploy). |
| `tools/rag-function.reference.ts` | Reference Express handler for your Functions repo. |

---

## The contract

**Endpoint** is composed in `environment.ts`: `ragApiBase + ragChatPath`
(default `https://us-central1-terapia-4bb02.cloudfunctions.net/api` + `/chatRag`
— confirm the mounted route in the Functions repo's `index.ts`/router).

**Request** (client → Function):

```
POST <ragApiBase><ragChatPath>
Authorization: Bearer <Firebase ID token>
Content-Type: application/json
{ "query": "...", "deploymentId": "default", "language": "es",
  "voice": "es_MX-claude-high", "ragPath": "<optional>", "preview": false }
```

**Response** (Function → client):

```json
{
  "body": "spoken/displayed answer, body only",
  "gestureCommands": "Texto [thinking]:[1] ... [laugh]",
  "media": [
    { "id": "img_001", "type": "image", "title": "...",
      "storagePath": "rag-media/<collection>/img_001.jpg",
      "thumbnailPath": "rag-media/<collection>/img_001_thumb.jpg", "caption": "..." }
  ],
  "sources": [ { "id": "doc_12", "metadata": { } } ]
}
```

The Function decides gesture placement using the **same inline tag format** the
client parser already consumes, so the body plays with lipsync + motion blending
exactly as a normal LLM reply. `gestureCommands` is spoken/displayed; `body` is
the tag-free fallback.

**Legacy shape tolerated.** If the Function returns `{ "answer": "...",
"sources": [...] }`, the client maps `answer` onto both `body` and
`gestureCommands` with empty `media`, so no call site has to branch on shape.

### Service API + error states

`RagAvatarService.ask(query, opts)` where
`opts = { deploymentId?, ragPath?, preview?, language?, voice? }`. The ID token
is **force-refreshed every call** (avoids near-expiry 401s). The old positional
form `ask(query, deploymentId, language, voice)` is still accepted.

Failures throw a typed `RagAvatarError` carrying a stable `kind` (and the HTTP
`status`), so the UI renders the right state without string-parsing:

| HTTP / condition | `kind` | User-facing meaning |
|---|---|---|
| (no endpoint set) | `config` | Endpoint not configured in env/Settings. |
| 400 | `bad-request` | Missing/empty query. |
| 401 | `auth` | Not signed in / token rejected. |
| 403 | `forbidden` | Preview/premium content or insufficient role. |
| 404 / 503 | `no-context` | No retrieval context for this query. |
| 500 (+ other 5xx) | `server` | Function/internal error. |
| `fetch` threw | `network` | Likely **CORS** block or offline (`corsSuspected = true`). |

### Auth

The client sends the signed-in user's **Firebase ID token** as
`Authorization: Bearer …`; your `validateFirebaseIdToken` middleware verifies it
and `requireRole('admin')` gates content management. The client never holds
LLM/RAG secrets.

---

## How the client orchestrates a turn

`ConversationService.runRagTurn` mirrors the existing LLM `runTurn` exactly:

1. Push the user message → `sending` → `waiting_llm`.
2. **Start the stored lead-in gesture immediately** — it covers Function
   cold-start + RAG retrieval (~5 s budget). This is the latency handling: the
   avatar is never frozen while the Function works.
3. `await fetcher(query)` → the Function returns `{ body, gestureCommands, media }`.
4. Sanitize `gestureCommands` (same `llm-sanitizer`), push the assistant message
   (with `media`), then `tts.speak(..., { singlePass: true })` — single-pass
   because the lead-in already absorbed latency. Lipsync + inline-gesture motion
   blend as today.
5. Play the stored **tail** gesture after body speech; return to idle.

Routing is via `conv.ragFetcher`: when set (RAG mode on), **every** turn — typed
or voice — goes to the Function; when null, the client LLM path is used unchanged.

### Media (metadata from Function, bytes from Storage via SDK)

The Function returns only `storagePath`/`thumbnailPath` — no signed/public URLs.
The gallery fetches **thumbnails** on render and the **full asset only on popup
open**, via `getBlob(ref(storage, path))`:

- **Security:** access enforced by Storage rules at fetch time; the bucket need
  not be public, and there's no expiring/forgeable URL to leak.
- **Latency:** the Function response stays tiny/cacheable; heavy bytes transfer
  lazily.
- **Scalability:** thumbnails for the gallery, full-res/video only on demand.

If a fetch is unauthorized the popup shows a clear 🔒 state (graceful degrade).
`getBlob` needs CORS on the bucket (`cors.json` already present); it falls back
to `getDownloadURL` if CORS blocks the XHR.

---

## Deployment config (Firestore `deployments/{id}`)

```json
{
  "name": "Museo — Sala 1",
  "avatarId": "alex-ia",
  "ragCollection": "museo-sala1",
  "language": "es",
  "voice": "es_MX-claude-high",
  "activationCommand": "ok strimearia",
  "leadGestureId": "thinking",
  "tailGestureId": "yes",
  "allowAvatarSwitch": true
}
```

The client sends `deploymentId` to the Function, which constrains retrieval to
`ragCollection` **server-side** — a tampered client can't query another topic.
Phase-one public users get the default avatar/topic; they may switch **avatar
(viz) and activation command only**, not arbitrary RAG access.

---

## Configuration

Primary config is in `src/environments/environment.ts` (and `environment.prod.ts`,
swapped at build time via `angular.json` → `fileReplacements`):

```ts
export const environment = {
  production: false,
  ragApiBase: 'https://us-central1-terapia-4bb02.cloudfunctions.net/api',
  ragChatPath: '/chatRag',                          // confirm the mounted route
  ragMediaBucket: 'gs://terapia-4bb02.firebasestorage.app',
};
```

The endpoint is `ragApiBase + ragChatPath`. A localStorage override (Settings →
*Modo informativo (RAG)*) wins over the env default for dev retargeting without a
rebuild. Steps:

1. **Endpoint:** defaults from `environment.ts`; override in Settings if needed.
2. **Deployment id:** same panel (default `default`); click *Cargar deployment*.
3. **Enable** the toggle → the avatar/voice/lead-tail from the deployment are
   applied and every question routes to the Function.

---

## CORS / Auth caveats (server-side actions may be needed)

Two cross-project concerns. **Functions/RAG + media live in `terapia-4bb02`; the
web app + avatar GLBs live in `strimearia`.** Flagging these so the Function /
rules can be adjusted server-side if they bite:

1. **CORS.** The HTTP Function is called from the browser, so it must send CORS
   headers for the app origin (`http://localhost:4200`, your `*.web.app` /
   `*.firebaseapp.com`, your custom domain). If a call fails with a thrown
   `fetch` (no readable status), the client raises `RagAvatarError(kind:
   'network', corsSuspected: true)` and tells the user it's likely CORS. **Fix is
   server-side:** enable CORS on the Express app (e.g. `cors({ origin: [...] })`)
   restricted to the app domain. The client cannot work around this.

2. **Cross-project ID token.** `ask()` attaches the Firebase ID token minted by
   the **strimearia** app. A Function in **terapia-4bb02** verifies tokens for
   *its* project (audience = `terapia-4bb02`), so a strimearia token may be
   rejected (→ 401 `auth`). Resolve ONE of:
   - configure the Function/`validateFirebaseIdToken` in terapia-4bb02 to also
     accept strimearia-audience tokens (verify against strimearia's certs), **or**
   - sign users in against terapia-4bb02 (add a second Firebase app with that
     project's web config and use its `currentUser.getIdToken()` for RAG calls).

3. **Cross-project media bucket.** Media bytes are read from
   `environment.ragMediaBucket` (terapia-4bb02) via `getStorageForBucket(...)`.
   The bucket's **Storage rules evaluate `request.auth` against terapia-4bb02**,
   so the same token-audience caveat applies; and `getBlob` needs **CORS on that
   bucket** (`gsutil cors set cors.json gs://terapia-4bb02.firebasestorage.app`),
   else it falls back to `getDownloadURL`. Unauthorized reads degrade to a clear
   🔒 state in the gallery.

> Build note: the in-repo `node_modules` was installed on Windows, so a Linux CI
> needs `npm ci` on that platform before `ng build`. Verify the integration with
> `ng build` / `ng serve` locally.

---

## Security rules (REVIEW before deploy)

`firestore.rules` — authenticated read on `deployments/**` and
`rag-content/{collection}/**`; admin-only writes (custom claim `role == 'admin'`,
matching your `requireRole('admin')`).
`storage.rules` — authenticated read on `rag-media/**`, admin write.

```bash
firebase deploy --only firestore:rules,storage
```

These are intentionally **not permissive**; review and tighten for your tenancy
before deploying. The Function uses the Admin SDK server-side and bypasses these
(they govern the client surface).

---

## Existing functionality preserved

All current features keep working with RAG mode OFF (default) and ON:

- Body-only LLM contract, lead/main/tail sequencing, inline gesture parsing +
  lipsync/motion blending, neutral-pose transitions (`runRagTurn` reuses the same
  `tts.speak` + `GesturePlayer` paths as `runTurn`).
- Per-avatar voice, voice-resolved gesture audio, replay/plan cache.
- Firebase-backed gesture catalog with read-through cache; avatar catalog/picker
  (now in both `/text-avatar` and `/gesture-studio`).
- Gesture Studio remains the admin surface; Text-Avatar is the public one.

## Known limitations (phase one)

- Function + RAG live in another repo; this client targets the contract above.
  Use `tools/rag-function.reference.ts` as the server starting point.
- `getBlob` loads full video bytes before play (loading state shown); for large
  video, consider a streaming path (range requests) in a later phase.
- RAG conversation has no server-side memory here; each query is independent
  (kiosk Q&A). Multi-turn memory would live in the Function.
- The activation-command ("wake word") field is stored/displayed; always-on
  wake-word listening is a later phase.
```
