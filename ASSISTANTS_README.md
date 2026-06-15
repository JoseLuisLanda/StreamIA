# Assistants selector (`/assistants`) + per-assistant persona

A landing screen where the user picks an assistant card, then launches Text-Avatar
fully configured for that assistant (avatar + voice + RAG namespace + persona +
lead/tail), with RAG mode ON. An "assistant" is a `deployments/{id}` document.

## Flow
1. `/assistants` (now the app landing; `''` redirects here) lists `deployments/*`
   from Firestore (static fallback if empty/unreachable; real empty state if both
   yield nothing).
2. Clicking a card -> `/text-avatar?deployment={id}`.
3. Text-Avatar `ngOnInit` reads `?deployment`, sets the deployment id, and calls
   `setRagMode(true)` -> loads the deployment (avatar/voice/language/lead-tail) and
   wires the RAG fetcher. Direct `/text-avatar` (no param) still works; RAG OFF
   (Ollama/direct) still works for dev.
4. On each query the client sends `{ query, deploymentId, language, voice }` to
   `chatRag`. The Function resolves **ragCollection + systemPrompt server-side**
   from `deployments/{deploymentId}` (client can't tamper), retrieves from that
   namespace, and merges the persona into generation -- still body-only and
   grounded in the namespace's chunks (lead/tail handle greeting/closing).

## `deployments/{id}` document shape (create manually in Firestore)
```jsonc
{
  "name": "Sofia",                         // card title
  "role": "Asesora de Muebles",            // card pill
  "description": "Experta en diseno de interiores; te ayuda con el catalogo.",
  "avatarId": "alex-ia",                   // MUST match an id in the avatar catalog
  "ragCollection": "catalogo",             // an INGESTED rag namespace (rag/{ns}/chunks)
  "systemPrompt": "Eres Sofia, asesora experta de una tienda de muebles. Ayudas a elegir productos del catalogo, das medidas y precios cuando estan en el contexto, tono calido y comercial.",
  "voice": "es_MX-...",                     // optional Piper/WebSpeech voice id; '' = avatar default
  "language": "es",                         // 'es' | 'en'
  "thumbnail": "deployments/sofia.png",     // optional: Storage path or https URL (card portrait)
  "topicTag": "Catalogo",                   // optional card chip
  "leadGestureId": "thinking",              // optional
  "tailGestureId": "yes",                   // optional
  "activationCommand": "ok strimearia",     // optional (wake phrase, future)
  "allowAvatarSwitch": true
}
```
Minimum to work: `name`, `avatarId`, `ragCollection`, `systemPrompt`. The
`ragCollection` must already have ingested chunks (see RAG Admin) or chatRag
returns 404/503. Read access requires sign-in (Firestore rules); when signed out,
the selector shows the static fallback cards only.

## Static fallback (dev)
`STATIC_DEPLOYMENTS` in `deployment-config.service.ts` (Sofia / Alex / Elena).
Edit there to change dev placeholders. They use `avatarId: 'alex-ia'` and example
namespaces (`catalogo`, `institucional`, `museo`).

## Admin alignment (future, not built now)
Assistants are just `deployments`. A future RAG Admin "Assistants" section would
create/edit these docs (pick a namespace + avatar + voice + persona) instead of
hand-editing Firestore. For now create them manually with the shape above.

## What changed
- `lib/rag/rag.models.ts`: `DeploymentConfig` extended with `role`, `description`,
  `systemPrompt`, `thumbnail`, `topicTag` (+ `name` used as title).
- `deployment-config.service.ts`: `listDeployments()` + static fallback +
  `resolveThumbnail()`; `mapDoc` includes the new fields.
- `pages/assistants/assistants.component.ts`: the card grid (loading/empty states).
- `app.routes.ts`: `''` -> `/assistants`; added `/assistants` (lazy) and `/home`.
- `pages/text-avatar`: reads `?deployment` and applies the config with RAG on.
- `functions/chatRag.ts` + `lib/llm.ts`: persona resolved server-side from the
  deployment and merged into generation (body-only contract preserved).

## Preserved
Body-only contract, lead->body->tail, lipsync/motion blend, neutral-pose
transitions, per-avatar voice, voice-resolved gesture audio, media popups,
gesture catalog/cache, avatar catalog/picker, and RAG-OFF (Ollama) dev mode.
Redeploy `functions` to apply the persona change: `firebase deploy --only functions`.
