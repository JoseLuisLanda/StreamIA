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
import { resolveProfileForAssistant, resolveStageProfile, loadRagStageModels } from './lib/llm-profiles';
import { annotateGestures } from './lib/gestures';

const MAX_K = 8;
const DEFAULT_K = 6;
/** Token cap for the spoken STAGE-1 summary (2-3 sentences + optional media tag). */
const SUMMARY_MAX_TOKENS = 256;
/** Output-token cap for the on-demand DETAIL stage. */
const DETAIL_MAX_TOKENS = 768;

interface ChatRagBody {
  query?: string;
  namespace?: string;
  assistantId?: string;
  language?: string;
  k?: number;
  /**
   * Answer mode.
   *  - absent/'rag'    = fast STAGE 1: summary-only (+ gesture + media tags). NO detail.
   *  - 'capabilities'  = metadata-only answer (no findNearest/chunks/media).
   *  - 'detail'        = STAGE 2 on-demand: detail-only, reusing the SAME chunks as
   *                      stage 1 (passed back as chunkIds) -> no embed, no findNearest.
   */
  mode?: 'rag' | 'capabilities' | 'detail';
  /** STAGE 2: the chunk doc ids from stage 1's `sources` (keeps detail consistent). */
  chunkIds?: string[];
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
  // --- TIMING INSTRUMENTATION (no logic changes). Remove once the regression is found. ---
  const tStart = Date.now();
  const ms = (from: number): number => Date.now() - from;
  const stage = (label: string, from: number): void => console.log(`[chatRag.timing] ${label}: ${ms(from)} ms`);

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
  // Per-stage profile OVERRIDES read from the assistant doc (empty -> use global).
  let asstSummaryProfileId = '';
  let asstDetailProfileId = '';
  // Extra metadata used ONLY by capabilities mode (describe the assistant w/o RAG).
  const meta = { name: '', role: '', description: '', topicTag: '' };
  // Optional per-assistant custom capabilities prompt template (used only when the
  // capabilities flag is on). Read from the same doc -> zero extra reads, zero client trust.
  let capPromptTemplate = '';
  const mode = body.mode === 'capabilities' ? 'capabilities' : body.mode === 'detail' ? 'detail' : 'rag';
  const assistantId = (body.assistantId ?? '').trim();
  try {
    if (assistantId) {
      const dep = await db.collection('assistants').doc(assistantId).get();
      if (dep.exists) {
        namespace = (dep.get('ragCollection') || '').toString().trim(); // doc is authoritative
        persona = (dep.get('systemPrompt') || '').toString();
        llmProfileId = (dep.get('llmProfileId') || '').toString().trim();
        asstSummaryProfileId = (dep.get('summaryProfileId') || '').toString().trim();
        asstDetailProfileId = (dep.get('detailProfileId') || '').toString().trim();
        meta.name = (dep.get('name') || '').toString().trim();
        meta.role = (dep.get('role') || '').toString().trim();
        meta.description = (dep.get('description') || '').toString().trim();
        meta.topicTag = (dep.get('topicTag') || '').toString().trim();
        const ucr = (dep.get('useCustomResponses') || {}) as Record<string, unknown>;
        const cap = (dep.get('capabilities') || {}) as Record<string, unknown>;
        if (ucr['capabilities'] === true && typeof cap['promptTemplate'] === 'string') {
          capPromptTemplate = (cap['promptTemplate'] as string).trim();
        }
      }
    }
  } catch (e) {
    logger.warn('chatRag assistant lookup failed', { error: String(e) });
  }
  // Fallback to the client-provided namespace hint (static/dev assistants that
  // have no Firestore doc). When the assistant doc exists, its ragCollection wins.
  if (!namespace) namespace = (body.namespace ?? '').trim();
  stage('1 parse + assistant doc resolve', tStart);

