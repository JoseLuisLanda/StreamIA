# Avatar Catalog & Picker — Avatar Live (`/text-avatar`)

A data-driven avatar catalog for the Avatar Live screen. Instead of a hardcoded
GLB URL, the avatar is chosen from a curated list backed by Firebase Storage,
with a canonical-rig **normalization layer** so avatars from different sources
all drive the same gesture + lipsync channels.

---

## What was added

| File | Purpose |
|------|---------|
| `src/app/lib/avatars/avatar-catalog.ts` | Typed catalog model + the 3 initial avatars (metadata only — no signed URLs). |
| `src/app/lib/avatars/rig-spec.ts` | Canonical rig spec (ARKit-52 + head bone), alias maps, and `buildNormalizedRig()` → canonical→actual mapping + conformance report. |
| `src/app/services/avatar-catalog.service.ts` | Resolves Storage paths → download URLs at runtime; tracks selection + per-avatar rig reports. |
| `src/app/components/avatar-tts/avatar-tts.component.ts` | *(modified)* Inspects each loaded GLB, normalizes morph/bone names, logs + emits the rig report. |
| `src/app/pages/text-avatar/text-avatar.component.ts` | *(modified)* Thumbnail-grid picker in Settings, hot-swap loading, conformance badge, manual Load kept as dev/fallback. |
| `storage.rules` + `firebase.json` | Public read on `avatars/**`, owner-only write. |
| `tools/inspect-avatar-rig.mjs` | Standalone Node GLB inspector to generate the per-avatar report offline. |

The original *AR with face tracking* module (`ar-mask`, `ar-face-tracking`, the
`live` page) is **untouched**.

---

## How it works

### 1. Catalog (metadata, not loaders)

```ts
// src/app/lib/avatars/avatar-catalog.ts
{
  id: 'alex-ia',
  name: 'Alex',
  storagePath: 'avatars/publicar3d@gmail.com/alex-ia.glb',
  thumbnail: 'avatars/preview/alex-ia.png',
  rigVersion: 'arkit-52-v1',
  defaultVoice: 'es_MX-claude-high',
}
```

Adding an avatar later = **one entry** in `AVATAR_CATALOG`.

### 2. Runtime URL resolution (no hardcoded tokens)

`AvatarCatalogService.resolveGlbUrl()` calls
`getDownloadURL(ref(storage, storagePath))` on demand. Signed `?token=` URLs are
never stored in source, so token rotation can't break the catalog. A per-entry
`fallbackUrl` is used only if Storage resolution throws (local/offline testing).

The Firebase app/config is reused from the existing **Strimearia** setup
(`firebase.config.ts` → `firebase-client.ts`); nothing new to initialize.

### 3. Picker UI + hot-swap

Open **⚙️ Settings → Avatar**: a 3-up thumbnail grid (generic person icon until
`avatars/preview/*.png` thumbnails are uploaded). Selecting an avatar resolves its
URL and updates `[avatarUrl]`, which hot-reloads the model in the running
`<app-avatar-tts>` without tearing down the gesture/lipsync pipeline. The last
selection is persisted in `localStorage` and restored on load. The manual **Load**
URL field remains for dev/fallback.

### 4. Canonical rig + normalization (the important part)

The gesture studio and lipsync are written against **one canonical rig**:

- **Morphs:** the 52 Apple **ARKit** blendshapes (`jawOpen`, `mouthSmileLeft`,
  `browInnerUp`, `eyeBlinkLeft`, …) — exactly what RPM exports with
  `?morphTargets=ARKit` and what every viseme/gesture channel references.
- **Bones:** a `Head` bone (+ optional `Neck`, `Spine`/`Spine1`/`Spine2`).

On load, `buildNormalizedRig()`:

1. Collects every mesh that has morph targets (not just `Wolf3D_*`), so non-RPM
   avatars work too.
2. Maps each canonical ARKit name → the avatar's **actual** morph name via
   (a) exact match, (b) slug match (casing / separators / `_L`↔`Left`), then
   (c) an explicit alias table (`mouthOpen`→`jawOpen`, `eyesClosed_L`→
   `eyeBlinkLeft`, Character-Creator `A25_Jaw_Open`, etc.).
