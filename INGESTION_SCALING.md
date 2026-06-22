# Ingestion scaling (strimearia)

How `ingestDocument` handles document size today, and the path for much larger
corpora later. All figures are approximate.

## Current scale (A + B) -- implemented

The synchronous `ingestDocument` callable handles current-scale documents,
including a full Bible (~5.5 MB, hundreds of chunks), inside one execution.

- **A. Runtime limits** -- `timeoutSeconds: 540` (the callable maximum) and
  `memory: '2GiB'` (more CPU + headroom). Changing these requires a redeploy:
  `firebase deploy --only functions:ingestDocument`.
- **B. No per-chunk network bottleneck** -- token counting is **batched**: one
  Vertex `CountTokens` call per embedding-batch (all the batch's chunks in a
  single request), not one per chunk. A single probe decides if CountTokens is
  available; if not, a conservative char estimate (~2.5 chars/token, ~12000-token
  pack budget) is used for packing only. Real per-chunk token counts come free
  from the `:predict` response (`statistics.token_count`) and are stored on each
  chunk. Embedding requests run with **bounded concurrency** to cut wall-clock
  time without exceeding Vertex rate limits or the 20000-token-per-request cap.

This keeps the real-token batching that fixed the HTTP 400, removes the timeout
cause, and preserves pericopal auto-detection + per-document strategy persistence.

## Future scale (C) -- NOT implemented (path only)

If much larger corpora are ingested later (e.g. multi-hundred-MB documents, or
batch-loading many large books) a single 540s execution will not be enough.
Move to an asynchronous, resumable pipeline:

1. **Enqueue, do not process inline.** The upload/ingest request validates input,
   writes the document record with `status: 'queued'`, and enqueues a job
   (Cloud Tasks or a Firestore-triggered/Pub-Sub worker) instead of doing the
   work in the request.
2. **Background worker processes in time-bounded batches.** A worker function
   chunks + counts + embeds a slice of the document per invocation, each slice
   sized to finish comfortably under the time limit, then schedules the next
   slice (self-continuation via Cloud Tasks) until done.
3. **Incremental status + progress.** The document record advances
   `queued -> processing` and carries a progress field (e.g.
   `{ chunksWritten, chunksTotal, lastOffset }`) updated after each slice, so the
   admin UI can show a live progress bar; final state is `done` (or `error` with a
   resumable cursor).
4. **Idempotent + resumable.** Each slice keys its chunk doc ids deterministically
   (`{docId}_{index}`) so a retried slice overwrites rather than duplicates, and a
   crashed job resumes from `lastOffset`.

A + B is sufficient for today's documents; C is the upgrade path when document or
corpus size outgrows a single function execution.