  // === CAPABILITIES MODE: metadata-only, NO retrieval/chunks/media. ===
  // Answers "what can you do / what are you for" from the assistant doc only.
  // The whole retrieval + media-gathering pipeline below is never reached here.
  if (mode === 'capabilities') {
    await answerCapabilities(res, { assistantId, llmProfileId, persona, language, query, namespace, meta, promptTemplate: capPromptTemplate });
    return;
  }

  if (!namespace) {
    res.status(400).json({ error: 'namespace (or a assistantId resolving to one) is required' });
    return;
  }

  // Global per-stage default profiles (config/ragModels). One cheap read, shared
  // by stage-1 and the detail stage. Not loaded for capabilities mode (returned above).
  const stageModels = await loadRagStageModels();

  // === STAGE 2 (DETAIL) MODE: regenerate ONLY the full detail, reusing the SAME
  // chunks as stage 1 (passed as chunkIds) so it stays consistent. No embed, no
  // findNearest when ids are provided; one LLM call (detail-only). ===
  if (mode === 'detail') {
    await answerDetail(res, {
      assistantId, llmProfileId, persona, language, query, namespace,
      chunkIds: body.chunkIds ?? [], k, stage,
      overrideProfileId: asstDetailProfileId, globalProfileId: stageModels.detailProfileId,
    });
    return;
  }

  // --- Retrieval: per-namespace findNearest (no collectionGroup, no extra index) ---
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  let matched: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const tEmbed = Date.now();
    const queryVec = await embedText([query], 'RETRIEVAL_QUERY');
    stage('2 query embedding (embedText)', tEmbed);
    const vq = chunksCol.findNearest({
      vectorField: 'embedding',
      queryVector: FieldValue.vector(queryVec[0]),
      limit: k,
      distanceMeasure: 'COSINE',
    });
    const tFind = Date.now();
    const snap = await vq.get();
    stage('3 findNearest vector search', tFind);
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
    const tMedia = Date.now();
    candidates = await gatherDocMedia(namespace, collectDocIds(matched));
    // NOTE: gatherDocMedia does Firestore reads only (batched 'in' queries, <=10
    // docIds per query). It performs NO Storage signed-URL/binary downloads --
    // storagePath is returned as metadata and the bytes are fetched client-side.
    stage('4 doc-scoped media gather (Firestore reads only, no Storage downloads)', tMedia);
  } catch (e) {
    logger.warn('chatRag media gather failed', { namespace, error: String(e) });
  }

  // --- Generation. Produces a ~120w SUMMARY (spoken) + a full DETAIL (on demand),
  //     both grounded in the SAME retrieved chunks. Hard-fail (500) on error. ---
  let summary = '';
  let detailText = '';
  let chosenMediaIds: string[] = [];
  try {
    const tProfile = Date.now();
    // STAGE-1 profile: assistant summary override -> global summary default -> legacy.
    const { profile, source } = await resolveStageProfile({
      assistantId, overrideProfileId: asstSummaryProfileId,
      globalProfileId: stageModels.summaryProfileId, legacyProfileId: llmProfileId,
    });
    stage('5 LLM profile + active key resolution', tProfile);
    logger.info('chatRag: summary profile resolved', {
      assistantId, source, profile: profile.name, scope: profile.scope,
      provider: profile.provider, model: profile.model, mediaCandidates: candidates.length,
    });
    // STAGE 1: summary ONLY (+ media-selection directive when candidates exist).
    // The detail is deferred to the on-demand 'detail' stage, so this prompt is
    // short and the output is token-capped -> the avatar starts speaking fast.
    let genContext = context;
    let genPersona = `${persona ? persona + '\n\n' : ''}${SUMMARY_ONLY_DIRECTIVE}`;
    if (candidates.length) {
      const catalog = candidates.map((m) => `- ${m.id}: ${m.title}${m.description ? ' — ' + m.description : ''}`).join('\n');
      genContext = `${context}\n\n[MEDIA DISPONIBLE]\n${catalog}`;
      genPersona = `${genPersona}\n\n${MEDIA_DIRECTIVE}`;
    }
    // Cap output tokens for the spoken summary (clone keeps key/secret lookup intact).
    const summaryProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? SUMMARY_MAX_TOKENS, SUMMARY_MAX_TOKENS) };
    // ONE LLM call. Media relevance selection is IN-BAND (the model appends a
    // <<MEDIA: ids>> line parsed below) -- there is NO separate 2nd LLM call.
    const tGen = Date.now();
    const result = await generateFromProfile(summaryProfile, query, genContext, language, genPersona);
    stage(`6 STAGE-1 LLM generation (${profile.provider}/${profile.model}, summary-only + media-tag, capped, ONE call)`, tGen);
    const tParse = Date.now();
    const afterMedia = extractMediaSelection(result.text);
    chosenMediaIds = afterMedia.ids;
    const split = extractSummaryDetail(afterMedia.text);
    summary = split.summary;
    detailText = split.detail;
    stage('7 response parse (media-tag + summary/detail split; regex only, NO 2nd LLM call)', tParse);
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
  const tAssembly = Date.now();
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
  stage('8 gesture annotation + response assembly', tAssembly);
  // ONE LLM call total per request (the main generation). Media selection is in-band.
  console.log(`[chatRag.timing] TOTAL: ${ms(tStart)} ms (llmCalls=1, retrievedChunks=${matched.length}, mediaCandidates=${candidates.length})`);
}

