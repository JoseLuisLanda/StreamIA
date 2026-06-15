# Avatar Manager

Admin CRUD for the reusable **visual** avatar catalog (Firestore `avatars/{id}`),
with an integrated Three.js GLB preview. Separate from `assistants` (which combine
an avatar + RAG namespace + persona + voice).

## Placement & access
- Route: **`/avatar-manager`**, lazy, behind `adminGuard` (same gating as
  `/rag-admin`). Respects `environment.enforceAdminRole`: dev = any signed-in
  user; prod = admin (claim/allowlist). The component also self-checks and shows
  a denied state defensively. Header links to `/assistants` and `/rag-admin`.

## Files
- `lib/avatars/avatar.models.ts` -- `Avatar` + `AvatarMeshStats` (visual only).
- `services/avatar-manager.service.ts` -- CRUD on `avatars/{id}`, GLB/thumbnail
  upload to Storage (progress), `getDownloadURL` resolution, slug id helper.
- `pages/avatar-manager/components/glb-viewer.component.ts` -- Three.js viewport
  (GLTFLoader + OrbitControls): orbit/zoom/reset/fullscreen, reads mesh stats +
  ARKit conformance via the shared `buildNormalizedRig` (rig-spec).
- `pages/avatar-manager/avatar-manager.component.ts` -- inventory grid + create/
  edit form.

## Data model (`avatars/{id}`)
```
{ id, name, description, glbPath, thumbnailPath?, defaultVoice,
  rigVersion?, meshStats?: {vertices,polygons,skeletonType}, sizeBytes?,
  createdAt, updatedAt }
```
- `id` is a slug of the name (e.g. "Aurora-01" -> "aurora-01"), so the GLB
  filename matches the id and the avatar-catalog dynamic discovery picks it up.
- Storage (consistent with the rest of the app): `avatars/models/{id}.glb`,
  `avatars/thumbnails/{id}.png`. URLs resolved at runtime via `getDownloadURL`
  (never token URLs).

## What it does (real)
- Inventory grid: thumbnail, name, description, default-voice chip, size chip,
  rig chip, Edit/Delete. Loading skeletons + empty state.
- Create/Edit: GLB dropzone -> upload with progress -> load into the 3D viewport;
  thumbnail upload; name; description; default-voice dropdown (from
  `PIPER_VOICES`); live Three.js preview (orbit/zoom/reset/fullscreen); **real**
  mesh metadata (vertices, polygons, skeleton type read from the loaded scene);
  **rig compatibility** (full / remapped / partial / incompatible via the same
  ARKit inspection the lipsync+gesture system uses) -- warns, never blocks;
  Save/Cancel -> `avatars/{id}`.
- Delete removes the doc + Storage model/thumbnail (best-effort).

## Decorative mockup elements OMITTED / stubbed (as instructed)
- Left nav Dashboard/Pipelines/Team/Billing and top nav Animations/Textures/
  Marketplace -> not built.
- "Pipeline Sequence" (Pre-flight/Binary Upload/Mesh Optimization/CDN) and
  "Optimization Profile / LOD Preserve" -> not implemented; only the real steps
  exist (upload -> load -> read stats -> save).
- Bottom stat tiles (Total Storage / Active Context / Avg Latency) -> omitted (no
  real metrics behind them).

## NOT here (belongs to assistants)
Persona / "Personality Core", RAG namespace, and "Live in Production" are
properties of an **assistant** (`assistants/{id}`), not an avatar. This form is
purely visual. The (separate, future) assistant editor would let you pick an
`avatarId` from this catalog and add persona + RAG + a voice override.

## Rules (added; dev-permissive, review before prod)
- `firestore.rules`: `match /avatars/{avatarId}` -- signed-in read/write (DEV);
  PROD admin block in comments.
- `storage.rules`: `avatars/models/**` + `avatars/thumbnails/**` -- public read,
  signed-in write (DEV); PROD admin-claim write in comments.

## Untouched
Text-Avatar, Gesture Studio, the avatar catalog/picker, gesture playback, and the
assistants/RAG flow are not modified. The viewer reuses the existing GLTFLoader +
rig-spec inspection; Storage paths + `getDownloadURL` resolution stay consistent.

## Redeploy (for the new rules)
```bash
firebase deploy --only firestore:rules,storage
```
(No Functions change for this feature.)
