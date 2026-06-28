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
import { annotateGestures, stripGestureTags } from './lib/gestures';
import { GESTURES_BODY_ENABLED } from './lib/flags';
import { recordUsage } from './lib/usage';
import { consumeOneQuota, ConsumeResult, QUOTA_COUNTS_DETAIL_SEPARATELY } from './lib/quota';
import { getHandler } from './lib/response-contracts/registry';
import { plainHandler } from './lib/response-contracts/plain.handler';
import { DEFAULT_PLAIN_CONTRACT } from './lib/response-contracts/types';
import type { HandlerContext, ResponseContract, ResponseSegment, ChunkLite, MediaLite, SourceLite, NormalizedAnswer } from './lib/response-contracts/types';

const MAX_K = 8;
const DEFAULT_K = 6;
/** DETAIL stage retrieval breadth: the deep stage runs its OWN, broader findNearest
 *  (more chunks than the summary's k) so it has genuinely MORE material to expand on,
 *  not just the summary's ~6 chunks rephrased. Default; overridable per assistant
 *  (assistants/{id}.detailK) or globally (config/ragModels.detailK). Clamped to DETAIL_MAX_K. */
const DEFAULT_DETAIL_K = 12;
const DETAIL_MAX_K = 30;
/** DEFAULT token cap for the spoken STAGE-1 summary. Overridable per assistant
 *  (assistants/{id}.summaryMaxTokens) or globally (config/ragModels.summaryMaxTokens).
 *  Tuned +20% (160 -> 192) so the summary can include brief supporting detail
 *  (names/examples/context) from the retrieved chunks, not just the headline fact.
 *  NOTE: this value is being TUNED to observe the TTS/lipsync time-to-first-word and
 *  animation-delay tradeoff, since the summary is spoken -- a larger cap can delay the
 *  first audible word. Adjust down if responsiveness suffers. */
const SUMMARY_MAX_TOKENS = 170;
/** DEFAULT output-token cap for the on-demand DETAIL stage. Overridable per assistant
 *  (assistants/{id}.detailMaxTokens) or globally (config/ragModels.detailMaxTokens).
 *  Raised 768 -> 1536 so the deep stage can enumerate a full list (e.g. 12 items with
 *  their attributes) without being cut off. The detail is NOT spoken and is shown on
 *  demand, so a larger cap here does NOT affect TTS time-to-first-word. */
const DETAIL_MAX_TOKENS = 1250;
/** Output-token cap for the SUGGESTIONS stage (3 short follow-up prompts as JSON). */
const SUGGESTIONS_MAX_TOKENS = 128;
/** Category-explore (Grabovoi): max COSINE distance for a query to count as "in the
 *  catalog". Above this -> fall through to the normal rag path (honest decline). */
const CATEGORY_RELEVANCE_MAX = 0.65;
/** EXPLORE: how many example condition names the avatar SPEAKS (short -> fast TTS). */
const EXPLORE_SPOKEN_EXAMPLES = 4;
/** EXPLORE: how many condition names are returned as tappable follow-up CHIPS. */
const EXPLORE_CHIPS_MAX = 15;
/** Fixed retrieval seed for the METHOD chunks (cleansing + daily macrocommand + how-to). */
const PROTOCOL_METHOD_SEED = 'limpieza del pasado macrocomando diario como aplicar el protocolo pasos generales del metodo';

/** Grabovoi intent decided by the LLM classifier (replaces the old regex gate):
 *  - protocol : full protocol/method to APPLY something (steps, how-to).
 *  - catalog  : the code/sequence of ONE named condition, OR a vague "what do you have for X".
 *  - list     : an explicit list/enumeration of several sequences for a topic.
 *  - concept  : a definition / "what is / what does X mean" question. */
type GrabovoiIntent = 'protocol' | 'catalog' | 'list' | 'concept';
/** Classifier result: the route + the extracted TOPIC (subject of the query, no question words).
 *  The topic feeds the DETERMINISTIC list handler so codes are matched/scanned by code, never
 *  invented or mis-associated by the LLM. */
interface GrabovoiIntentResult { mode: GrabovoiIntent; topic: string; }
/** Cheap JSON classification prompt. Routing + topic extraction ONLY; execution stays
 *  deterministic (verbatim codes, chunk scan, anti-hallucination unchanged). */