/**
 * CAPABILITIES MODE handler: describe the assistant's purpose/capabilities using
 * ONLY the metadata read from assistants/{id} (name/role/description/topicTag +
 * namespace). It resolves the LLM profile + active key exactly like the RAG path,
 * but runs NO findNearest, NO chunk reads, and NO media gathering -- the only
 * latency is LLM generation. Returns the standard contract with empty media/sources.
 */
async function answerCapabilities(
  res: Response,
  args: {
    assistantId: string;
    llmProfileId: string;
    persona: string;
    language: string;
    query: string;
    namespace: string;
    meta: { name: string; role: string; description: string; topicTag: string };
    /** Optional per-assistant custom directive (replaces the default metadata prompt). */
    promptTemplate?: string;
  },
): Promise<void> {
  const { assistantId, llmProfileId, persona, language, query, namespace, meta, promptTemplate } = args;

  const metaContext = buildCapabilitiesContext(meta, namespace);
  let summary = '';
  let detailText = '';
  try {
    const { profile, source } = await resolveProfileForAssistant(assistantId, llmProfileId);
    logger.info('chatRag capabilities: profile resolved', {
      assistantId, source, profile: profile.name, scope: profile.scope, customTemplate: !!(promptTemplate && promptTemplate.trim()),
    });
    // Custom template (if configured) replaces the default metadata directive.
    // Still metadata-only, still NO retrieval.
    const directive = (promptTemplate && promptTemplate.trim()) ? promptTemplate.trim() : CAPABILITIES_DIRECTIVE;
    const genPersona =
      `${persona ? persona + '\n\n' : ''}${directive}\n\n${SUMMARY_DETAIL_DIRECTIVE}`;
    // Metadata is passed as CONTEXT so the grounded prompt scaffold treats it as
    // the only source. No retrieval is performed anywhere in this path.
    const result = await generateFromProfile(profile, query, metaContext, language, genPersona);
    const split = extractSummaryDetail(result.text);
    summary = split.summary;
    detailText = split.detail;
  } catch (e: any) {
    const m = e?.meta ?? {};
    const detail = e?.message ?? String(e);
    logger.error('chatRag capabilities generation failed', {
      assistantId, provider: m.provider, model: m.model, profile: m.profile, key: m.key, error: detail,
    });
    res.status(500).json({
      error: 'generation failed', provider: m.provider, model: m.model, profile: m.profile, key: m.key, detail,
    });
    return;
  }
  if (!summary) {
    summary = language === 'es'
      ? 'Puedo ayudarte con informacion sobre los temas de este asistente.'
      : "I can help you with information about this assistant's topics.";
  }
  let gestureCommands = summary;
  try {
    gestureCommands = annotateGestures(summary) || summary;
  } catch (e) {
    logger.warn('chatRag capabilities gesture annotation failed', { error: String(e) });
    gestureCommands = summary;
  }
  // No retrieval -> no media, no sources.
  res.json({ summary, detail: detailText, body: summary, gestureCommands, media: [], sources: [] });
}

