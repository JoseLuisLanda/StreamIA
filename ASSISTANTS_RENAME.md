# Rename: `deployments` -> `assistants` (coordinated)

Pure rename (no behavior change): the Firestore collection, types, services,
methods, params, constants, route query param and labels all moved from
"deployment" to "assistant", matching the `/assistants` route and product
language.

## What changed (code)

| Before | After |
|---|---|
| Firestore collection `deployments/{id}` | `assistants/{id}` |
| `services/deployment-config.service.ts` | `services/assistant-config.service.ts` (file renamed) |
| class `DeploymentConfigService` | `AssistantConfigService` |
| `listDeployments()` | `listAssistants()` |
| `load(deploymentId)` | `load(assistantId)` |
| interface `DeploymentConfig` | `AssistantConfig` |
| `STATIC_DEPLOYMENTS` | `STATIC_ASSISTANTS` |
| `RagRequest.deploymentId`, `RagAskOptions.deploymentId` | `assistantId` |
| `getDeploymentId()/setDeploymentId()/DEFAULT_DEPLOYMENT_ID` (rag.config) | `getAssistantId()/setAssistantId()/DEFAULT_ASSISTANT_ID` |
| localStorage key `rag.deploymentId` | `rag.assistantId` |
| text-avatar `deploymentSvc / deploymentId / deployment() / reloadDeployment() / onDeploymentIdChange()` | `assistantSvc / assistantId / assistant() / reloadAssistant() / onAssistantIdChange()` |
| route query `/text-avatar?deployment=ID` | `/text-avatar?assistant=ID` |
| chatRag `body.deploymentId` + `db.collection('deployments')` | `body.assistantId` + `db.collection('assistants')` |
| `tools/rag-function.reference.ts`, `firestore.rules` | renamed to assistants |

Only inert comments still contain the word "deployment" (allowed) -- no active
identifier, collection string, route param, or wire field does.

## Client <-> Function consistency (verified)

Both sides reference the SAME collection now:
- Client `AssistantConfigService`: `doc(db, 'assistants', id)` and
  `collection(db, 'assistants')`.
- Function `chatRag`: `db.collection('assistants').doc(body.assistantId)`.
- Wire field: client sends `{ ..., assistantId }`; chatRag reads `body.assistantId`.
- `firestore.rules`: `match /assistants/{assistantId}`.

So persona (`systemPrompt`) + `ragCollection` are resolved from `assistants/{id}`
server-side, exactly as before, just under the new name.

## Firestore data migration

If you already created docs under `deployments/*`, copy them to `assistants/*`:

Option A -- script (recommended):
```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project strimearia
node tools/migrate-deployments-to-assistants.mjs
```
It copies every `deployments/{id}` to `assistants/{id}` (idempotent) and does NOT
delete the originals -- remove the old `deployments/*` docs manually after verifying.

Option B -- manual: in the Firebase console, recreate each doc under a new
`assistants` collection with the same id + fields.

If `deployments` was empty (only the static fallback was ever used), there is
nothing to migrate -- the new code already reads `assistants` and the
`STATIC_ASSISTANTS` fallback renders in dev.

## Redeploy (required for server-side rename to take effect)

```bash
firebase use strimearia
cd functions && npm install && npm run build && cd ..
firebase deploy --only functions,firestore:rules
```
- `functions` -> chatRag now reads `assistants/{id}`.
- `firestore:rules` -> the `assistants/**` rule replaces `deployments/**` (so
  reads/writes to the new collection aren't blocked).

Until both are redeployed, a client reading `assistants` while an old deployed
chatRag/rules still reference `deployments` would mismatch -- deploy both together.

## Note on older READMEs

`RAG_AVATAR_README.md` / `RAG_ADMIN_README.md` / `FUNCTIONS_README.md` /
`ASSISTANTS_README.md` may still say "deployment(s)" in prose. Those are inert
historical mentions; the authoritative shape is `assistants/{id}` per above.