const GRABOVOI_CLASSIFY_DIRECTIVE =
  'Eres un clasificador para un catalogo de secuencias numericas (Grabovoi). Devuelve SOLO un objeto ' +
  'JSON valido, sin texto extra ni bloques de codigo, con esta forma: ' +
  '{"mode":"protocol|catalog|list|concept","topic":"<tema principal en pocas palabras, SIN las ' +
  'palabras de pregunta>"}. ' +
  'mode=protocol = pide un protocolo o metodo COMPLETO para aplicar/usar algo (pasos, como se aplica). ' +
  'mode=catalog = pide el codigo/secuencia de UNA condicion nombrada (ej. el codigo del amor) O ' +
  'pregunta de forma vaga que tienes para un tema (ej. algo para los ojos). ' +
  'mode=list = pide explicitamente una lista o enumeracion de varias/todas las secuencias de un tema ' +
  '(ej. dame una lista, que codigos hay para X, todas las que sirvan para X). ' +
  'mode=concept = pregunta que es, que significa o pide una explicacion de un termino. ' +
  'topic = el tema/condicion al que se refiere (ej. para "que codigos hay para dolor de muelas" -> ' +
  '"dolor de muelas"). Si no hay un tema claro, topic = "".';

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
   *  - 'suggestions'   = 3 follow-up prompts, reusing the SAME chunks (chunkIds) ->
   *                      no embed, no findNearest. Separate async call after the summary.
   *  - 'textual_quote' = serve the LITERAL passage by reference (verbatim verses in
   *                      order, NOT rewritten by the LLM). For scripture-style content.
   */
  mode?: 'rag' | 'capabilities' | 'detail' | 'suggestions' | 'textual_quote';
  /** Per-query knowledge-mode override (beats the assistant default). */
  knowledgeMode?: 'rag_only' | 'hybrid' | 'training_only';
  /** STAGE 2: the chunk doc ids from stage 1's `sources` (keeps detail consistent). */
  chunkIds?: string[];
  /** Category-explore follow-up: the chunk ids of the category just shown in EXPLORE.
   *  EXACT-CODE resolves WITHIN these first, so a condition named right after the list
   *  maps to that category (no fresh, possibly-wrong-category semantic search). */
  categoryChunkIds?: string[];
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
  // Knowledge mode: rag_only (default) | hybrid | training_only. Plus an optional
  // per-assistant relevance-threshold override for hybrid. Read from the same doc.
  let asstKnowledgeMode = '';
  let asstRelevanceThreshold: number | null = null;
  // Optional per-assistant spoken-summary token cap override (config value).
  let asstSummaryMaxTokens: number | null = null;
  // Optional per-assistant DETAIL (Ver mas) token cap override (config value).
  let asstDetailMaxTokens: number | null = null;
  // Optional per-assistant DETAIL retrieval breadth override (config value).
  let asstDetailK: number | null = null;
  // Category-explore behavior (Grabovoi): on a general/category request, list the
  // category's condition NAMES and ask which one (no code); a specific condition gets
  // its verbatim code. Off by default; enabled per assistant (assistants/{id}.categoryExplore).
  let asstCategoryExplore = false;
  // Per-assistant response contract (config-driven assistant TYPE). Absent -> plain
  // (today's behavior). Read server-side so the client cannot tamper with it.
  let contract: ResponseContract = DEFAULT_PLAIN_CONTRACT;
  const mode = body.mode === 'capabilities' ? 'capabilities'
    : body.mode === 'detail' ? 'detail'
    : body.mode === 'suggestions' ? 'suggestions'
    : body.mode === 'textual_quote' ? 'textual_quote'
    : 'rag';
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
        asstKnowledgeMode = (dep.get('knowledgeMode') || '').toString().trim();
        const rt = Number(dep.get('relevanceThreshold'));
        if (Number.isFinite(rt)) asstRelevanceThreshold = rt;
        const smt = Number(dep.get('summaryMaxTokens'));
        if (Number.isFinite(smt) && smt > 0) asstSummaryMaxTokens = Math.floor(smt);
        const dmt = Number(dep.get('detailMaxTokens'));
        if (Number.isFinite(dmt) && dmt > 0) asstDetailMaxTokens = Math.floor(dmt);
        const dk = Number(dep.get('detailK'));
        if (Number.isFinite(dk) && dk > 0) asstDetailK = Math.floor(dk);
        asstCategoryExplore = dep.get('categoryExplore') === true;
        const rc = dep.get('responseContract');
        if (rc && typeof rc === 'object' && typeof (rc as Record<string, unknown>)['kind'] === 'string') {
          contract = rc as ResponseContract;
        }
      }
    }
  } catch (e) {
    logger.warn('chatRag assistant lookup failed', { error: String(e) });
  }
  // Fallback to the client-provided namespace hint (static/dev assistants that
  // have no Firestore doc). When the assistant doc exists, its ragCollection wins.
  if (!namespace) namespace = (body.namespace ?? '').trim();

  // Knowledge mode resolution: query override -> assistant default -> rag_only.
  const KM_VALID = ['rag_only', 'hybrid', 'training_only'];
  const bodyKm = (body.knowledgeMode ?? '').toString();
  const knowledgeMode: 'rag_only' | 'hybrid' | 'training_only' =
    (KM_VALID.includes(bodyKm) ? bodyKm
      : KM_VALID.includes(asstKnowledgeMode) ? asstKnowledgeMode
      : 'rag_only') as 'rag_only' | 'hybrid' | 'training_only';
  // Per-query resolution trace (verify the override wins + retrieval is skipped for
  // training_only). retrievalRan: training_only never calls findNearest.
  logger.info('chatRag knowledge_mode_resolved', {
    phase: 'knowledge_mode_resolved',
    requestedOverride: bodyKm || null,
    assistantDefault: asstKnowledgeMode || null,
    resolvedMode: knowledgeMode,
    retrievalRan: knowledgeMode !== 'training_only',
  });
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
    // Detail is part of the same interaction -> no quota by default (flag-gated).
    if (QUOTA_COUNTS_DETAIL_SEPARATELY) {
      const qr = await consumeOneQuota(req.user.uid);
      if (!qr.ok) { res.status(429).json({ error: 'quota_exhausted', remaining: 0 }); return; }
    }
    // DETAIL cap: per-assistant override -> global default -> code default.
    const detailMaxTokens = asstDetailMaxTokens
      ?? (typeof stageModels.detailMaxTokens === 'number' ? stageModels.detailMaxTokens : DETAIL_MAX_TOKENS);
    // DETAIL retrieval breadth: per-assistant -> global -> code default, clamped.
    const detailKResolved = asstDetailK
      ?? (typeof stageModels.detailK === 'number' ? stageModels.detailK : DEFAULT_DETAIL_K);
    const detailK = Math.min(Math.max(1, Math.floor(detailKResolved)), DETAIL_MAX_K);
    await answerDetail(res, {
      assistantId, llmProfileId, persona, language, query, namespace,
      chunkIds: body.chunkIds ?? [], k, stage,
      overrideProfileId: asstDetailProfileId, globalProfileId: stageModels.detailProfileId,
      detailMaxTokens, detailK,
    });
    return;
  }

  // === SUGGESTIONS MODE: generate 3 short follow-up prompts from the SAME stage-1
  // chunks (passed as chunkIds) -- no embed, no findNearest. Reuses the SUMMARY profile.
  // Called by the client AFTER the summary (separate, async request) so the summary
  // speed is untouched. Never hard-fails: returns { suggestions: [] } on any error so
  // the client falls back to its static chips. ===
  if (mode === 'suggestions') {
    // Suggestions are part of the same interaction -> no quota by default (flag-gated).
    if (QUOTA_COUNTS_DETAIL_SEPARATELY) {
      const qr = await consumeOneQuota(req.user.uid);
      if (!qr.ok) { res.status(429).json({ error: 'quota_exhausted', remaining: 0 }); return; }
    }
    await answerSuggestions(res, {
      assistantId, llmProfileId, persona, language, query, namespace,
      chunkIds: body.chunkIds ?? [], k, stage,
      overrideProfileId: asstSummaryProfileId, globalProfileId: stageModels.summaryProfileId,
    });
    return;
  }

  // === QUOTA GATE (rag interaction = 1 unit). Atomic check-and-decrement BEFORE
  // any retrieval or LLM call, so an exhausted account never triggers paid work.
  // Concurrent requests can't double-spend (Firestore transaction). ===
  let quota: ConsumeResult;
  try {
    quota = await consumeOneQuota(req.user.uid);
  } catch (e) {
    logger.error('chatRag quota check failed', { uid: req.user.uid, error: String(e) });
    res.status(500).json({ error: 'quota check failed' });
    return;
  }
  if (!quota.ok) {
    res.status(429).json({ error: 'quota_exhausted', remaining: 0 });
    return;
  }

  // === TEXTUAL-QUOTE MODE: serve the LITERAL passage by reference (verbatim verses
  // in order, NOT rewritten by the LLM). Falls back to normal rag if no verse
  // markers / reference can be resolved. Consumes 1 quota unit (gated above). ===
  // Skip the verbatim path under training_only (no retrieval/knowledge base) so the
  // assistant never serves "scripture" from memory; it falls through to the training
  // path whose directive forbids fabricating/completing verses.
  if (mode === 'textual_quote' && knowledgeMode !== 'training_only') {
    const served = await answerTextualQuote(res, {
      assistantId, namespace, query, language, k, quota, stage,
    });
    if (served) return;
    // not a resolvable scripture reference -> fall through to normal rag below.
  }

  // === GRABOVOI ROUTING (sequence_catalog). A literal code in the query -> DETERMINISTIC
  // reverse lookup (no LLM). Otherwise an LLM classifier picks the route ONCE (this replaces
  // the old brittle regex gate): protocol -> protocol assembly; catalog -> EXACT-CODE/EXPLORE;
  // list/concept -> normal RAG. The classifier ONLY routes; execution stays deterministic
  // (verbatim codes, chunk scan, anti-hallucination unchanged). ===
  const sequenceCatalogActive = asstCategoryExplore || contract.kind === 'sequence_catalog';
  if (sequenceCatalogActive && mode === 'rag' && knowledgeMode !== 'training_only') {
    const queriedCode = extractQueriedCode(query);
    if (queriedCode) {
      // Reverse lookup: scan chunks VERBATIM for the literal code (no LLM, no category dump).
      const served = await answerReverseLookup(res, { namespace, queriedCode, language, quota, stage });
      if (served) return;
    } else {
      // No literal code -> classify intent + extract TOPIC ONCE with the LLM (cheap).
      const intent = await classifyGrabovoiIntent({
        assistantId, overrideProfileId: asstSummaryProfileId,
        globalProfileId: stageModels.summaryProfileId, legacyProfileId: llmProfileId,
        query, language, stage,
      });
      const gMode = intent?.mode ?? null;
      logger.info('chatRag grabovoi_intent', { assistantId, mode: gMode, topic: intent?.topic ?? '' });
      if (gMode === 'protocol') {
        const detMax = asstDetailMaxTokens
          ?? (typeof stageModels.detailMaxTokens === 'number' ? stageModels.detailMaxTokens : DETAIL_MAX_TOKENS);
        const built = await answerProtocolAssembly(res, {
          assistantId, llmProfileId, persona, language, query, namespace, k, quota,
          overrideProfileId: asstDetailProfileId, globalProfileId: stageModels.detailProfileId,
          detailMaxTokens: detMax, stage,
        });
        if (built) return;
      } else if (gMode === 'list' || gMode === 'catalog') {
        // Topic codes are SELECTED deterministically (by name match -> correct topic, no
        // mis-association), then the LLM REFORMULATES them into a natural summary + protocol
        // using only that focused context (codes guarded verbatim). Returns false only when
        // there is no usable topic to match on.
        const tlDetMax = asstDetailMaxTokens
          ?? (typeof stageModels.detailMaxTokens === 'number' ? stageModels.detailMaxTokens : DETAIL_MAX_TOKENS);
        const served = await answerTopicList(res, {
          assistantId, llmProfileId, persona, namespace, topic: intent?.topic || '', language, quota,
          overrideProfileId: asstDetailProfileId, globalProfileId: stageModels.detailProfileId,
          detailMaxTokens: tlDetMax, stage,
        });
        if (served) return;
        // No usable topic (vague "que tienes?") -> category-explore (EXACT name match / chips).
        if (gMode === 'catalog') {
          const ex = await answerCategoryExplore(res, {
            namespace, query, k, quota, stage, categoryChunkIds: body.categoryChunkIds ?? [],
          });
          if (ex) return;
        }
      }
      // 'concept' | null (classify failed) | list-with-no-topic -> normal RAG path (honest prose).
    }
  }

  // --- KNOWLEDGE MODE: rag_only | hybrid | training_only ---
  // training_only SKIPS retrieval entirely (no embed, no findNearest -> saves cost
  // + latency). rag_only/hybrid retrieve; hybrid then compares the best chunk's
  // score to a relevance threshold to decide chunks-vs-training. `useTraining`
  // means: answer from the model's training (clearly flagged), no chunks/media.
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  const relevanceThreshold = asstRelevanceThreshold
    ?? (typeof stageModels.relevanceThreshold === 'number' ? stageModels.relevanceThreshold : DEFAULT_RELEVANCE_THRESHOLD);
  let matched: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let useTraining = false;
  let bestScore: number | null = null;
  let retrievalPassed = false;

  if (knowledgeMode === 'training_only') {
    useTraining = true; // no retrieval at all
  } else {
    try {
      const tEmbed = Date.now();
      const queryVec = await embedText([query], 'RETRIEVAL_QUERY');
      stage('2 query embedding (embedText)', tEmbed);
      const vq = chunksCol.findNearest({
        vectorField: 'embedding',
        queryVector: FieldValue.vector(queryVec[0]),
        limit: k,
        distanceMeasure: 'COSINE',
        // Ask Firestore to return the COSINE DISTANCE so we can threshold it.
        // COSINE distance: LOWER = more similar (0 identical .. 2 opposite).
        distanceResultField: 'vectorDistance',
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

    if (matched.length) {
      // Results are sorted closest-first, so the first doc carries the best score.
      const d0 = Number(matched[0].get('vectorDistance'));
      bestScore = Number.isFinite(d0) ? d0 : null;
      // pass when the best chunk is close enough (distance <= threshold).
      retrievalPassed = bestScore != null && bestScore <= relevanceThreshold;
    }

    if (knowledgeMode === 'hybrid') {
      // hybrid: good retrieval -> chunks; weak/none -> training fallback.
      useTraining = !retrievalPassed;
    } else {
      // rag_only: must answer from chunks; 0 results -> decline (unchanged).
      if (!matched.length) {
        let any = false;
        try { any = !(await chunksCol.limit(1).get()).empty; } catch { /* empty */ }
        res.status(any ? 503 : 404).json({
          error: any ? 'no relevant context found' : 'namespace has no ingested content',
        });
        return;
      }
      retrievalPassed = true;
    }
  }

  // Per-query log so the threshold can be tuned from real data.
  logger.info('chatRag knowledge_mode', {
    phase: 'knowledge_mode', namespace, mode: knowledgeMode,
    retrievalPassed, bestScore, threshold: relevanceThreshold, useTraining,
  });

  // Build context/sources/media ONLY when answering from chunks.
  const context = useTraining ? '' : matched.map((d) => (d.get('text') ?? '').toString()).join('\n---\n');
  const sources = useTraining ? [] : matched.map((d) => ({ id: d.id, metadata: d.get('metadata') ?? {} }));

  // --- Doc-scoped media candidates (only in the chunk-grounded path). ---
  let candidates: MediaOut[] = [];
  if (!useTraining) {
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
  }

  // --- Generation. Produces a ~120w SUMMARY (spoken) + a full DETAIL (on demand),
  //     both grounded in the SAME retrieved chunks. Hard-fail (500) on error. ---
  let summary = '';
  let detailText = '';
  let chosenMediaIds: string[] = [];
  let segments: ResponseSegment[] | undefined;
  // Captured for lightweight usage tracking (estimated tokens; recorded AFTER res.json).
  let usageSummary: { model: string; provider: string; prompt: string; output: string } | null = null;
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
    // STAGE 1 via the response-contract HANDLER. 'plain' = today's behavior, byte-
    // identical (SUMMARY_ONLY/TRAINING + MEDIA directive + [MEDIA DISPONIBLE] catalog,
    // <<MEDIA>> + <<SUMMARY>>/<<DETAIL>> parse). Non-plain kinds run the same
    // buildPrompt -> LLM -> parse -> validate -> normalize, and on any validate/parse
    // failure FALL BACK to the plain handler so the user never sees a raw error.
    const handler = getHandler(contract.kind);
    const handlerChunks: ChunkLite[] = matched.map((d) => ({
      id: d.id, text: (d.get('text') ?? '').toString(), metadata: d.get('metadata') ?? {},
    }));
    const handlerCtx: HandlerContext = {
      query, language, persona, contract, context,
      chunks: handlerChunks,
      candidates: candidates as unknown as MediaLite[],
      sources: sources as SourceLite[],
      useTraining,
    };
    const built = handler.buildPrompt(handlerCtx);
    // Cap output tokens for the spoken summary (clone keeps key/secret lookup intact).
    // Spoken-summary cap: per-assistant override -> global default -> code default.
    const summaryMaxTokens = asstSummaryMaxTokens
      ?? (typeof stageModels.summaryMaxTokens === 'number' ? stageModels.summaryMaxTokens : SUMMARY_MAX_TOKENS);
    const summaryProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? summaryMaxTokens, summaryMaxTokens) };
    // ONE LLM call. Media relevance selection is IN-BAND (the model appends a
    // <<MEDIA: ids>> line parsed by the handler) -- there is NO separate 2nd LLM call.
    const tGen = Date.now();
    const result = await generateFromProfile(summaryProfile, query, built.genContext, language, built.genPersona);
    stage(`6 STAGE-1 LLM generation (${profile.provider}/${profile.model}, ${handler.kind}, capped, ONE call)`, tGen);
    const tParse = Date.now();
    let normalized: NormalizedAnswer;
    try {
      const parsed = handler.parse(result.text);
      const v = handler.validate(parsed, handlerChunks);
      if (!v.ok && handler.kind !== 'plain') {
        logger.warn('chatRag contract validation failed -> plain fallback', { kind: handler.kind, reason: v.reason });
        normalized = plainHandler.normalize(plainHandler.parse(result.text), handlerCtx);
      } else {
        normalized = handler.normalize(parsed, handlerCtx);
      }
    } catch (he) {
      logger.warn('chatRag handler error -> plain fallback', { kind: handler.kind, error: String(he) });
      normalized = plainHandler.normalize(plainHandler.parse(result.text), handlerCtx);
    }
    summary = normalized.summary;
    detailText = normalized.detail;
    chosenMediaIds = normalized.media.map((m) => m.id);
    segments = normalized.segments;
    usageSummary = {
      model: profile.model, provider: profile.provider,
      prompt: `${built.genPersona}\n${built.genContext}\n${query}`, output: result.text,
    };
    stage('7 response parse (contract handler parse/validate/normalize; regex only, NO 2nd LLM call)', tParse);
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
  // Body gestures OFF (debug): strip any stray tags from the SPOKEN summary.
  if (!GESTURES_BODY_ENABLED) summary = stripGestureTags(summary);

  // --- Inline BODY gesture tags annotate the SPOKEN summary (fail-soft -> plain).
  //     GESTURES_BODY_ENABLED on  -> annotate (client gets tagged gestureCommands).
  //     GESTURES_BODY_ENABLED off -> gestureCommands = clean summary (no tags). ---
  const tAssembly = Date.now();
  let gestureCommands = summary;
  if (GESTURES_BODY_ENABLED) {
    try {
      gestureCommands = annotateGestures(summary) || summary;
    } catch (e) {
      logger.warn('chatRag gesture annotation failed', { error: String(e) });
      gestureCommands = summary;
    }
  }

  // --- Media: only the candidates the LLM chose as relevant (order preserved). ---
  const media: MediaOut[] = chosenMediaIds.length
    ? chosenMediaIds.map((id) => candidates.find((c) => c.id === id)).filter((m): m is MediaOut => !!m)
    : [];
  logger.info('chatRag: media surfaced', { namespace, candidates: candidates.length, chosen: media.length });

  // body = summary (back-compat with existing consumers). detail is on-demand only.
  // quota: post-decrement balance + any warn threshold this interaction crossed.
  res.json({
    summary, detail: detailText, body: summary, gestureCommands, media, sources,
    // Stage-2 detail is ALWAYS fetchable here: RAG turns reuse the chunk ids; training
    // turns (no sources) expand from general knowledge. The client shows "Ver mas".
    detailAvailable: true,
    // OPTIONAL: contract handlers may emit per-segment spoken/display units. Absent
    // for plain (the client then keeps spoken == display == summary, today's render).
    ...(segments && segments.length ? { segments } : {}),
    quota: { remaining: quota.remaining, allocated: quota.allocated, used: quota.used, warnThresholds: quota.warnThresholds, warnCrossed: quota.warnCrossed },
  });
  // Usage tracking (estimated, AFTER the response so it never adds latency).
  if (usageSummary) {
    void recordUsage(assistantId, {
      stage: 'summary', model: usageSummary.model, provider: usageSummary.provider,
      promptText: usageSummary.prompt, outputText: usageSummary.output,
      countQuery: true, embedQuery: query, vectorReads: matched.length,
    });
  }
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
  let usageCap: { model: string; provider: string; prompt: string; output: string } | null = null;
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
    usageCap = {
      model: profile.model, provider: profile.provider,
      prompt: `${genPersona}\n${metaContext}\n${query}`, output: result.text,
    };
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
  if (usageCap) {
    void recordUsage(assistantId, {
      stage: 'capabilities', model: usageCap.model, provider: usageCap.provider,
      promptText: usageCap.prompt, outputText: usageCap.output, countQuery: true,
    });
  }
}