/**
 * STAGE 2 (DETAIL) handler: regenerate ONLY the long-form detail for the SAME
 * question, reusing the SAME chunks as stage 1. Consistency is guaranteed by
 * fetching the exact chunk docs whose ids came back in stage 1's `sources`
 * (no embedding, no findNearest). Falls back to findNearest only if no ids are
 * provided. One LLM call (detail-only). Returns the standard contract with detail
 * filled and summary/media/sources empty.
 */
async function answerDetail(
  res: Response,
  args: {
    assistantId: string; llmProfileId: string; persona: string;
    language: string; query: string; namespace: string;
    chunkIds: string[]; k: number;
    /** Per-stage profile selection: assistant detail override + global detail default. */
    overrideProfileId?: string; globalProfileId?: string;
    stage: (label: string, from: number) => void;
  },
): Promise<void> {
  const { assistantId, llmProfileId, persona, language, query, namespace, chunkIds, k, stage } = args;

  // 1) Context: reuse the exact stage-1 chunks by id (no embed, no findNearest).
  let context = '';
  try {
    const tCtx = Date.now();
    if (chunkIds.length) {
      context = await fetchChunksByIds(namespace, chunkIds.slice(0, MAX_K));
      stage('D1 detail context: chunks by id (no embed, no findNearest)', tCtx);
    } else {
      // Fallback (stage-1 sent no ids): re-run retrieval so detail still works.
      const queryVec = await embedText([query], 'RETRIEVAL_QUERY');
      const vq = db.collection('rag').doc(namespace).collection('chunks').findNearest({
        vectorField: 'embedding', queryVector: FieldValue.vector(queryVec[0]), limit: k, distanceMeasure: 'COSINE',
      });
      const snap = await vq.get();
      context = snap.docs.map((d) => (d.get('text') ?? '').toString()).join('\n---\n');
      stage('D1 detail context: findNearest fallback (no chunkIds provided)', tCtx);
    }
  } catch (e) {
    logger.error('chatRag detail context failed', { namespace, error: String(e) });
    res.status(500).json({ error: 'detail retrieval failed' });
    return;
  }

  if (!context.trim()) {
    res.status(404).json({ error: 'no context for detail' });
    return;
  }

  // 2) Generate detail-only via the resolved DETAIL profile:
  //    assistant detail override -> global detail default -> legacy assistant profile.
  //    Goes through the standard profile -> createProvider -> generateAnswer path.
  let detailText = '';
  try {
    const genPersona = `${persona ? persona + '\n\n' : ''}${DETAIL_ONLY_DIRECTIVE}`;
    const tProfile = Date.now();
    const { profile, source } = await resolveStageProfile({
      assistantId, overrideProfileId: args.overrideProfileId,
      globalProfileId: args.globalProfileId, legacyProfileId: llmProfileId,
    });
    stage('D2 detail profile resolve', tProfile);
    logger.info('chatRag: detail profile resolved', {
      assistantId, source, profile: profile.name, provider: profile.provider, model: profile.model,
    });
    // Cap tokens for the detail stage (clone keeps key/secret lookup intact).
    const detailProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? DETAIL_MAX_TOKENS, DETAIL_MAX_TOKENS) };
    const tGen = Date.now();
    const result = await generateFromProfile(detailProfile, query, context, language, genPersona);
    stage(`D3 detail LLM generation (${profile.provider}/${profile.model}, ONE call)`, tGen);
    detailText = (result.text ?? '').trim();
  } catch (e: any) {
    const m = e?.meta ?? {};
    const detail = e?.message ?? String(e);
    logger.error('chatRag detail generation failed', {
      assistantId, namespace, provider: m.provider, model: m.model, profile: m.profile, key: m.key, error: detail,
    });
    res.status(500).json({ error: 'generation failed', provider: m.provider, model: m.model, profile: m.profile, key: m.key, detail });
    return;
  }

  // Detail is text-only and NOT spoken: no gesture tags, no media, no sources.
  res.json({ summary: '', detail: detailText, body: '', gestureCommands: '', media: [], sources: [] });
}

