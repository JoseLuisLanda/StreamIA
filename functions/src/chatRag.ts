/**
 * chatRag -- informational-avatar RAG endpoint (rewritten from scratch).
 *
 * Body-only answer + inline gesture tags + media metadata, scoped to a single
 * namespace's chunks via Firestore vector search. Signed-in users only (NO role
 * to answer). Reads exclusively from strimearia. No premium/preview gating, no
 * chat_history, no greeting/closing, no inline [n] citations, no terapia default.
 *
 * Mounted by api.ts as POST /chatRag (behind validateFirebaseIdToken).
 *
 * Request:  { query, namespace?, assistantId?, language?='es', k?=6 }
 * Response: { body, gestureCommands, media[], sources[] }
 */
import type { Response } from 'express';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import type { AuthedRequest } from './lib/http-auth';
import { embedText } from './lib/embeddings';
import { generateAnswerWithMeta } from './lib/llm';
import { annotateGestures } from './lib/gestures';

const MAX_K = 8;
const DEFAULT_K = 6;

interface ChatRagBody {
  query?: string;
  namespace?: string;
  assistantId?: string;
  language?: string;
  k?: number;
}

interface MediaOut {
  id: string;
  type: 'image' | 'video';
  title: string;
  caption?: string;
  storagePath: string;
  thumbnailPath?: string;
}

export async function chatRagHandler(req: AuthedRequest, res: Response): Promise<void> {
  // Auth is guaranteed by validateFirebaseIdToken (req.user set). Defensive:
  if (!req.user?.uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  const body = (req.body ?? {}) as ChatRagBody;
  const query = (body.query ?? '').trim();
  const language = body.language || 'es';
  const k = Math.min(Math.max(1, Math.floor(body.k ?? DEFAULT_K)), MAX_K);

  if (!query) {
    res.status(400).json({ error: 'query is required' });
    return;
  }

  // Resolve namespace + persona from the assistant (server-side, so the client
  // cannot tamper with the namespace or the persona). Explicit namespace wins for
  // retrieval scoping; persona comes from assistants/{assistantId}.systemPrompt.
  let namespace = '';
  let persona = '';
  try {
    if (body.assistantId) {
      const dep = await db.collection('assistants').doc(body.assistantId).get();
      if (dep.exists) {
        namespace = (dep.get('ragCollection') || '').toString().trim(); // doc is authoritative
        persona = (dep.get('systemPrompt') || '').toString();
      }
    }
  } catch (e) {
    logger.warn('chatRag assistant lookup failed', { error: String(e) });
  }
  // Fallback to the client-provided namespace hint (static/dev assistants that
  // have no Firestore doc). When the assistant doc exists, its ragCollection wins.
  if (!namespace) namespace = (body.namespace ?? '').trim();
  if (!namespace) {
    res.status(400).json({ error: 'namespace (or a assistantId resolving to one) is required' });
    return;
  }

  // --- Retrieval: per-namespace findNearest (no collectionGroup, no extra index) ---
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  let matched: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const queryVec = await embedText([query], 'RETRIEVAL_QUERY');
    const vq = chunksCol.findNearest({
      vectorField: 'embedding',
      queryVector: FieldValue.vector(queryVec[0]),
      limit: k,
      distanceMeasure: 'COSINE',
    });
    const snap = await vq.get();
    matched = snap.docs;
  } catch (e) {
    logger.error('chatRag retrieval failed', { namespace, error: String(e) });
    res.status(500).json({ error: 'retrieval failed' });
    return;
  }

  // Sanity: 0 results but non-empty collection -> 503; empty collection -> 404.
  if (!matched.length) {
    let any = false;
    try {
      const probe = await chunksCol.limit(1).get();
      any = !probe.empty;
    } catch {
      /* treat as empty */
    }
    res.status(any ? 503 : 404).json({
      error: any ? 'no relevant context found' : 'namespace has no ingested content',
    });
    return;
  }

  const context = matched.map((d) => (d.get('text') ?? '').toString()).join('\n---\n');
  const sources = matched.map((d) => ({ id: d.id, metadata: d.get('metadata') ?? {} }));

  // --- Generation (body-only). Hard-fail (500) if we can't produce a body. ---
  // The provider/model come from config/llm (Secret-Manager key); default is
  // Gemini-Vertex. On failure we surface the REAL provider error (status +
  // message) to the logs AND the response so the 500 is diagnosable, instead of
  // the old generic "generation failed" that hid the root cause.
  let answer: string;
  try {
    const result = await generateAnswerWithMeta(query, context, language, persona);
    answer = result.text;
  } catch (e: any) {
    const meta = e?.meta ?? {};
    const detail = e?.message ?? String(e);
    logger.error('chatRag generation failed', {
      namespace,
      provider: meta.provider,
      model: meta.model,
      error: detail,
    });
    res.status(500).json({
      error: 'generation failed',
      provider: meta.provider,
      model: meta.model,
      detail, // real underlying provider message (status + body), for diagnosis
    });
    return;
  }
  if (!answer) {
    answer =
      language === 'es'
        ? 'No tengo informacion suficiente para responder eso.'
        : 'I do not have enough information to answer that.';
  }

  // --- Gesture tags (fail-soft -> plain body) ---
  let gestureCommands = answer;
  try {
    gestureCommands = annotateGestures(answer) || answer;
  } catch (e) {
    logger.warn('chatRag gesture annotation failed', { error: String(e) });
    gestureCommands = answer;
  }

  // --- Media metadata (fail-soft -> []) ---
  let media: MediaOut[] = [];
  try {
    media = await resolveMedia(namespace, matched);
  } catch (e) {
    logger.warn('chatRag media resolution failed', { namespace, error: String(e) });
    media = [];
  }

  res.json({ body: answer, gestureCommands, media, sources });
}

/** Collect media ids referenced by matched chunks and resolve their metadata. */
async function resolveMedia(
  namespace: string,
  matched: FirebaseFirestore.QueryDocumentSnapshot[],
): Promise<MediaOut[]> {
  const ids = new Set<string>();
  for (const d of matched) {
    const md = (d.get('metadata') ?? {}) as Record<string, unknown>;
    const refs = (md['mediaIds'] ?? md['media'] ?? []) as unknown;
    if (Array.isArray(refs)) {
      for (const r of refs) if (typeof r === 'string') ids.add(r);
    }
  }
  if (!ids.size) return [];

  const mediaCol = db.collection('rag').doc(namespace).collection('media');
  const snaps = await Promise.all([...ids].slice(0, 12).map((id) => mediaCol.doc(id).get()));
  const out: MediaOut[] = [];
  for (const s of snaps) {
    if (!s.exists) continue;
    const m = (s.data() ?? {}) as Record<string, unknown>;
    const storagePath = m['storagePath'];
    if (typeof storagePath !== 'string' || !storagePath) continue;
    const title = m['title'];
    const caption = m['caption'];
    const thumb = m['thumbnailPath'];
    out.push({
      id: s.id,
      type: m['type'] === 'video' ? 'video' : 'image',
      title: typeof title === 'string' ? title : '',
      caption: typeof caption === 'string' ? caption : undefined,
      storagePath,
      thumbnailPath: typeof thumb === 'string' ? thumb : undefined,
    });
  }
  return out;
}