/**
 * STAGE 2 (DETAIL) handler: regenerate ONLY the long-form detail for the SAME
 * question. The detail runs its OWN, BROADER retrieval (detailK > the summary's k)
 * via findNearest for the same query, so it has genuinely MORE material to go deeper
 * rather than rephrasing the summary's ~6 chunks. Empty chunkIds => stage 1 ran in
 * TRAINING mode -> the detail answers from general knowledge (no retrieval). One LLM
 * call (detail-only). Returns the standard contract with detail filled and
 * summary/media/sources empty.
 */
async function answerDetail(
  res: Response,
  args: {
    assistantId: string; llmProfileId: string; persona: string;
    language: string; query: string; namespace: string;
    chunkIds: string[]; k: number;
    /** Per-stage profile selection: assistant detail override + global detail default. */
    overrideProfileId?: string; globalProfileId?: string;
    /** Resolved output-token cap for this detail call (per-assistant/global/default). */
    detailMaxTokens?: number;
    /** Resolved retrieval breadth for the detail's OWN findNearest (> summary k). */
    detailK?: number;
    stage: (label: string, from: number) => void;
  },
): Promise<void> {
  const { assistantId, llmProfileId, persona, language, query, namespace, chunkIds, stage } = args;

  // 1) Context: the detail runs its OWN, BROADER retrieval (detailK > summary k) for the
  //    SAME query -- NOT a reuse of the summary's chunk ids -- so it has genuinely MORE
  //    material to go deeper instead of rephrasing the same ~6 chunks. Empty chunkIds =>
  //    stage 1 ran in TRAINING mode (training_only/hybrid fallback) -> general knowledge,
  //    no retrieval, no 404.
  let context = '';
  let docChunks = 0;
  const useTrainingDetail = chunkIds.length === 0;
  const detailK = Math.min(Math.max(1, Math.floor(args.detailK ?? DEFAULT_DETAIL_K)), DETAIL_MAX_K);
  try {
    const tCtx = Date.now();
    if (!useTrainingDetail) {
      const queryVec = await embedText([query], 'RETRIEVAL_QUERY');
      const vq = db.collection('rag').doc(namespace).collection('chunks').findNearest({
        vectorField: 'embedding', queryVector: FieldValue.vector(queryVec[0]),
        limit: detailK, distanceMeasure: 'COSINE',
      });
      const snap = await vq.get();
      docChunks = snap.size;
      context = snap.docs.map((d) => (d.get('text') ?? '').toString()).join('\n---\n');
      stage(`D1 detail context: broader findNearest (detailK=${detailK}, got ${docChunks})`, tCtx);
    } else {
      stage('D1 detail context: TRAINING (general knowledge, no retrieval)', tCtx);
    }
  } catch (e) {
    logger.error('chatRag detail context failed', { namespace, error: String(e) });
    res.status(500).json({ error: 'detail retrieval failed' });
    return;
  }

  // Cost/visibility: detail chunk count + estimated input tokens (CHARS_PER_TOKEN ~3).
  // Lets us see whether a thin detail is narrow retrieval (docChunks < detailK -> source
  // has little on the topic) or just limited budget. NOT for training (no retrieval).
  if (!useTrainingDetail) {
    logger.info('chatRag detail_retrieval', {
      phase: 'detail_retrieval', namespace, detailK, docChunks,
      inputTokens: Math.ceil(context.length / 3),
    });
  }

  // Only RAG-grounded detail requires context; training detail uses general knowledge.
  if (!useTrainingDetail && !context.trim()) {
    res.status(404).json({ error: 'no context for detail' });
    return;
  }

  // 2) Generate detail-only via the resolved DETAIL profile:
  //    assistant detail override -> global detail default -> legacy assistant profile.
  //    Goes through the standard profile -> createProvider -> generateAnswer path.
  let detailText = '';
  let usageDetail: { model: string; provider: string; prompt: string; output: string } | null = null;
  try {
    const detailDirective = useTrainingDetail ? DETAIL_TRAINING_DIRECTIVE : DETAIL_ONLY_DIRECTIVE;
    const genPersona = `${persona ? persona + '\n\n' : ''}${detailDirective}`;
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
    const detailCap = args.detailMaxTokens && args.detailMaxTokens > 0 ? args.detailMaxTokens : DETAIL_MAX_TOKENS;
    const detailProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? detailCap, detailCap) };
    const tGen = Date.now();
    const result = await generateFromProfile(detailProfile, query, context, language, genPersona);
    stage(`D3 detail LLM generation (${profile.provider}/${profile.model}, ONE call)`, tGen);
    detailText = (result.text ?? '').trim();
    // Detail is TEXT-ONLY (never spoken) -> always strip any gesture tags, regardless
    // of the body flag, so the "Ver mas" text never shows markup.
    detailText = stripGestureTags(detailText);
    usageDetail = {
      model: profile.model, provider: profile.provider,
      prompt: `${genPersona}\n${context}\n${query}`, output: result.text ?? '',
    };
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
  if (usageDetail) {
    void recordUsage(assistantId, {
      stage: 'detail', model: usageDetail.model, provider: usageDetail.provider,
      promptText: usageDetail.prompt, outputText: usageDetail.output,
    });
  }
}