/** Fetch specific chunk docs by id and join their text (preserves request order). */
async function fetchChunksByIds(namespace: string, ids: string[]): Promise<string> {
  if (!ids.length) return '';
  const col = db.collection('rag').doc(namespace).collection('chunks');
  const refs = ids.map((id) => col.doc(id));
  const snaps = await db.getAll(...refs);
  const byId = new Map<string, string>();
  for (const s of snaps) {
    if (s.exists) byId.set(s.id, (s.get('text') ?? '').toString());
  }
  return ids.map((id) => byId.get(id) ?? '').filter(Boolean).join('\n---\n');
}

/** Build the metadata-only context block for capabilities mode (non-empty fields only). */
function buildCapabilitiesContext(
  meta: { name: string; role: string; description: string; topicTag: string },
  namespace: string,
): string {
  const lines: string[] = ['[ASISTENTE / ASSISTANT METADATA]'];
  if (meta.name) lines.push(`Nombre / Name: ${meta.name}`);
  if (meta.role) lines.push(`Rol / Role: ${meta.role}`);
  if (meta.description) lines.push(`Descripcion / Description: ${meta.description}`);
  if (meta.topicTag) lines.push(`Tema / Topic: ${meta.topicTag}`);
  if (namespace) lines.push(`Base de conocimiento / Knowledge base: ${namespace}`);
  return lines.join('\n');
}

/** Directive: describe purpose/capabilities from metadata ONLY (no invented specifics, no RAG). */
const CAPABILITIES_DIRECTIVE =
  'El usuario pregunta para que sirves o en que puede ayudarle este asistente. ' +
  'Responde describiendo tu proposito y los temas en los que puedes ayudar, usando UNICAMENTE ' +
  'los METADATA del asistente del CONTEXTO (nombre, rol, descripcion, tema, base de conocimiento). ' +
  'No inventes datos, cifras ni documentos especificos, y no consultes ninguna base de conocimiento. ' +
  'Si un metadato falta, simplemente omitelo. Tono natural, breve y cordial, en el mismo idioma de la pregunta.';

/**
 * STAGE 1 directive: summary ONLY. Short, spoken text -> minimal tokens -> fast.
 * No <<DETAIL>> section is requested here (detail is deferred to the detail stage).
 */
const SUMMARY_ONLY_DIRECTIVE =
  'Responde con un resumen MUY BREVE de 2 a 3 frases (aprox. 40 palabras), directo y claro, ' +
  'fundado UNICAMENTE en el CONTEXTO, sin saludos ni despedidas y sin marcadores. ' +
  'Este texto se hablara en voz alta, asi que escribelo natural y conciso, en el mismo idioma de la pregunta. ' +
  'No agregues una version larga ni secciones adicionales.';

/**
 * STAGE 2 directive: detail ONLY. Long-form analysis for the SAME question, grounded
 * in the SAME context as the summary. Text-only (not spoken); no markers.
 */
const DETAIL_ONLY_DIRECTIVE =
  'Genera un analisis COMPLETO y EXTENSO (varios parrafos) que amplie la respuesta breve, ' +
  'fundado UNICAMENTE en el CONTEXTO, sin saludos ni despedidas y sin marcadores. ' +
  'Escribelo en el mismo idioma de la pregunta. Este texto se mostrara como lectura (no se habla).';

/**
 * Directive that makes the model emit a short spoken SUMMARY + a full DETAIL,
 * both grounded in the CONTEXT. The summary is what the avatar speaks; the detail
 * is shown on demand ("Ver mas"). Output markers are stripped before display.
 * Still used by capabilities mode.
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