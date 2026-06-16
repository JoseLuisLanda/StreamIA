# Text-Avatar — spoken summary + "Ver más" full-screen detail with PiP avatar

The avatar now speaks a concise ~120-word summary while the full long-form answer
is available on demand in a full-screen detail view, with the 3D avatar minimized
to a picture-in-picture corner.

## 1. chatRag: summary + detail (architecture)

`chatRag` now returns:

```json
{ "summary": "~120w, spoken", "detail": "full long-form, on-demand",
  "body": "= summary (back-compat)", "gestureCommands": "gesture-tagged SUMMARY",
  "media": [ ... ], "sources": [ ... ] }
```

- Length is controlled by the **prompt**, not by reducing retrieval: the same
  chunks are retrieved; a `SUMMARY_DETAIL_DIRECTIVE` instructs the model to emit
  `<<SUMMARY>>` (~120 words) + `<<DETAIL>>` (full), both grounded in the context.
  `extractSummaryDetail` parses them; markers are stripped. No markers -> the whole
  output is the summary (back-compat), detail empty.
- `gestureCommands` annotates the **summary** (the avatar speaks only the summary).
- The media-selection (`<<MEDIA:>>`) step is unchanged and runs alongside.

## 2. Client wiring

- `RagResponse`/`RagAvatarResponse` + `RagAvatarService.normalize` gain
  `summary`/`detail` (`body` mirrors `summary`).
- `ConvMessage` gains `detail`; `runRagTurn` stores `payload.detail` on the
  assistant message and speaks `body` (= summary) via the existing lead/body/tail
  + lipsync pipeline.

## 3. Chat card + full-screen detail + PiP avatar (Text-Avatar)

- The assistant card shows the summary + media thumbnails + a purple
  **"Ver más detalles →"** button, shown only when `detail` (or media) exists.
- Clicking opens a **full-screen overlay**: the question as title, the full detail
  text (paragraph-split, scrollable, dark/purple), and a larger media gallery.
- The 3D avatar **minimizes to a bottom-right picture-in-picture** (~220×165):
  this is a pure CSS resize of `.viewport` (adds `.pip`). `avatar-tts` observes
  its container via `ResizeObserver`, so the **existing canvas resizes** (camera
  aspect + renderer) — the GLB and WebGL state are preserved, never reloaded.
- A ✕ (overlay) and ⤢ (on the PiP) close the detail and restore the avatar to
  full size. Media opens large via the existing gallery popup (image full-size /
  video player / document download, prev/next, lazy fetch from Storage).

## 4. Avatar resize (technical)

Minimizing/restoring only changes the container size; the `ResizeObserver` in
`avatar-tts` updates `camera.aspect` + `renderer.setSize`. Nothing is destroyed or
recreated, so the cached GLB and animation/lipsync state survive the transition.

## Kept intact

Intent router (greetings/farewells still instant, no RAG), per-assistant config /
responses / namespace / LLM-profile resolution, media relevance, lead/body/tail,
lipsync/motion, neutral-pose transitions, and the global avatar cache — unchanged.

## Confirm

- The avatar speaks ONLY the concise summary (shorter speech).
- "Ver más detalles" reveals the full detail with NO re-query (it's stored on the
  message from the original response).
- The avatar minimizes to PiP and restores smoothly without reloading the model.
- Greetings/farewells still never hit the cloud function; all existing flows work.

## Notes

- If a provider ignores the markers, the whole answer becomes the summary and
  "Ver más" hides (unless media exists) — safe degradation.
- Build/deploy locally: `firebase deploy --only functions` + `ng build`.