/**
 * SUGGESTIONS stage: produce exactly 3 short follow-up prompts grounded in the SAME
 * stage-1 chunks (reused by id -- no embed, no findNearest, same cheap pattern as detail).
 * Reuses the SUMMARY profile/model. Never hard-fails: any error or unparsable output ->
 * { suggestions: [] } (HTTP 200) so the client cleanly falls back to its static chips.
 */
async function answerSuggestions(
  res: Response,
  args: {
    assistantId: string; llmProfileId: string; persona: string;
    language: string; query: string; namespace: string;
    chunkIds: string[]; k: number;
    overrideProfileId?: string; globalProfileId?: string;
    stage: (label: string, from: number) => void;
  },
): Promise<void> {
  const { assistantId, llmProfileId, persona, language, query, namespace, chunkIds, stage } = args;

  // Reuse the EXACT stage-1 chunks by id (no embed, no findNearest). If none were
  // provided, skip generation and return empty (client keeps its static chips).
  let context = '';
  try {
    const tCtx = Date.now();
    if (chunkIds.length) {
      context = await fetchChunksByIds(namespace, chunkIds.slice(0, MAX_K));
      stage('S1 suggestions context: chunks by id (no embed, no findNearest)', tCtx);
    }
  } catch (e) {
    logger.warn('chatRag suggestions context failed', { namespace, error: String(e) });
  }
  if (!context.trim()) { res.json({ suggestions: [] }); return; }

  let suggestions: string[] = [];
  let usageSug: { model: string; provider: string; prompt: string; output: string } | null = null;
  try {
    const genPersona = `${persona ? persona + '\n\n' : ''}${SUGGESTIONS_DIRECTIVE}`;
    const tProfile = Date.now();
    const { profile, source } = await resolveStageProfile({
      assistantId, overrideProfileId: args.overrideProfileId,
      globalProfileId: args.globalProfileId, legacyProfileId: llmProfileId,
    });
    stage('S2 suggestions profile resolve (reuses summary profile)', tProfile);
    logger.info('chatRag: suggestions profile resolved', {
      assistantId, source, profile: profile.name, provider: profile.provider, model: profile.model,
    });
    const sugProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? SUGGESTIONS_MAX_TOKENS, SUGGESTIONS_MAX_TOKENS) };
    const tGen = Date.now();
    const result = await generateFromProfile(sugProfile, query, context, language, genPersona);
    stage(`S3 suggestions LLM generation (${profile.provider}/${profile.model}, ONE call)`, tGen);
    suggestions = parseSuggestions(result.text);
    usageSug = {
      model: profile.model, provider: profile.provider,
      prompt: `${genPersona}\n${context}\n${query}`, output: result.text ?? '',
    };
  } catch (e: any) {
    const m = e?.meta ?? {};
    logger.warn('chatRag suggestions generation failed (returning empty -> client falls back)', {
      assistantId, namespace, provider: m.provider, model: m.model, error: e?.message ?? String(e),
    });
    suggestions = [];
  }
  res.json({ suggestions });
  if (usageSug) {
    void recordUsage(assistantId, {
      stage: 'suggestions', model: usageSug.model, provider: usageSug.provider,
      promptText: usageSug.prompt, outputText: usageSug.output,
    });
  }
}

// ============================ TEXTUAL-QUOTE PATH ============================
// Serve the LITERAL passage by reference -- verbatim verses in order, NOT rewritten
// by the LLM. Reference-aware retrieval: findNearest lands in the passage region,
// then we expand by chunk DOC ID (`${docId}_${index}`) across the chapter so a
// multi-chunk passage comes back complete and ordered. No semantic-only ranking.

interface ParsedRef { chapter: number | null; vStart: number | null; vEnd: number | null; }

/** Parse "Juan 3:16", "Salmo 23", "Genesis 1", "3:16-18" -> chapter (+ verse range). */
function parseScriptureRef(query: string): ParsedRef {
  const q = query || '';
  const cv = q.match(/(\d+)\s*:\s*(\d+)(?:\s*-\s*(\d+))?/);
  if (cv) {
    const vStart = parseInt(cv[2], 10);
    return { chapter: parseInt(cv[1], 10), vStart, vEnd: cv[3] ? parseInt(cv[3], 10) : vStart };
  }
  const ch = q.match(/(?:salmo|salmos|capitulo|cap\.?|proverbio|proverbios|psalm|psalms|chapter)\s+(\d+)/i)
    || q.match(/\b(\d+)\b/);
  if (ch) return { chapter: parseInt(ch[1], 10), vStart: null, vEnd: null };
  return { chapter: null, vStart: null, vEnd: null };
}

interface VerseUnit { book: string; chapter: number; verse: number; text: string; }

/** Split a chunk's text into verses on [BOOK c:v] markers, keeping text VERBATIM. */
function parseVerses(text: string): VerseUnit[] {
  const s = text || '';
  const re = /\[([A-Z]{2,4}) (\d+):(\d+)\]/g;
  const marks: { idx: number; book: string; chapter: number; verse: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    marks.push({ idx: m.index, book: m[1], chapter: parseInt(m[2], 10), verse: parseInt(m[3], 10) });
  }
  const out: VerseUnit[] = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].idx : s.length;
    out.push({ book: marks[i].book, chapter: marks[i].chapter, verse: marks[i].verse, text: s.slice(marks[i].idx, end).trim() });
  }
  return out;
}

/**
 * Serve a literal passage. Returns true when it answered; false to fall back to the
 * normal rag path (no resolvable reference / verse markers). Consumes no LLM call --
 * the verbatim text is served from the retrieved chunks AS-IS, so the output budget
 * is naturally the passage length (no summary cap). A brief interpretation is left
 * to the on-demand detail stage (detailAvailable + sources), keeping the literal
 * text first and complete.
 */
async function answerTextualQuote(
  res: Response,
  args: {
    assistantId: string; namespace: string; query: string; language: string;
    k: number; quota: ConsumeResult; stage: (label: string, from: number) => void;
  },
): Promise<boolean> {
  const { namespace, query, k, quota, stage } = args;
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  const ref = parseScriptureRef(query);
  if (ref.chapter == null) return false;

  // 1) Locate the passage region (semantic landing only).
  let matched: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const tEmbed = Date.now();
    const qv = await embedText([query], 'RETRIEVAL_QUERY');
    const vq = chunksCol.findNearest({
      vectorField: 'embedding', queryVector: FieldValue.vector(qv[0]),
      limit: Math.max(k, 12), distanceMeasure: 'COSINE',
    });
    matched = (await vq.get()).docs;
    stage('Q1 textual-quote locate (findNearest)', tEmbed);
  } catch (e) {
    logger.error('chatRag textual_quote retrieval failed', { namespace, error: String(e) });
    return false;
  }
  if (!matched.length) return false;

  // 2) Pick the book whose markers contain the requested chapter (most frequent
  //    among matched), and a seed chunk (docId + chunkIndex) to expand from.
  const tally = new Map<string, { count: number; docId: string; chunkIndex: number }>();
  for (const d of matched) {
    const docId = (d.get('docId') ?? '').toString();
    const chunkIndex = Number(d.get('chunkIndex') ?? -1);
    for (const v of parseVerses((d.get('text') ?? '').toString())) {
      if (v.chapter !== ref.chapter) continue;
      const cur = tally.get(v.book);
      if (!cur) tally.set(v.book, { count: 1, docId, chunkIndex });
      else cur.count++;
    }
  }
  if (!tally.size) return false;
  let book = ''; let best = -1; const seed = { docId: '', chunkIndex: 0 };
  for (const [b, info] of tally) {
    if (info.count > best) { best = info.count; book = b; seed.docId = info.docId; seed.chunkIndex = info.chunkIndex; }
  }
  if (!book || !seed.docId || seed.chunkIndex < 0) return false;

  // 3) Expand by chunk DOC ID outward from the seed until the chapter ends, so a
  //    multi-chunk chapter/psalm comes back complete. Bounded by-id reads (cheap,
  //    no index). Also fold in any matched chunks of the same book+chapter.
  const tExp = Date.now();
  const MAX_WALK = 80;
  const collected = new Map<string, string>();
  const inChapter = (text: string): boolean => parseVerses(text).some((v) => v.book === book && v.chapter === ref.chapter);
  const tryAdd = async (idx: number): Promise<boolean> => {
    if (idx < 0) return false;
    const id = `${seed.docId}_${idx}`;
    if (collected.has(id)) return true;
    const snap = await chunksCol.doc(id).get();
    if (!snap.exists) return false;
    const text = (snap.get('text') ?? '').toString();
    if (!inChapter(text)) return false;
    collected.set(id, text);
    return true;
  };
  await tryAdd(seed.chunkIndex);
  for (let step = 1; step <= MAX_WALK; step++) { if (!(await tryAdd(seed.chunkIndex - step))) break; }
  for (let step = 1; step <= MAX_WALK; step++) { if (!(await tryAdd(seed.chunkIndex + step))) break; }
  for (const d of matched) {
    const text = (d.get('text') ?? '').toString();
    if (inChapter(text)) collected.set(d.id, text);
  }
  stage('Q2 textual-quote expand (by-id chunk walk)', tExp);

  // 4) Reconstruct verses in range, ordered, deduped by verse number.
  const byVerse = new Map<number, VerseUnit>();
  for (const text of collected.values()) {
    for (const v of parseVerses(text)) {
      if (v.book !== book || v.chapter !== ref.chapter) continue;
      if (ref.vStart != null && (v.verse < ref.vStart || v.verse > (ref.vEnd ?? ref.vStart))) continue;
      if (!byVerse.has(v.verse)) byVerse.set(v.verse, v);
    }
  }
  const verses = Array.from(byVerse.values()).sort((a, b) => a.verse - b.verse);
  if (!verses.length) return false;

  const passage = verses.map((v) => v.text).join('\n');
  const sourceIds = Array.from(collected.keys());

  // 5) Serve verbatim. sources = chunk ids so the on-demand detail (Ver mas) can
  //    add a brief reflexion reusing the SAME chunks (literal text stays first).
  res.json({
    summary: passage, detail: '', body: passage, gestureCommands: passage,
    media: [], sources: sourceIds.map((id) => ({ id, metadata: {} })),
    quota: { remaining: quota.remaining, allocated: quota.allocated, used: quota.used, warnThresholds: quota.warnThresholds, warnCrossed: quota.warnCrossed },
  });
  logger.info('chatRag textual_quote served', { namespace, book, chapter: ref.chapter, verses: verses.length, chunks: sourceIds.length });
  return true;
}