3. Resolves `Head/Neck/Spine` bones across naming schemes (RPM, `mixamorig*`,
   `CC_Base_*`, `J_Bip_*`).
4. Produces a **conformance report** classified as `full` / `remapped` /
   `partial` / `incompatible`, with explicit warnings.

The renderer then writes canonical weights through the map
(`morphMap.get(canonicalKey) ?? canonicalKey`). **Result:** custom gestures
recorded against one avatar's ARKit morphs replay on another avatar via the same
mapping. If a target morph is missing it's simply skipped (graceful degradation —
mouth may drop out but head motion continues) rather than failing silently.

---

## Per-avatar compatibility report

The three GLBs (`alex-ia`, `r-ai-ban`, `yisus`) live in the Strimearia bucket and
require auth/public-read to fetch, so the **actual** morph/bone names are reported
**at runtime**. Two ways to get the report:

**A. In-app (authoritative).** Open `/text-avatar`, pick each avatar, open the
browser console. Each load logs:

```
[avatar-tts] model loaded — Conforms via remapping
  morph meshes: Wolf3D_Head, Wolf3D_Teeth
  total morphs: 52 | matched ARKit: 52/52 | remapped: 0
  bones: {"Head":"Head","Neck":"Neck","Spine":"Spine",...}
  ✓ no warnings
```

The Settings panel also shows a conformance badge + warnings per avatar.

**B. Offline (no app).** Download the GLBs and run:

```bash
node tools/inspect-avatar-rig.mjs alex-ia.glb r-ai-ban.glb yisus.glb
# or: node tools/inspect-avatar-rig.mjs ./folder-with-glbs
```

### Expected outcomes by source

| Avatar source | Likely verdict | Action |
|---|---|---|
| Ready Player Me (`?morphTargets=ARKit`) | **full** | none — already canonical |
| Character Creator / iClone, VRoid Perfect-Sync | **remapped** | handled by alias table |
| Mixamo-rigged / viseme-only body scans | **partial / incompatible** | head motion kept; mouth degrades — add aliases if needed |

If an avatar comes back `partial`/`incompatible`, copy its `all morph names`
list from the report and add the missing mappings to `MORPH_ALIASES` in
`rig-spec.ts` (one line per canonical name).

---

## Configuration

### Firebase / Storage

- Config: `src/app/firebase.config.ts` (Strimearia project — already populated).
- **Deploy the public-read rule** so the picker can resolve URLs without login:
  ```bash
  firebase deploy --only storage
  ```
  `storage.rules` grants `read: if true` on `avatars/**` and owner-only write.
- CORS for direct `fetch()` of GLBs is already configured via `cors.json`.

### TTS provider / API keys

Voice is unchanged from Avatar Live. Each catalog entry can set a `defaultVoice`
(e.g. `es_MX-claude-high`) that is preselected on switch **if** that voice id
exists in `PIPER_VOICES`. Piper runs locally (no key). Web Speech uses OS voices.
LLM keys live in Settings and are stored only in `localStorage` (local testing).

### Adding an avatar

1. Upload `name.glb` to `avatars/<email>/name.glb`.
2. (Optional) Upload `avatars/preview/<id>.png` for the thumbnail.
3. Add one entry to `AVATAR_CATALOG`.

---

## Known limitations

- **Thumbnails** `avatars/preview/*` are not populated yet → the picker shows a
  generic person icon until they exist (expected).
- **Cache key** is the resolved download URL (incl. token); when a token rotates
  the local IndexedDB cache misses and re-downloads once. Functionally harmless.
- **Viseme-only avatars** (no ARKit mouth morphs) can't get full lipsync from the
  ARKit-based viseme map; they degrade to head motion. A viseme→viseme path could
  be added later if such an avatar appears.
- **Conformance** is only known **after** an avatar has been loaded once
  (badge fills in on first selection).
- The offline `inspect-avatar-rig.mjs` verdict is a quick approximation (mouth +
  bones); the in-app report is authoritative (it also checks gesture morphs).
- Switching avatars mid-utterance hot-reloads the model; in-flight audio finishes
  but the new face starts from idle (no cross-fade).
```
