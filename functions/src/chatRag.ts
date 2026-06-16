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
import { generateFromProfile } from './lib/llm';
import { resolveProfileForAssistant } from './lib/llm-profiles';
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
  type: 'image' | 'video' | 'document';
  title: string;
  caption?: string;
  description?: string;
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
  let llmProfileId = '';
  const assistantId = (body.assistantId ?? '').trim();
  try {
    if (assistantId) {
      const dep = await db.collection('assistants').doc(assistantId).get();
      if (dep.exists) {
        namespace = (dep.get('ragCollection') || '').toString().trim(); // doc is authoritative
        persona = (dep.get('systemPrompt') || '').toString();
        llmProfileId = (dep.get('llmProfileId') || '').toString().trim();
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

  // --- Doc-scoped media candidates: gather media attached to the DOCUMENTS the
  // retrieved chunks came from. The LLM later picks which (if any) are relevant. ---
  let candidates: MediaOut[] = [];
  try {
    candidates = await gatherDocMedia(namespace, collectDocIds(matched));
  } catch (e) {
    logger.warn('chatRag media gather failed', { namespace, error: String(e) });
  }

  // --- Generation. Produces a ~120w SUMMARY (spoken) + a full DETAIL (on demand),
  //     both grounded in the SAME retrieved chunks. Hard-fail (500) on error. ---
  let summary = '';
  let detailText = '';
  let chosenMediaIds: string[] = [];
  try {
    const { profile, source } = await resolveProfileForAssistant(assistantId, llmProfileId);
    logger.info('chatRag: profile resolved', {
      assistantId, source, profile: profile.name, scope: profile.scope, mediaCandidates: candidates.length,
    });
    // Persona gets the summary/detail directive (always) + the media-selection
    // directive (when candidates exist). Context optionally gets the media catalog.
    let genContext = context;
    let genPersona = `${persona ? persona + '\n\n' : ''}${SUMMARY_DETAIL_DIRECTIVE}`;
    if (candidates.length) {
      const catalog = candidates.map((m) => `- ${m.id}: ${m.title}${m.description ? ' — ' + m.description : ''}`).join('\n');
      genContext = `${context}\n\n[MEDIA DISPONIBLE]\n${catalog}`;
      genPersona = `${genPersona}\n\n${MEDIA_DIRECTIVE}`;
    }
    const result = await generateFromProfile(profile, query, genContext, language, genPersona);
    const afterMedia = extractMediaSelection(result.text);
    chosenMediaIds = afterMedia.ids;
    const split = extractSummaryDetail(afterMedia.text);
    summary = split.summary;
    detailText = split.detail;
  } catch (e: any) {
    const meta = e?.meta ?? {};
    const detail = e?.message ?? String(e);
    logger.error('chatRag generation failed', {
      namespace,
      assistantId,
      provider: meta.provider,
      model: meta.model,
      profile: meta.profile,
      key: meta.key,
      error: detail,
    });
    res.status(500).json({
      error: 'generation failed',
      provider: meta.provider,
      model: meta.model,
      profile: meta.profile,
      key: meta.key,
      detail, // real underlying message (ownership / missing key / provider), for diagnosis
    });
    return;
  }
  if (!summary) {
    summary =
      language === 'es'
        ? 'No tengo informacion suficiente para responder eso.'
        : 'I do not have enough information to answer that.';
  }

  // --- Gesture tags annotate the SPOKEN summary (fail-soft -> plain summary). ---
  let gestureCommands = summary;
  try {
    gestureCommands = annotateGestures(summary) || summary;
  } catch (e) {
    logger.warn('chatRag gesture annotation failed', { error: String(e) });
    gestureCommands = summary;
  }

  // --- Media: only the candidates the LLM chose as relevant (order preserved). ---
  const media: MediaOut[] = chosenMediaIds.length
    ? chosenMediaIds.map((id) => candidates.find((c) => c.id === id)).filter((m): m is MediaOut => !!m)
    : [];
  logger.info('chatRag: media surfaced', { namespace, candidates: candidates.length, chosen: media.length });

  // body = summary (back-compat with existing consumers). detail is on-demand only.
  res.json({ summary, detail: detailText, body: summary, gestureCommands, media, sources });
}

/**
 * Directive that makes the model emit a short spoken SUMMARY + a full DETAIL,
 * both grounded in the CONTEXT. The summary is what the avatar speaks; the detail
 * is shown on demand ("Ver mas"). Output markers are stripped before display.
 */
const SUMMARY_DETAIL_DIRECTIVE =
  'Estructura tu respuesta EXACTAMENTE asi, sin saludos ni despedidas:\n' +
  'Primero una linea que diga <<SUMMARY>> y debajo un resumen MUY BREVE de 3 a 4 lineas ' +
  '(aprox. 40 palabras, 2-3 frases) — directo y claro; este texto se hablara en voz alta.\n' +
  'Despues una linea que diga <<DETAIL>> y debajo el analisis completo y extenso (varios parrafos), tambien fundado en el CONTEXTO.\n' +
  'Ambas secciones en el mismo idioma de la pregunta. No incluyas los marcadores dentro del texto hablado.';

/** Split the model output into { summary, detail } using the <<SUMMARY>>/<<DETAIL>> markers. */
function extractSummaryDetail(raw: string): { summary: string; detail: string } {
  const text = (raw ?? '').trim();
  const sumRe = /<<\s*SUMMARY\s*>>/i;
  const detRe = /<<\s*DETAIL\s*>>/i;
  const detMatch = text.match(detRe);
  if (!detMatch) {
    // No markers -> treat the whole thing as the summary (back-compat).
    return { summary: text.replace(sumRe, '').trim(), detail: '' };
  }
  const detIdx = detMatch.index ?? text.length;
  const summary = text.slice(0, detIdx).replace(sumRe, '').trim();
  const detail = text.slice(detIdx + detMatch[0].length).trim();
  return { summary: summary || detail, detail: summary ? detail : '' };
}

/** Directive appended to the persona so the model can select relevant media. */
const MEDIA_DIRECTIVE =
  'Si alguna de las MEDIA DISPONIBLE es util para la pregunta, agrega al FINAL de tu respuesta ' +
  'EXACTAMENTE una linea con el formato <<MEDIA: id1,id2>> listando solo los ids relevantes. ' +
  'Si ninguna aplica, NO agregues la linea. No menciones los ids dentro del texto hablado; puedes ' +
  'referirte a la media de forma natural (por ejemplo "tengo una imagen de esto").';

/** Unique docIds across the retrieved chunks (top-level docId or metadata.docId). */
function collectDocIds(matched: FirebaseFirestore.QueryDocumentSnapshot[]): string[] {
  const ids = new Set<string>();
  for (const d of matched) {
    const top = d.get('docId');
    if (typeof top === 'string' && top) ids.add(top);
    const md = (d.get('metadata') ?? {}) as Record<string, unknown>;
    const mdId = md['docId'];
    if (typeof mdId === 'string' && mdId) ids.add(mdId);
  }
  return [...ids];
}

/** Gather enabled media attached to the given documents (rag/{ns}/media, linkedDocId). */
async function gatherDocMedia(namespace: string, docIds: string[]): Promise<MediaOut[]> {
  if (!docIds.length) return [];
  const mediaCol = db.collection('rag').doc(namespace).collection('media');
  const out: MediaOut[] = [];
  // Firestore 'in' supports <=10 values; chunk the docIds.
  for (let i = 0; i < docIds.length; i += 10) {
    const batch = docIds.slice(i, i + 10);
    const snap = await mediaCol.where('linkedDocId', 'in', batch).get();
    for (const s of snap.docs) {
      const m = (s.data() ?? {}) as Record<string, unknown>;
      if (m['enabled'] === false) continue;
      const storagePath = m['storagePath'];
      if (typeof storagePath !== 'string' || !storagePath) continue;
      const t = m['type'];
      out.push({
        id: s.id,
        type: t === 'video' ? 'video' : t === 'document' ? 'document' : 'image',
        title: typeof m['title'] === 'string' ? (m['title'] as string) : '',
        caption: typeof m['caption'] === 'string' ? (m['caption'] as string) : (typeof m['description'] === 'string' ? (m['description'] as string) : undefined),
        description: typeof m['description'] === 'string' ? (m['description'] as string) : undefined,
        storagePath,
        thumbnailPath: typeof m['thumbnailPath'] === 'string' ? (m['thumbnailPath'] as string) : undefined,
      });
    }
  }
  // Stable order by the optional `order` field is lost here (snapshot order); the
  // LLM picks specific ids, so final ordering follows the model's id list.
  return out.slice(0, 24);
}

/** Strip the trailing <<MEDIA: ...>> tag and return the chosen ids + clean text. */
function extractMediaSelection(raw: string): { text: string; ids: string[] } {
  const text0 = raw ?? '';
  const m = text0.match(/<<\s*MEDIA\s*:\s*([^>]*)>>/i);
  if (!m) return { text: text0.trim(), ids: [] };
  const ids = m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const text = text0.replace(m[0], '').trim();
  return { text, ids };
}