// ---------------------------------------------------------------- category explore
/** Normalize for MATCHING: lowercase, strip accents + punctuation, collapse spaces. */
function normMatch(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Trailing numeric code on an entry line (>= 4 digits; space/_/.- separators, stray ')'). */
function splitNameCode(line: string): { name: string; code: string } | null {
  const m = (line ?? '').trim().match(/^(.*\S)\s+([0-9][0-9 ._\-]*\)?)$/);
  if (!m) return null;
  if ((m[2].match(/[0-9]/g) ?? []).length < 4) return null;
  return { name: m[1].trim(), code: m[2].trim() };
}

/** Parse a category chunk into its header (category) + condition entries (name + code). */
function parseCategoryChunk(text: string): { category: string; entries: { name: string; code: string }[] } {
  const lines = (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let category = '';
  const entries: { name: string; code: string }[] = [];
  for (const l of lines) {
    const nc = splitNameCode(l);
    if (nc) { entries.push(nc); continue; }
    // First code-less, all-caps line is the category header.
    if (!category && !/[0-9]/.test(l) && l === l.toUpperCase()) category = l;
  }
  return { category, entries };
}

// ----------------------------------------------------------- intent classifier
/**
 * Classify a Grabovoi query into ONE route with a cheap LLM call (replaces the old regex gate).
 * Routing ONLY -- the chosen handler stays fully deterministic. Returns null on any failure, so
 * the caller falls through to the normal RAG path (safe: honest prose, never a category dump).
 */
async function classifyGrabovoiIntent(args: {
  assistantId: string; overrideProfileId?: string; globalProfileId?: string; legacyProfileId?: string;
  query: string; language: string; stage: (l: string, f: number) => void;
}): Promise<GrabovoiIntentResult | null> {
  try {
    const t = Date.now();
    const { profile } = await resolveStageProfile({
      assistantId: args.assistantId, overrideProfileId: args.overrideProfileId,
      globalProfileId: args.globalProfileId, legacyProfileId: args.legacyProfileId,
    });
    // Small JSON output. Clone keeps the key/secret lookup intact while capping tokens.
    const p = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? 64, 64) };
    const result = await generateFromProfile(p, args.query, '', args.language, GRABOVOI_CLASSIFY_DIRECTIVE);
    args.stage('G0 grabovoi intent classify (one LLM call)', t);
    const raw = (result.text ?? '');
    // Tolerant JSON parse: grab the first {...} block.
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    let mode: GrabovoiIntent | null = null;
    let topic = '';
    if (s >= 0 && e > s) {
      try {
        const obj = JSON.parse(raw.slice(s, e + 1)) as { mode?: string; topic?: string };
        const m = (obj.mode ?? '').toLowerCase();
        if (m === 'protocol' || m === 'catalog' || m === 'list' || m === 'concept') mode = m;
        topic = (obj.topic ?? '').toString().trim();
      } catch { /* fall through to keyword scan */ }
    }
    if (!mode) {
      const out = raw.toLowerCase();
      if (out.includes('protocol')) mode = 'protocol';
      else if (out.includes('concept')) mode = 'concept';
      else if (out.includes('list')) mode = 'list';
      else if (out.includes('catalog')) mode = 'catalog';
    }
    return mode ? { mode, topic } : null;
  } catch (e) {
    logger.warn('chatRag grabovoi classify failed', { error: String(e) });
    return null;
  }
}

// ----------------------------------------------------------- reverse code lookup
/** Min digits for a query token to count as a "code the user wants explained". */
const REVERSE_MIN_DIGITS = 4;
/** Reverse lookup scans the WHOLE namespace's chunk TEXT (embeddings cannot target exact
 *  digit strings, so findNearest misses many codes). This caps the scan defensively; a
 *  Grabovoi catalog is well under this. Only the `text` field is fetched (no embeddings). */
const REVERSE_SCAN_MAX = 2000;
/** Honest absence messages (no category dump, no invented meaning). */
const REVERSE_NOT_FOUND_ES = 'No encuentro ese codigo en la informacion disponible.';
const REVERSE_NOT_FOUND_EN = 'I could not find that code in the available information.';

/** First >=4-digit numeric code in the user's text (digits-only; separators ignored). null
 *  when the query carries no code (-> not a reverse lookup). */
function extractQueriedCode(query: string): string | null {
  for (const m of ((query ?? '').match(/[0-9][0-9 ._\-]*/g) ?? [])) {
    const d = m.replace(/[^0-9]/g, '');
    if (d.length >= REVERSE_MIN_DIGITS) return d;
  }
  return null;
}

/**
 * REVERSE-LOOKUP handler (Grabovoi): the user brought a LITERAL code and wants its meaning.
 * Retrieves a broad set of chunks and string-scans (digits-only) their condition entries for
 * the code; returns its label VERBATIM if present, an "ask which" when several labels share
 * the code, or an honest "not found" otherwise. NEVER lists categories, NEVER invents a
 * meaning. Returns true when handled (it always handles a query that carried a code).
 */
async function answerReverseLookup(
  res: Response,
  args: { namespace: string; queriedCode: string; language: string; quota: ConsumeResult; stage: (l: string, f: number) => void },
): Promise<boolean> {
  const { namespace, queriedCode, language, quota, stage } = args;
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  const quotaOut = {
    remaining: quota.remaining, allocated: quota.allocated, used: quota.used,
    warnThresholds: quota.warnThresholds, warnCrossed: quota.warnCrossed,
  };
  const notFound = language === 'en' ? REVERSE_NOT_FOUND_EN : REVERSE_NOT_FOUND_ES;
  // The reverse-lookup answer is COMPLETE (the verbatim label). It must NOT offer "Ver mas":
  // an on-demand detail would call the LLM (answerDetail) and hallucinate a different label.
  // suppressDetail + EMPTY sources guarantee no detail affordance in any client build.
  const serve = (body: string, _ids: string[]): boolean => {
    res.json({
      summary: body, detail: '', body, gestureCommands: body, media: [],
      sources: [], suppressDetail: true, quota: quotaOut,
    });
    return true;
  };

  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const tScan = Date.now();
    // RELIABLE: scan the WHOLE namespace's chunk TEXT for the literal code. Embedding-based
    // findNearest cannot target exact digit strings, so it found some codes and missed others.
    // .select('text') avoids downloading the (heavy) embedding vectors -> cheap full scan.
    docs = (await chunksCol.select('text').limit(REVERSE_SCAN_MAX).get()).docs;
    stage('RL1 reverse-lookup full text scan', tScan);
  } catch (e) {
    logger.error('chatRag reverse-lookup scan failed', { namespace, error: String(e) });
    return serve(notFound, []); // honest absence rather than a category dump
  }

  // Scan condition entries across ALL chunks for the exact code (digits-only).
  const hits: { name: string; code: string; id: string }[] = [];
  const seenName = new Set<string>();
  for (const d of docs) {
    for (const e of parseCategoryChunk((d.get('text') ?? '').toString()).entries) {
      if (e.code.replace(/[^0-9]/g, '') !== queriedCode) continue;
      const key = e.name.replace(/\s+/g, ' ').trim().toLowerCase();
      if (seenName.has(key)) continue;
      seenName.add(key);
      hits.push({ name: e.name.replace(/\s+/g, ' ').trim(), code: e.code.trim(), id: d.id });
    }
  }

  logger.info('chatRag reverse-lookup', { namespace, queriedCode, scanned: docs.length, hits: hits.length });

  if (!hits.length) return serve(notFound, []);
  if (hits.length === 1) {
    return serve(`El codigo ${hits[0].code} corresponde a ${hits[0].name}.`, [hits[0].id]);
  }
  // Several distinct labels share the code -> list them verbatim and ask (no random pick).
  const names = hits.map((h) => h.name).join(', ');
  return serve(`El codigo ${hits[0].code} aparece como: ${names}. Cual buscas?`, hits.map((h) => h.id));
}

/** TOPIC-LIST directive: the LLM REFORMULATES the pre-selected sequences naturally (it does
 *  NOT choose codes -- those are fixed in the CONTEXT). Codes verbatim; meaning from the source. */
const TOPIC_LIST_DIRECTIVE =
  'En el CONTEXTO tienes secuencias numericas de Grabovoi YA SELECCIONADAS y correctas para el ' +
  'tema, con su nombre. Redacta una respuesta natural y en SEGUNDA PERSONA (hablale al usuario). ' +
  'Devuelve DOS partes: una linea "<<SUMMARY>>" y debajo un resumen HABLADO breve (1 a 2 frases) que ' +
  'mencione las secuencias del tema con su numero; despues una linea "<<DETAIL>>" y debajo un ' +
  'PROTOCOLO util que integre, si aparecen en el CONTEXTO: 1) la limpieza inicial, 2) las secuencias ' +
  'del tema, 3) como aplicarlas. REGLA ABSOLUTA: usa SOLO las secuencias del CONTEXTO; copia cada ' +
  'numero TAL CUAL aparece (digito por digito, conservando los guiones bajos), sin inventar, cambiar, ' +
  'redondear ni completar; NO agregues secuencias que no esten en el CONTEXTO. Texto plano, sin ' +
  'Markdown, en el mismo idioma de la pregunta, sin saludos ni despedidas.';

