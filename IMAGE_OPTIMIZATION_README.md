# Global image optimization (compression + thumbnails) + RAG media integration

A reusable, client-side image optimization service used app-wide, integrated into
the RAG Admin per-document media-attach flow so attached images upload as
compressed WebP + thumbnails. No duplicated compression logic.

## 1. `ImageOptimizationService` (global singleton, upload-agnostic)

`src/app/services/image-optimization.service.ts` — Canvas API only (no deps),
pure transformation (returns blobs + metadata, never uploads):

- `optimizeImage(file, opts?)` -> `{ blob, width, height, bytes }`
- `generateThumbnail(file|blob, opts?)` -> same
- `optimizeWithThumbnail(file, opts?)` -> `{ full, thumb, originalBytes }`
- `isOptimizableImage(file)` -> raster jpg/png/webp/bmp guard

Quality-preserving defaults: full = longest side <= **2048px**, **WebP q0.8**;
thumbnail = longest side **~360px**, WebP q0.7. Aspect ratio preserved; PNG/alpha
-> WebP keeps transparency; EXIF/metadata stripped by the canvas re-encode; never
upscales; returns the **original if the re-encode isn't smaller**
(`keepOriginalIfSmaller`). Everything is overridable via opts, so a caller can
just do `optimizeWithThumbnail(file)`. WebP `toBlob` failures fall back to
JPEG/PNG automatically. Decode uses `createImageBitmap` with an
`HTMLImageElement` fallback.

## 2. RAG Admin per-document attachment (integration)

In RAG Admin (assistant -> namespace -> Documents -> "Media (N)"):

- Choose type (Imagen/Video/Documento) + **Título** + **Descripción** (the
  description is what the LLM uses to pick relevance + the caption) + file ->
  Adjuntar.
- **Images**: `attachMedia` calls `optimizeWithThumbnail(file)` -> optimized WebP
  full + WebP thumb, uploaded together. UI shows **"Optimizando imagen..."** and
  the before/after size (e.g. `8.2 MB -> 740 KB (+ thumb 22 KB)`). A
  **"Conservar original"** checkbox bypasses compression. **Graceful fallback**:
  if optimization throws, the original is uploaded instead of blocking.
- **Video / documents**: uploaded as-is (no client compression; transcoding is
  server-side / out of scope).
- Upload goes to `rag-media/{namespace}/{docId}/` with progress; the record stores
  `storagePath` (full) + `thumbnailPath` (thumb) + `type/title/description/order/
  enabled/linkedDocId/namespace`. List/edit/delete/reorder + enable toggle +
  lazy thumbnails; the document row shows the **Media (N)** count.

## 3. Reuse

- **Avatar Manager** thumbnail upload now optimizes via the same service
  (`optimizeImage`, 512px WebP) before upload — single shared path, graceful
  fallback. Future image uploads should call `ImageOptimizationService` rather
  than re-implementing compression.

## 4. Data model (unchanged from the doc-media feature)

Flat `rag/{namespace}/media/{mediaId}` with `linkedDocId` (documented choice);
files at `rag-media/{namespace}/{docId}/{file}`. Metadata-only records; bytes
fetched from Storage via SDK on open.

## 5. Consumption (unchanged)

`chatRag` gathers media from the retrieved chunks' `docId`s, the LLM selects
relevant ids (via descriptions), and returns `media[]` with `storagePath` /
`thumbnailPath`. The client renders preview cards (thumbnail + title) and a lazy
popup (image full-size / video player / document download). These now consume the
optimized WebP full + thumbnails produced here — smaller payloads, fast-loading
thumbnails. No change to that flow.

## Confirm

- The optimization service is global and reused (RAG media + Avatar Manager) with
  no duplicated logic.
- Large photos attach far smaller (WebP, capped 2048px) with no visible quality
  loss; "Conservar original" bypasses it; failures fall back to the original.
- Thumbnails (~360px WebP) load fast in chat previews.
- Media stays scoped to its document; non-image media (video/docs) is unaffected.

## Notes

- WebP is supported by all current evergreen browsers; the JPEG/PNG fallback
  covers the rare exception.
- Build/run locally; not runnable in this environment.
