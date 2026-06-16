# Document-scoped media — attach media to a PDF, surfaced by relevance in chat

Admins attach images/videos/documents to a SPECIFIC document (PDF) within an
assistant's namespace. When a question retrieves chunks from that document, its
attached media becomes a candidate; the LLM chooses which (if any) are relevant
and returns them as previewable cards openable in a popup (Gemini/ChatGPT-style).

## Model (chosen: flat with docId link)

`rag/{namespace}/media/{mediaId}` with `linkedDocId` pointing at the document:

```
{ id, type: 'image'|'video'|'document', title, description, caption?,
  storagePath, thumbnailPath?, namespace, linkedDocId, order?, enabled?, createdAt }
```

- **`description`** is what the LLM reads to decide relevance (and is the caption).
- Files in Storage at **`rag-media/{namespace}/{docId}/{file}`** (metadata-only
  records; the client fetches bytes from Storage via SDK on open — no token URLs).
- Media is attached to the DOCUMENT, not to chunks (cryptic) and not free-floating.

## Retrieval + relevance (chatRag)

1. After `findNearest`, collect the retrieved chunks' `docId`s (top-level + metadata).
2. `gatherDocMedia` fetches enabled media whose `linkedDocId` is in those docIds
   (Firestore `in`, chunked by 10).
3. The candidate catalog (`id: title — description`) is appended to the generation
   context, and a directive is appended to the persona: the model adds a trailing
   `<<MEDIA: id1,id2>>` line listing only the relevant ids (or nothing).
4. `extractMediaSelection` strips that tag from the spoken body and returns the
   chosen ids; `media[]` returns only those items (order = the model's id list).
   If the model picks none, `media[]` is empty — no dump.

Body-only contract preserved: the tag is stripped, ids never appear in prose, and
the avatar may reference media naturally ("tengo una imagen de esto").

## RAG Admin — attach per document

Documents tab → each row has a **Media (n)** toggle opening an inline panel:
choose type (image/video/document), title, **description**, pick a file → Adjuntar
(progress). Lists attached media with type/title/description, enable toggle, and
delete. Files upload to `rag-media/{namespace}/{docId}/`.

## Client preview + popup

The returned `media[]` renders via the existing media-gallery: thumbnail+title
cards under the answer; clicking opens the lazy popup — images full-size, videos in
a player, and **documents** show an icon + "Abrir / Descargar" link (blob fetched
via SDK on open). Loading and 🔒 unauthorized states are handled.

## Files

- `lib/rag/rag-admin.models.ts` — MediaType += 'document'; RagMediaRecord += description/order/enabled.
- `services/rag-admin.service.ts` — uploadMedia (docId folder + description/order), listMediaByDoc, toMedia mapper.
- `functions/src/chatRag.ts` — collectDocIds, gatherDocMedia, MEDIA_DIRECTIVE, extractMediaSelection; media[] = LLM-chosen.
- `pages/rag-admin/rag-admin.component.ts` — per-document media panel.
- `components/media-gallery/...` + `lib/rag/rag.models.ts` — 'document' type card + popup download.

## Storage / rules

`rag-media/**` is already covered by the existing Storage rules (signed-in write in
dev). No new Firestore rule needed (`rag/{ns}/**` covers the media subcollection).
Deploy: `firebase deploy --only functions,storage`.

## Confirm

- Attaching media to a specific PDF makes it surface ONLY when that document is
  retrieved AND the LLM deems it useful (via the `<<MEDIA:>>` selection).
- Surfaced media previews as cards in chat and opens in a popup (image/video inline,
  document downloadable).
- Unrelated questions / unchosen media → no cards.

## Notes / limitations

- The model must emit the `<<MEDIA:>>` tag for media to surface; the directive is
  appended only when candidates exist. Providers that ignore it simply surface no
  media (safe).
- Build/deploy run locally; not runnable here.