/**
 * TOPIC-LIST handler (Grabovoi): "que codigos hay para X / dame una lista para X". The set of
 * matching sequences is selected DETERMINISTICALLY (by name match -> correct codes, never
 * mis-associated); the LLM then REFORMULATES them into a natural summary + protocol using ONLY
 * that focused context (codes guarded verbatim by enforceVerbatimCodes). Returns false (let the
 * normal RAG path answer) only when there is no usable topic to match on.
 */
async function answerTopicList(
  res: Response,
  args: {
    assistantId: string; llmProfileId: string; persona: string;
    namespace: string; topic: string; language: string; quota: ConsumeResult;
    overrideProfileId?: string; globalProfileId?: string; detailMaxTokens?: number;
    stage: (l: string, f: number) => void;
  },
): Promise<boolean> {
  const { assistantId, llmProfileId, persona, namespace, topic, language, quota, stage } = args;
  const normTopic = normMatch(topic);
  if (!normTopic || normTopic.length < 3) return false; // no usable topic -> normal RAG
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  const quotaOut = {
    remaining: quota.remaining, allocated: quota.allocated, used: quota.used,
    warnThresholds: quota.warnThresholds, warnCrossed: quota.warnCrossed,
  };
  let docs: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const tScan = Date.now();
    docs = (await chunksCol.select('text').limit(REVERSE_SCAN_MAX).get()).docs;
    stage('TL1 topic-list full text scan', tScan);
  } catch (e) {
    logger.error('chatRag topic-list scan failed', { namespace, error: String(e) });
    return false; // fall through to normal RAG
  }

  // Significant topic tokens (light plural stemming: drop a trailing 's' on words >=4 chars),
  // minus stopwords. Lets "ojos" match "ojo", "muelas" match "muela", phrasing match names.
  const STOP = new Set(['para', 'que', 'los', 'las', 'del', 'una', 'uno', 'con', 'por', 'ser', 'uso',
    'usar', 'codigo', 'codigos', 'numero', 'numeros', 'secuencia', 'secuencias', 'sirve', 'hay',
    'tienes', 'dame', 'lista', 'listas', 'todas', 'todos', 'cuales', 'mejor', 'sobre']);
  const destem = (w: string): string => (w.length >= 4 && w.endsWith('s') ? w.slice(0, -1) : w);
  const topicTokens = normTopic.split(' ').map(destem).filter((t) => t.length >= 3 && !STOP.has(t));

  // Match entries by topic: whole-phrase containment OR all significant topic tokens present
  // (both stemmed) in the (parenthetical-stripped) entry name.
  const hits: { name: string; code: string }[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    for (const e of parseCategoryChunk((d.get('text') ?? '').toString()).entries) {
      const core = e.name.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
      const nn = normMatch(core);
      if (!nn) continue;
      const nnStem = nn.split(' ').map(destem).join(' ');
      const phraseHit = nn.includes(normTopic) || normTopic.includes(nn);
      const tokenHit = topicTokens.length > 0 && topicTokens.every((t) => nnStem.includes(t));
      if (!phraseHit && !tokenHit) continue;
      const key = nn + '|' + e.code.replace(/[^0-9]/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ name: core, code: e.code.trim() });
      if (hits.length >= 20) break;
    }
    if (hits.length >= 20) break;
  }

  logger.info('chatRag topic-list', { namespace, topic, scanned: docs.length, hits: hits.length });

  if (!hits.length) {
    const msg = language === 'en'
      ? `I could not find sequences for "${topic}" in the available information.`
      : `No encuentro secuencias para "${topic}" en la informacion disponible.`;
    res.json({ summary: msg, detail: '', body: msg, gestureCommands: msg, media: [], sources: [], suppressDetail: true, quota: quotaOut });
    return true;
  }

  // Cleansing / macrocommand entries (the protocol's first step), scanned deterministically
  // from the SAME chunks so the protocol has the REAL codes (no LLM, no invention).
  const methodHits: { name: string; code: string }[] = [];
  const methodSeen = new Set<string>();
  for (const d of docs) {
    for (const e of parseCategoryChunk((d.get('text') ?? '').toString()).entries) {
      if (!/(limpieza|macrocomando|macro comando)/.test(normMatch(e.name))) continue;
      const dk = e.code.replace(/[^0-9]/g, '');
      if (methodSeen.has(dk)) continue;
      methodSeen.add(dk);
      methodHits.push({ name: e.name.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim(), code: e.code.trim() });
      if (methodHits.length >= 3) break;
    }
    if (methodHits.length >= 3) break;
  }

  // FOCUSED context = ONLY the deterministically-matched sequences (correct codes for the topic)
  // + the cleansing/macrocommand entries. The LLM can use NOTHING else, so it cannot grab a code
  // from an unrelated topic; it only rephrases. Codes stay verbatim (guarded after generation).
  const ctxLines: string[] = [];
  if (methodHits.length) {
    ctxLines.push('=== LIMPIEZA / MACROCOMANDO ===');
    for (const h of methodHits) ctxLines.push(`${h.name}: ${h.code}`);
  }
  ctxLines.push(`=== SECUENCIAS PARA ${topic.toUpperCase()} ===`);
  for (const h of hits) ctxLines.push(`${h.name}: ${h.code}`);
  const context = ctxLines.join('\n');

  // Deterministic fallback text (used if the LLM call fails) -- never leaves the user empty.
  const fallbackSummary = `Para ${topic}: ${hits.slice(0, 4).map((h) => `${h.name} ${h.code}`).join('; ')}.`;
  const fallbackDetail = `Secuencias para ${topic}:\n` + hits.map((h) => `- ${h.name}: ${h.code}`).join('\n');

  // LLM REFORMULATION over the focused context (natural summary + protocol). One call.
  let summary = '';
  let detail = '';
  let usage: { model: string; provider: string; prompt: string; output: string } | null = null;
  try {
    const tGen = Date.now();
    const { profile } = await resolveStageProfile({
      assistantId, overrideProfileId: args.overrideProfileId, globalProfileId: args.globalProfileId, legacyProfileId: llmProfileId,
    });
    const cap = args.detailMaxTokens && args.detailMaxTokens > 0 ? args.detailMaxTokens : DETAIL_MAX_TOKENS;
    const genProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? cap, cap) };
    const genPersona = `${persona ? persona + '\n\n' : ''}${TOPIC_LIST_DIRECTIVE}`;
    const result = await generateFromProfile(genProfile, topic, context, language, genPersona);
    stage('TL2 topic-list LLM reformulation (summary+detail)', tGen);
    const split = extractSummaryDetail(result.text ?? '');
    // NUMERIC FIDELITY: any code not present verbatim in the focused context is replaced.
    summary = stripMarkdown(enforceVerbatimCodes(split.summary, context));
    detail = stripMarkdown(enforceVerbatimCodes(split.detail, context));
    if (!summary && detail) summary = detail.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    usage = { model: profile.model, provider: profile.provider, prompt: `${genPersona}\n${context}\n${topic}`, output: result.text ?? '' };
  } catch (e) {
    logger.error('chatRag topic-list generation failed', { namespace, error: e instanceof Error ? e.message : String(e) });
  }
  if (!summary) summary = fallbackSummary;
  if (!detail) detail = fallbackDetail;

  res.json({ summary, detail, body: summary, gestureCommands: summary, media: [], sources: [], suppressDetail: false, quota: quotaOut });
  if (usage) {
    void recordUsage(assistantId, { stage: 'summary', model: usage.model, provider: usage.provider, promptText: usage.prompt, outputText: usage.output });
  }
  return true;
}

/**
 * CATEGORY-EXPLORE handler (Grabovoi). Returns true when it answered, false to fall
 * through to the normal rag path. NO LLM call: a specific condition's code is served
 * VERBATIM from the retrieved chunk (never invented); a general/category request lists
 * the category's condition NAMES and asks which one (no code).
 */
