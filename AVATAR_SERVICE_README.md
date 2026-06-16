# Central AvatarService (memory + IndexedDB cache), /live fix, login -> /home

## Central AvatarService (`services/avatar.service.ts`)

The single place that resolves + caches avatar models. Resolution: read
`avatars/{id}` (Firestore, via `AvatarManagerService`) -> `glbPath`/`thumbnailPath`
-> download URL via `getDownloadURL` (NO hardcoded token URLs).

Two-layer global cache for the large GLBs (4.5-12 MB):

1. **In-memory** — resolved blob URL per `avatarId` (instant reuse across component
   switches; no re-resolve), version-checked against `avatar.updatedAt`.
2. **IndexedDB** — the GLB BINARY via the existing `ModelCacheService`, keyed by
   `glbPath#version`. Survives reloads -> no re-download. (Mirrors the gesture
   cache pattern.)

Read-through order: **memory -> IndexedDB -> Storage** (download + populate both).
Version-invalidation: a new `updatedAt` changes the key, re-downloads, and drops
the stale in-memory blob (revoked). On fetch/CORS failure it still returns a
working plain download URL (uncached) so loading never hard-fails.

Methods: `getAvatar(id)`, `listAvatars(force?)`, `resolveThumb(id)`,
`resolveModelUrl(id)` (= `loadModel(id)`, a GLTFLoader-ready cached URL),
`invalidate(id?)`.

## Components migrated

- **/text-avatar** — `selectAvatar` now resolves the model URL via
  `AvatarService.resolveModelUrl(id)` (cached) instead of a one-off
  `getDownloadURL`. (Blob URLs are no longer persisted to localStorage since they
  don't survive reloads; cold loads re-resolve from the assistant's `avatarId`.)
- **/live** — replaced the hardcoded `models.readyplayer.me` default URLs with the
  `avatars` collection via `AvatarService.listAvatars()` + `resolveModelUrl()`
  (cached). Legacy defaults remain only as a last resort if the catalog is empty;
  custom per-user avatars are kept. This fixes "error al cargar el avatar".
- **Avatar Manager** — already collection-based: it resolves `glbPath` via the
  manager service and feeds the resolved URL to its `glb-viewer` (URL-driven). No
  token URLs. (Left as-is; the viewer is a generic URL consumer.)
- **Gesture Studio** — a manual dev tool: you paste a GLB URL or pick a preview;
  `face-tracked-avatar`/`avatar-tts` are generic URL-driven viewers. Intentionally
  not id-resolved, so it stays URL-driven (no token URLs from the catalog).
- **/assistants** — thumbnails already resolve via the SDK (`getDownloadURL` in
  `AssistantConfigService`), not token URLs; unchanged.

The viewers (`avatar-tts`, `face-tracked-avatar`, `glb-viewer`) stay URL-driven;
the central service governs **id -> URL resolution + caching**, so every
id-resolving caller benefits from the shared cache and changing avatar loading is
a one-place change.

## What /live is for

`/live` is the "Avatar Live" studio (predates the assistants flow): a presentation
view to place/size an avatar over backgrounds/scenes with media overlays — not tied
to a single assistant. Intended avatar source after the fix: the shared `avatars`
catalog (first catalog entry selected by default), plus any custom user avatars.

## Login redirect

`login.component.ts -> navigateAfterLogin` now defaults to **`/home`** (was
`/live`). An explicit `?redirect=` (guarded deep link) is still honored; otherwise
both fresh login and already-authenticated entry land on `/home`.

## Confirm

- An avatar downloads once; subsequent loads (other components, and after a page
  reload) read from IndexedDB -> no re-download; in-session switches reuse the
  in-memory blob URL.
- `/live` loads avatars from the catalog via the service -> no more load error.
- Login lands on `/home`.

## Notes

- Invalidation is by `avatar.updatedAt`; re-uploading a model in Avatar Manager
  bumps it and forces a re-download on next resolve.
- Build/run locally (`ng build` / `ng serve`); not runnable in this environment.