async function answerCategoryExplore(
  res: Response,
  args: { namespace: string; query: string; k: number; quota: ConsumeResult; categoryChunkIds?: string[]; stage: (l: string, f: number) => void },
): Promise<boolean> {
  const { namespace, query, k, quota, categoryChunkIds, stage } = args;
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  const qn = ' ' + normMatch(query) + ' ';
  const quotaOut = {
    remaining: quota.remaining, allocated: quota.allocated, used: quota.used,
    warnThresholds: quota.warnThresholds, warnCrossed: quota.warnCrossed,
  };
  // EXACT match: the query CONTAINS a full condition name (parentheticals dropped).
  const findExact = (entries: { name: string; code: string }[]): { name: string; code: string } | null => {
    let best: { name: string; code: string } | null = null;
    let bestLen = 0;
    for (const e of entries) {
      const core = normMatch(e.name.replace(/\(.*?\)/g, ' '));
      if (core.length >= 4 && qn.includes(' ' + core + ' ') && core.length > bestLen) {
        best = { name: e.name, code: e.code };
        bestLen = core.length;
      }
    }
    return best;
  };
  const digitsOnly = (s: string): string => (s ?? '').replace(/[^0-9]/g, '');
  const serveExact = (
    best: { name: string; code: string }, srcId: string, scoped: boolean,
    pool: { name: string; code: string }[],
  ): boolean => {
    const body = `El codigo de ${best.name.replace(/\s+/g, ' ')} es ${best.code}.`;
    // RELATED (max 3): OTHER verbatim codes from the SAME pool. All codes stay verbatim
    // (with "_"); dedupe by digits-only; skip the primary and any non-code. Anti-alucinacion:
    // codes come from splitNameCode on the chunk, never from an LLM.
    const seenCodes = new Set<string>([digitsOnly(best.code)]);
    const related: { name: string; code: string }[] = [];
    for (const e of pool) {
      const d = digitsOnly(e.code);
      if (d.length < 4 || seenCodes.has(d)) continue;
      seenCodes.add(d);
      related.push({ name: e.name.replace(/\s+/g, ' ').trim(), code: e.code.trim() });
      if (related.length >= 3) break;
    }
    // detail (shown on "Ver mas", spoken only if the user taps it): primary + related list.
    // Empty when there are no related -> suppressDetail keeps the bare-code behavior (no "Ver mas").
    const detail = related.length
      ? `El codigo de ${best.name.replace(/\s+/g, ' ')} es ${best.code}.\n\nCodigos relacionados:\n`
        + related.map((r) => `- ${r.name}: ${r.code}`).join('\n')
      : '';
    res.json({
      summary: body, detail, body, gestureCommands: body, media: [],
      sources: [{ id: srcId, metadata: {} }], suppressDetail: !detail, quota: quotaOut,
    });
    logger.info('chatRag category-explore EXACT-CODE', { namespace, name: best.name, code: best.code, scoped, related: related.length });
    return true;
  };

  // 0) SCOPED EXACT-CODE: a follow-up right after an EXPLORE resolves WITHIN the already
  // shown category's chunk(s) by id (NO fresh search), so "cataratas" right after the OJO
  // list maps to OJO's cataratas (5189142), never a fresh search that lands elsewhere.
  if (categoryChunkIds && categoryChunkIds.length) {
    try {
      const scopedEntries: { name: string; code: string }[] = [];
      let firstId = '';
      for (const id of categoryChunkIds.slice(0, MAX_K)) {
        const snap = await chunksCol.doc(id).get();
        if (!snap.exists) continue;
        if (!firstId) firstId = snap.id;
        for (const e of parseCategoryChunk((snap.get('text') ?? '').toString()).entries) scopedEntries.push(e);
      }
      const sBest = findExact(scopedEntries);
      if (sBest && firstId) return serveExact(sBest, firstId, true, scopedEntries);
    } catch (e) {
      logger.warn('chatRag category-explore scoped lookup failed', { namespace, error: String(e) });
    }
    // Not found in the just-shown category -> fall through to a fresh search below.
  }

  let matched: FirebaseFirestore.QueryDocumentSnapshot[];
  try {
    const tEmbed = Date.now();
    const qv = await embedText([query], 'RETRIEVAL_QUERY');
    const vq = chunksCol.findNearest({
      vectorField: 'embedding', queryVector: FieldValue.vector(qv[0]),
      limit: Math.max(k, 12), distanceMeasure: 'COSINE', distanceResultField: 'vectorDistance',
    });
    matched = (await vq.get()).docs;
    stage('CE1 category-explore retrieve (findNearest)', tEmbed);
  } catch (e) {
    logger.error('chatRag category-explore retrieval failed', { namespace, error: String(e) });
    return false;
  }
  if (!matched.length) return false;
  const bestDist = Number(matched[0].get('vectorDistance'));

  const top = matched.slice(0, 6);
  const all: { name: string; code: string; category: string }[] = [];
  for (const d of top) {
    const parsed = parseCategoryChunk((d.get('text') ?? '').toString());
    const metaCat = ((d.get('metadata') as Record<string, unknown>)?.['category'] ?? '').toString().trim();
    const cat = parsed.category || metaCat;
    for (const e of parsed.entries) all.push({ name: e.name, code: e.code, category: cat });
  }
  if (!all.length) return false;

  // 1) EXACT-CODE (fresh search): a named condition found in the retrieved chunks IS the
  //    relevance signal, so this is NOT gated on distance.
  const freshBest = findExact(all);
  if (freshBest) return serveExact(freshBest, top[0].id, false, all);

  // Distance gate applies ONLY to the EXPLORE fallback (don't list an irrelevant category).
  if (Number.isFinite(bestDist) && bestDist > CATEGORY_RELEVANCE_MAX) return false;

  // 2) EXPLORE: no specific condition matched -> SPEAK a short prompt with a few examples
  // (token-friendly) and return the condition NAMES as follow-up CHIPS. No code emitted.
  const topParsed = parseCategoryChunk((top[0].get('text') ?? '').toString());
  const topCat = topParsed.category
    || ((top[0].get('metadata') as Record<string, unknown>)?.['category'] ?? '').toString().trim();
  if (!topCat) return false;
  // Clean condition names: drop the trailing code is already done; drop parentheticals for
  // brevity, collapse spaces, dedupe (order preserved).
  const names: string[] = [];
  const seen = new Set<string>();
  for (const e of all) {
    if (e.category !== topCat) continue;
    const core = e.name.replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
    const key = normMatch(core);
    if (core && key && !seen.has(key)) { seen.add(key); names.push(core); }
  }
  if (!names.length) return false;
  // Spoken prompt: a few example names (lowercased) + "entre otras" -> short, fast TTS.
  const examples = names.slice(0, EXPLORE_SPOKEN_EXAMPLES).map((n) => n.toLowerCase());
  const more = names.length > examples.length ? ', entre otras' : '';
  const spoken = `Tengo varias opciones como ${examples.join(', ')}${more}. Cual buscas?`;
  // Chips: the condition names (tap one -> EXACT-CODE returns its verbatim code).
  const suggestions = names.slice(0, EXPLORE_CHIPS_MAX);
  // Carry the SHOWN category's chunk ids as sources + an exploreCategory marker, so the
  // client passes them back as categoryChunkIds on the follow-up (scoped EXACT-CODE).
  const catChunkIds = top
    .filter((d) => {
      const c = parseCategoryChunk((d.get('text') ?? '').toString()).category
        || ((d.get('metadata') as Record<string, unknown>)?.['category'] ?? '').toString().trim();
      return c === topCat;
    })
    .map((d) => d.id);
  const srcIds = (catChunkIds.length ? catChunkIds : [top[0].id]);
  res.json({
    summary: spoken, detail: '', body: spoken, gestureCommands: spoken, media: [],
    // suppressDetail: the chips ARE the follow-up; no "Ver mas" LLM list. sources still
    // carry the category chunk ids for the scoped EXACT-CODE on the next turn.
    sources: srcIds.map((id) => ({ id, metadata: {} })), suggestions, exploreCategory: topCat,
    suppressDetail: true, quota: quotaOut,
  });
  logger.info('chatRag category-explore EXPLORE', { namespace, category: topCat, count: names.length, chips: suggestions.length });
  return true;
}

/** Strip Markdown from a backend string (defense; the client also strips before TTS). */
function stripMarkdown(s: string): string {
  return (s ?? '')
    .replace(/\*\*/g, '')
    // Strip underscores used as Markdown emphasis, but PRESERVE underscores that join
    // digits -- numeric-sequence separators (e.g. "219888_412_1289018") must survive.
    // Only remove _ runs NOT flanked by digits on both sides.
    .replace(/(?<![0-9])_+|_+(?![0-9])/g, '')
    .replace(/[*`#>]/g, '')
    .replace(/^[ \t]*[-]\s+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * NUMERIC-FIDELITY GUARD: replace any code-like token (>= 4 digits) in `text` that does
 * NOT appear verbatim (digits-only) in `context` with an explicit gap note -> a fabricated
 * or altered code can never reach the user. Reformatting (spaces/underscores) is tolerated
 * because both sides are compared digits-only.
 */
function enforceVerbatimCodes(text: string, context: string): string {
  const ctxCodes = new Set(
    ((context ?? '').match(/[0-9][0-9 ._\-]{3,}/g) ?? []).map((c) => c.replace(/[^0-9]/g, '')).filter((d) => d.length >= 4),
  );
  return (text ?? '').replace(/[0-9][0-9 ._\-]{3,}/g, (m) => {
    const d = m.replace(/[^0-9]/g, '');
    if (d.length < 4) return m;
    return ctxCodes.has(d) ? m : '[codigo no disponible en la fuente]';
  });
}

/**
 * PROTOCOL-ASSEMBLY handler (Grabovoi). Retrieves the topic's CODE chunks AND the method
 * (cleansing/macrocommand) chunks separately, then has the LLM assemble a complete protocol
 * -- prose reworded, codes VERBATIM. Returns a short spoken summary + full detail (Ver mas).
 * Codes are guarded post-generation so none can be invented. Returns true when handled.
 */
async function answerProtocolAssembly(
  res: Response,
  args: {
    assistantId: string; llmProfileId: string; persona: string; language: string;
    query: string; namespace: string; k: number; quota: ConsumeResult;
    overrideProfileId?: string; globalProfileId?: string; detailMaxTokens?: number;
    stage: (label: string, from: number) => void;
  },
): Promise<boolean> {
  const { assistantId, llmProfileId, persona, language, query, namespace, k, quota, stage } = args;
  const chunksCol = db.collection('rag').doc(namespace).collection('chunks');
  // 1) TWO retrievals: topic codes + method (cleansing/macrocommand) -- they live in
  //    different chunks, so a single query embedding would miss one of them.
  let topicCtx = '';
  let methodCtx = '';
  try {
    const tCtx = Date.now();
    const tv = await embedText([query], 'RETRIEVAL_QUERY');
    const tq = chunksCol.findNearest({
      vectorField: 'embedding', queryVector: FieldValue.vector(tv[0]), limit: Math.max(k, 14), distanceMeasure: 'COSINE',
    });
    topicCtx = (await tq.get()).docs.map((d) => (d.get('text') ?? '').toString()).join('\n---\n');
    const mv = await embedText([PROTOCOL_METHOD_SEED], 'RETRIEVAL_QUERY');
    const mq = chunksCol.findNearest({
      vectorField: 'embedding', queryVector: FieldValue.vector(mv[0]), limit: 6, distanceMeasure: 'COSINE',
    });
    methodCtx = (await mq.get()).docs.map((d) => (d.get('text') ?? '').toString()).join('\n---\n');
    stage('PA1 protocol retrieve (topic + method)', tCtx);
  } catch (e) {
    logger.error('chatRag protocol-assembly retrieval failed', { namespace, error: String(e) });
    return false;
  }
  logger.info('chatRag protocol-assembly retrieved', { namespace, topicChars: topicCtx.length, methodChars: methodCtx.length });
  if (!topicCtx.trim() && !methodCtx.trim()) return false;
  const context =
    '=== ESTRUCTURA DEL METODO (limpieza del pasado, macrocomando, como aplicar) ===\n' + methodCtx +
    '\n\n=== CODIGOS DEL TEMA SOLICITADO (usa SOLO estos, verbatim) ===\n' + topicCtx;

  // 2) LLM assembles (prose reworded; codes verbatim). One call via the DETAIL profile.
  let summary = '';
  let detail = '';
  let usage: { model: string; provider: string; prompt: string; output: string } | null = null;
  try {
    const { profile } = await resolveStageProfile({
      assistantId, overrideProfileId: args.overrideProfileId, globalProfileId: args.globalProfileId, legacyProfileId: llmProfileId,
    });
    const cap = args.detailMaxTokens && args.detailMaxTokens > 0 ? args.detailMaxTokens : DETAIL_MAX_TOKENS;
    const genProfile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens ?? cap, cap) };
    const genPersona = `${persona ? persona + '\n\n' : ''}${PROTOCOL_ASSEMBLY_DIRECTIVE}`;
    const tGen = Date.now();
    const result = await generateFromProfile(genProfile, query, context, language, genPersona);
    stage(`PA2 protocol LLM assembly (${profile.provider}/${profile.model})`, tGen);
    const split = extractSummaryDetail(result.text ?? '');
    // 3) NUMERIC FIDELITY + no Markdown on BOTH parts.
    summary = stripMarkdown(enforceVerbatimCodes(split.summary, context));
    detail = stripMarkdown(enforceVerbatimCodes(split.detail, context));
    if (!summary && detail) summary = detail.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    usage = { model: profile.model, provider: profile.provider, prompt: `${genPersona}\n${context}\n${query}`, output: result.text ?? '' };
  } catch (e: any) {
    logger.error('chatRag protocol-assembly generation failed', { namespace, error: e?.message ?? String(e) });
    return false;
  }
  if (!summary) return false;

  // This is a pilotaje/protocol answer (it always carries a full DETAIL) -> invite the user
  // to open "Ver mas" for the complete protocol. Appended by code so the hint is reliable.
  if (detail) summary = `${summary} Para mas informacion, dale en "Ver mas".`;

  const quotaOut = {
    remaining: quota.remaining, allocated: quota.allocated, used: quota.used,
    warnThresholds: quota.warnThresholds, warnCrossed: quota.warnCrossed,
  };
  res.json({
    summary, detail, body: summary, gestureCommands: summary, media: [], sources: [], quota: quotaOut,
  });
  logger.info('chatRag protocol-assembly served', { namespace, summaryChars: summary.length, detailChars: detail.length });
  if (usage) {
    void recordUsage(assistantId, { stage: 'detail', model: usage.model, provider: usage.provider, promptText: usage.prompt, outputText: usage.output });
  }
  return true;
}

/** Parse the LLM output into up to 3 trimmed suggestion strings (strict-JSON tolerant). */
function parseSuggestions(raw: string): string[] {
  const text = (raw ?? '').toString();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try { arr = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const v of arr) {
    const s = (typeof v === 'string' ? v : '').trim();
    if (s) out.push(s);
    if (out.length === 3) break;
  }
  return out;
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

// SUMMARY_ONLY_DIRECTIVE moved to lib/response-contracts/plain-core.ts (used by the
// plain handler that now owns the STAGE-1 generic path).

/** Default hybrid relevance threshold: COSINE DISTANCE (lower = more similar).
 *  The best chunk "passes" when its distance <= this. Tune via config/ragModels
 *  (relevanceThreshold) or per-assistant (assistants/{id}.relevanceThreshold). */
const DEFAULT_RELEVANCE_THRESHOLD = 0.45;

// TRAINING_DIRECTIVE moved to lib/response-contracts/plain-core.ts (used by the
// plain handler). DETAIL_TRAINING_DIRECTIVE (below) stays: it is used by answerDetail.

/** Detail-stage training directive: long-form GENERAL-KNOWLEDGE analysis when stage 1
 *  had no chunks (training_only or hybrid fallback). No context needed; persona safety
 *  rules (no fabricated citations) still apply via the prepended persona. */
const DETAIL_TRAINING_DIRECTIVE =
  'Genera un analisis COMPLETO y EXTENSO (varios parrafos) sobre la pregunta, ' +
  'desde tu CONOCIMIENTO GENERAL (no hay informacion en la base de conocimiento). ' +
  'Escribelo en el mismo idioma de la pregunta, sin saludos ni despedidas y sin marcadores. ' +
  'NUNCA inventes ni completes citas textuales, versiculos, cifras o referencias que no puedas ' +
  'verificar. Este texto se mostrara como lectura (no se habla).';

/**
 * STAGE 2 directive: detail ONLY. Long-form analysis for the SAME question, grounded
 * in the SAME context as the summary. Text-only (not spoken); no markers.
 */
const DETAIL_ONLY_DIRECTIVE =
  'Genera un analisis COMPLETO, EXTENSO y BIEN ORGANIZADO que cubra a fondo la pregunta usando TODO el ' +
  'espacio disponible con contenido sustantivo del CONTEXTO (no relleno). Da primero la respuesta directa ' +
  '(por ejemplo, el conteo) y luego el desglose completo. Si el CONTEXTO contiene una lista o varios ' +
  'elementos, ENUMERALOS todos, uno por uno, con sus atributos relevantes (por ejemplo, para cada elemento: ' +
  'color, atributo, arquetipo, arcangel, impacto u otros datos presentes), de forma clara y estructurada. ' +
  'Cubre el material por COMPLETO en lugar de resumir brevemente: este es el analisis profundo. ' +
  'Fundado UNICAMENTE en el CONTEXTO: NO inventes ni completes elementos, nombres, cifras, listas, citas ni ' +
  'versiculos que no esten en el CONTEXTO; si un dato no aparece, omitelo. Cita las referencias cuando ' +
  'correspondan. Escribelo en el mismo idioma de la pregunta, sin saludos ni despedidas y sin marcadores. ' +
  'CIERRA la idea dentro del espacio disponible (no te cortes a media lista). Este texto se mostrara como ' +
  'lectura (no se habla).';

/**
 * PROTOCOL-ASSEMBLY directive (Grabovoi). Joins REAL retrieved pieces into a usable
 * protocol. The PROSE (cleansing steps, application guidance) MAY be reworded; the
 * NUMERIC CODES are sacred -> copied VERBATIM from the CONTEXT, never invented/rounded/
 * completed. Output is split into a short spoken <<SUMMARY>> + a full <<DETAIL>>. Plain
 * text, NO Markdown.
 */
const PROTOCOL_ASSEMBLY_DIRECTIVE =
  'Dirigete SIEMPRE al usuario en SEGUNDA PERSONA, hablandole directamente (por ejemplo: "Te presento un ' +
  'pilotaje para...", "Puedes usar..."). NUNCA narres en tercera persona ni describas la peticion: NO digas ' +
  '"el usuario solicita", "se presenta", "se pide" ni similares; responde como si hablaras con la persona. ' +
  'Arma un PROTOCOLO COMPLETO y claro para lo que pide el usuario, integrando las piezas del CONTEXTO. ' +
  'Estructura el protocolo asi: 1) Limpieza del Pasado (explica los pasos con tus propias palabras, sin ' +
  'cambiar el sentido); 2) Macrocomando diario, si aparece en el CONTEXTO; 3) las SECUENCIAS NUMERICAS ' +
  'especificas para el tema solicitado, copiadas TAL CUAL del CONTEXTO, digito por digito, sin cambiar, ' +
  'redondear, completar ni inventar; 4) como aplicarlas (por ejemplo, una debajo de la otra, nunca en la ' +
  'misma linea, concentrandose y visualizando la mejora), segun lo describe el CONTEXTO. ' +
  'REGLA ABSOLUTA: los numeros son sagrados. Usa SOLO codigos que esten TEXTUALMENTE en el CONTEXTO. Si no ' +
  'encuentras el codigo del tema en el CONTEXTO, dilo claramente y NO inventes uno: entrega el resto del ' +
  'protocolo e indica que falta ese codigo especifico. ' +
  'Devuelve DOS partes: primero una linea "<<SUMMARY>>" y debajo un resumen HABLADO breve (1 a 2 frases) que ' +
  'mencione el tema y la secuencia principal; despues una linea "<<DETAIL>>" y debajo el PROTOCOLO COMPLETO ' +
  'con los pasos. Escribe en TEXTO PLANO, SIN Markdown (sin asteriscos, almohadillas ni guiones de lista), ' +
  'en el mismo idioma de la pregunta, sin saludos ni despedidas.';

/**
 * SUGGESTIONS directive: exactly 3 short, natural follow-up prompts the user might ask
 * next, grounded in the retrieved CONTEXT (not generic). Strict JSON array of 3 strings.
 */
const SUGGESTIONS_DIRECTIVE =
  'Basandote UNICAMENTE en el CONTEXTO y en la pregunta del usuario, propone EXACTAMENTE 3 ' +
  'preguntas de seguimiento que el usuario podria hacer a continuacion: cortas y naturales ' +
  '(maximo unas 6 palabras cada una), especificas al contenido (no genericas), en el mismo ' +
  'idioma de la pregunta, formuladas como las haria el usuario. Responde UNICAMENTE con un ' +
  'arreglo JSON valido de 3 cadenas y nada mas, sin texto adicional ni bloques de codigo. ' +
  'Ejemplo de formato: ["pregunta uno", "pregunta dos", "pregunta tres"].';

/**
 * Directive that makes the model emit a short spoken SUMMARY + a full DETAIL,
 * both grounded in the CONTEXT. The summary is what the avatar speaks; the detail
 * is shown on demand ("Ver mas"). Output markers are stripped before display.
 * Still used by capabilities mode.
 */
const SUMMARY_DETAIL_DIRECTIVE =
  'Estructura tu respuesta EXACTAMENTE asi, sin saludos ni despedidas:\n' +
  'Primero una linea que diga <<SUMMARY>> y debajo un resumen MUY BREVE de 3 a 4 lineas ' +
  '(aprox. 40 palabras, 2-3 frases) -- directo y claro; este texto se hablara en voz alta.\n' +
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

// MEDIA_DIRECTIVE moved to lib/response-contracts/plain-core.ts (used by the plain handler).

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

// extractMediaSelection moved to lib/response-contracts/plain-core.ts (used by the
// plain handler that now owns the STAGE-1 generic parse).