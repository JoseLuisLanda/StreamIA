/**
 * Cost-model callables (strimearia) -- Admin SDK, server-side. APPROXIMATE figures.
 *
 *   - getPricing()             -> the rate table (seeded if missing) + staleness flags.
 *   - updatePricingRate({...}) -> edit ONE rate; stamps its lastUpdated; saves.
 *   - projectAssistantCost({...}) -> structured cost breakdown (ingestion one-time,
 *                                    per-query, monthly storage, monthly infra) using
 *                                    the assistant's ACTUAL resolved models + real
 *                                    tracked usage (or supplied assumptions), plus a
 *                                    human-readable Spanish summary.
 *
 * Auth: signed-in always; admin enforced when ENFORCE_ADMIN_ROLE (mirrors the
 * other RAG-admin callables). Token figures are ESTIMATES -> every output is
 * labeled "aproximado". Does NOT change embedding/retrieval/storage logic.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';
import {
  loadPricing, savePricing, findStaleRates, llmRateFor, PricingConfig, StaleFlag,
} from './lib/pricing';
import { resolveStageProfile, loadRagStageModels } from './lib/llm-profiles';
import { usageMonth } from './lib/usage';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

const GIB = 1024 * 1024 * 1024;
/** Storage-estimate assumptions (best-effort; clearly approximate). */
const AVG_CHUNK_BYTES = 8 * 1024;     // ~768-dim vector (~6KB) + text/metadata
const AVG_MEDIA_BYTES = 2 * 1024 * 1024; // assume ~2 MB per media asset
const EST_TOKENS_PER_CHUNK = 800;     // matches the chunker target (approx)
/** A model is flagged "expensive" (Pro tier) when its input rate is high. */
const EXPENSIVE_INPUT_PER_1M = 1.0;

async function gate(auth: Parameters<typeof assertSignedIn>[0]): Promise<void> {
  assertSignedIn(auth);
  if (ENFORCE_ADMIN_ROLE) await assertAdmin(auth);
}

function round(n: number, dp = 6): number {
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}

export const getPricing = onCall<unknown, Promise<{ pricing: PricingConfig; stale: StaleFlag[] }>>(
  CALL_OPTS,
  async (req): Promise<{ pricing: PricingConfig; stale: StaleFlag[] }> => {
    await gate(req.auth);
    const pricing = await loadPricing();
    return { pricing, stale: findStaleRates(pricing) };
  },
);

interface UpdateRateReq {
  category: 'embedding' | 'llm' | 'firestore' | 'storage' | 'functions' | 'tts' | 'fx';
  /** sub-key: model id (llm), 'textEmbedding004' (embedding), 'usdToMxn' (fx), or the rate name. */
  key: string;
  /** field within the rate, e.g. 'value' | 'inputPer1M' | 'outputPer1M' | 'per1MTokens' | 'rate'. */
  field: string;
  value: number;
}

export const updatePricingRate = onCall<UpdateRateReq, Promise<{ pricing: PricingConfig; stale: StaleFlag[] }>>(
  CALL_OPTS,
  async (req): Promise<{ pricing: PricingConfig; stale: StaleFlag[] }> => {
    await gate(req.auth);
    const { category, key, field } = req.data ?? ({} as UpdateRateReq);
    const value = Number(req.data?.value);
    if (!category || !key || !field) throw new HttpsError('invalid-argument', 'category, key and field are required.');
    if (!Number.isFinite(value)) throw new HttpsError('invalid-argument', 'value must be a finite number.');

    const pricing = await loadPricing();
    const now = Date.now();
    // Locate the target rate object (read-modify-write the whole doc; no dotted paths).
    let target: any;
    if (category === 'embedding') target = (pricing.embedding as any)?.[key];
    else if (category === 'llm') target = pricing.llm?.[key];
    else target = (pricing as any)?.[category]?.[key];
    if (!target || typeof target !== 'object') {
      throw new HttpsError('not-found', `Rate not found: ${category}.${key}`);
    }
    target[field] = value;
    target.lastUpdated = now; // editing a rate refreshes its provenance timestamp
    await savePricing(pricing);
    logger.info('updatePricingRate', { by: req.auth?.uid, category, key, field, value });
    return { pricing, stale: findStaleRates(pricing) };
  },
);

interface ProjectReq {
  assistantId: string;
  /** override the projected monthly volume; falls back to real usage queries. */
  queriesPerMonth?: number;
}

export const projectAssistantCost = onCall<ProjectReq, Promise<any>>(
  CALL_OPTS,
  async (req): Promise<any> => {
    await gate(req.auth);
    const assistantId = (req.data?.assistantId ?? '').trim();
    if (!assistantId) throw new HttpsError('invalid-argument', 'assistantId is required.');

    const pricing = await loadPricing();
    const stale = findStaleRates(pricing);

    // 1) Assistant + namespace + resolved per-stage models.
    const aSnap = await db.collection('assistants').doc(assistantId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', `Assistant "${assistantId}" not found.`);
    const a = aSnap.data() as any;
    const assistantName: string = a.name ?? assistantId;
    const namespace: string = (a.ragCollection ?? a.ragNamespace ?? assistantId).toString();
    const stageModels = await loadRagStageModels();

    const summaryRes = await resolveStageProfile({
      assistantId, overrideProfileId: a.summaryProfileId,
      globalProfileId: stageModels.summaryProfileId, legacyProfileId: a.llmProfileId,
    });
    const detailRes = await resolveStageProfile({
      assistantId, overrideProfileId: a.detailProfileId,
      globalProfileId: stageModels.detailProfileId, legacyProfileId: a.llmProfileId,
    });
    const summaryModel = summaryRes.profile.model;
    const detailModel = detailRes.profile.model;
    const summaryRate = llmRateFor(pricing, summaryModel);
    const detailRate = llmRateFor(pricing, detailModel);
    const models = {
      summary: { model: summaryModel, provider: summaryRes.profile.provider, rated: !!summaryRate, expensive: !!summaryRate && summaryRate.inputPer1M >= EXPENSIVE_INPUT_PER_1M },
      detail: { model: detailModel, provider: detailRes.profile.provider, rated: !!detailRate, expensive: !!detailRate && detailRate.inputPer1M >= EXPENSIVE_INPUT_PER_1M },
    };

    // 2) Real tracked usage (current month).
    const ym = usageMonth();
    const uSnap = await db.collection('assistants').doc(assistantId).collection('usage').doc(ym).get();
    const usage = uSnap.exists ? (uSnap.data() as any) : null;

    const embedRate = pricing.embedding.textEmbedding004.per1MTokens;
    const readRate100k = pricing.firestore.readPer100kOps.value;

    // Models with no matching rate -> we apply the configurable fallback rate and
    // record them so the summary can warn LOUDLY (never a silent confident $0).
    const unratedModels = new Set<string>();
    const fallback = pricing.fallbackLlmRate;

    // Cost of one model's tokens (input + output per 1M). When the model has no
    // rate, fall back to pricing.fallbackLlmRate (flagged) instead of zero.
    const llmCost = (model: string, inTok: number, outTok: number): number => {
      const r = llmRateFor(pricing, model);
      const rate = r ?? fallback;
      if (!r && model) unratedModels.add(model);
      if (!rate) return 0;
      return (inTok / 1e6) * rate.inputPer1M + (outTok / 1e6) * rate.outputPer1M;
    };

    /** True if the model is a DeepSeek id (context-cache note applies). */
    const isDeepseek = (m: string): boolean => (m || '').toLowerCase().startsWith('deepseek');

    // 3) Per-query unit economics. Prefer REAL usage averages; fall back to assumptions.
    let perQueryLlm = 0, perQueryEmbed = 0, perQueryReads = 0;
    let basis: 'real-usage' | 'assumptions' = 'assumptions';
    const realQueries = Number(usage?.queries ?? 0);

    if (usage && realQueries > 0) {
      basis = 'real-usage';
      let monthlyLlm = 0;
      const modelsMap = (usage.models ?? {}) as Record<string, any>;
      for (const m of Object.values(modelsMap)) {
        monthlyLlm += llmCost(m.model ?? '', Number(m.inTokens ?? 0), Number(m.outTokens ?? 0));
      }
      const monthlyEmbed = (Number(usage.embedTokens ?? 0) / 1e6) * embedRate;
      const monthlyReads = (Number(usage.vectorReads ?? 0) / 1e5) * readRate100k;
      perQueryLlm = monthlyLlm / realQueries;
      perQueryEmbed = monthlyEmbed / realQueries;
      perQueryReads = monthlyReads / realQueries;
    } else {
      // Assumptions: ~6 retrieved chunks of ~EST_TOKENS_PER_CHUNK in, summary out ~250.
      const assumedInTok = 6 * EST_TOKENS_PER_CHUNK + 400; // context + persona/query overhead
      const assumedOutTok = 250;
      perQueryLlm = llmCost(summaryModel, assumedInTok, assumedOutTok);
      perQueryEmbed = (20 / 1e6) * embedRate; // ~20 tokens for a short query
      perQueryReads = (6 / 1e5) * readRate100k; // k=6 vector reads
    }
    const perQueryTotal = perQueryLlm + perQueryEmbed + perQueryReads;

    // 4) Ingestion one-time cost (embedding all chunks). Estimate from chunk count.
    let chunkCount = 0, docBytes = 0, mediaCount = 0;
    try {
      const docsSnap = await db.collection('rag').doc(namespace).collection('documents').get();
      for (const d of docsSnap.docs) {
        const dd = d.data() as any;
        chunkCount += Number(dd.chunks ?? 0);
        docBytes += Number(dd.size ?? 0);
      }
      if (chunkCount === 0) {
        const cc = await db.collection('rag').doc(namespace).collection('chunks').count().get();
        chunkCount = cc.data().count;
      }
      const mc = await db.collection('rag').doc(namespace).collection('media').count().get();
      mediaCount = mc.data().count;
    } catch (e) {
      logger.warn('projectAssistantCost: counts failed', { namespace, error: String(e) });
    }
    const ingestTokens = chunkCount * EST_TOKENS_PER_CHUNK;
    const ingestionCost = (ingestTokens / 1e6) * embedRate;

    // 5) Monthly storage cost.
    const vectorChunkGiB = (chunkCount * AVG_CHUNK_BYTES) / GIB;
    const docGiB = docBytes / GIB;
    const mediaGiB = (mediaCount * AVG_MEDIA_BYTES) / GIB;
    const firestoreStorageCost = vectorChunkGiB * pricing.firestore.storagePerGiBMonth.value;
    const cloudStorageCost = (docGiB + mediaGiB) * pricing.storage.cloudStoragePerGiBMonth.value;
    const conversationCost = 0; // history lives under users/{uid}; not attributable per assistant
    const storageMonthly = {
      vectorsAndChunks: round(firestoreStorageCost),
      documents: round(docGiB * pricing.storage.cloudStoragePerGiBMonth.value),
      media: round(mediaGiB * pricing.storage.cloudStoragePerGiBMonth.value),
      conversationHistory: conversationCost,
      total: round(firestoreStorageCost + cloudStorageCost + conversationCost),
    };

    // 6) Projected monthly volume + infra (best-effort).
    const queriesPerMonth = Number(req.data?.queriesPerMonth ?? (realQueries || 1000));
    // Assume ~2 function invocations per interaction (summary + suggestions); detail on demand.
    const invocations = queriesPerMonth * 2;
    const gbSecondsPerInvocation = 1.0 * 2.0; // ~1 GiB for ~2 s (rough)
    const infraMonthly = round(
      invocations * pricing.functions.invocationCost.value +
      invocations * gbSecondsPerInvocation * pricing.functions.gbSecondCost.value,
    );

    // 7) Totals.
    const variableMonthly = perQueryTotal * queriesPerMonth;
    const projectedMonthly = round(variableMonthly + storageMonthly.total + infraMonthly);

    const fmt = (n: number): string => '$' + n.toFixed(n < 0.01 ? 6 : 4);
    
    const notes: string[] = [
      'Todas las cifras son APROXIMADAS (los proveedores no devuelven el conteo real de tokens; se estima con estimateTokens).',
      'El costo por consulta depende del tamano del contexto: mas fragmentos recuperados = mas tokens de entrada.',
      'Los modelos Pro por encima de 200k de contexto entran en un tramo de precio mas alto.',
      'No es una factura garantizada; es una proyeccion para fijar precios de renta.',
    ];
    // Loud, unmissable warning per unrated model: we applied the fallback rate so
    // the total is never a silent confident $0, but it may be off -> flag it.
    for (const m of unratedModels) {
      notes.push(`El modelo ${m} no tiene tarifa; el costo LLM puede estar subestimado ` +
        `(se aplico la tarifa por defecto ${fmt(fallback?.inputPer1M ?? 0)}/${fmt(fallback?.outputPer1M ?? 0)} por 1M). Agrega su tarifa.`);
    }
    // A3: DeepSeek auto-applies context caching -> repeated persona prefix is billed
    // at cachedInputPer1M (much lower), so the real input cost may be LOWER than this.
    if (isDeepseek(summaryModel) || isDeepseek(detailModel)) {
      notes.push('DeepSeek aplica cache de contexto automaticamente: el prefijo de persona repetido se cobra a la tarifa cachedInputPer1M (mucho menor), por lo que el costo real de entrada puede ser MENOR que el estimado (la estimacion es conservadora).');
    }
    if (basis === 'assumptions') notes.push('Sin uso real registrado este mes: se usaron supuestos por defecto (6 fragmentos, salida ~250 tokens).');

    const summaryEs =
      `Costo aproximado para "${assistantName}" (namespace ${namespace}). ` +
      `Modelo de resumen: ${summaryModel}${models.summary.expensive ? ' (TIER CARO)' : ''}; ` +
      `modelo de detalle: ${detailModel}${models.detail.expensive ? ' (TIER CARO)' : ''}. ` +
      `Costo por consulta ~ ${fmt(perQueryTotal)} (base: ${basis === 'real-usage' ? 'uso real' : 'supuestos'}). ` +
      `Ingestion (una sola vez) ~ ${fmt(ingestionCost)} para ${chunkCount} fragmentos. ` +
      `Almacenamiento mensual ~ ${fmt(storageMonthly.total)}; infraestructura ~ ${fmt(infraMonthly)}. ` +
      `Proyeccion mensual a ${queriesPerMonth} consultas/mes ~ ${fmt(projectedMonthly)}. ` +
      (unratedModels.size
        ? `ADVERTENCIA: ${Array.from(unratedModels).join(', ')} sin tarifa; el costo LLM puede estar subestimado. `
        : '') +
      `Define tu propio margen para el precio de renta sugerido.`;

    return {
      assistantId, assistantName, namespace, currency: pricing.currency,
      // USD stays canonical; MXN is derived client-side as usd * fxUsdToMxn.
      fxUsdToMxn: pricing.fx?.usdToMxn?.rate ?? null,
      basis, stale,
      models,
      /** models with no rate (fallback applied) -> the UI flags them loudly. */
      unratedModels: Array.from(unratedModels),
      realUsage: usage
        ? {
            month: usage.month ?? ym,
            queries: realQueries,
            embedTokens: Number(usage.embedTokens ?? 0),
            vectorReads: Number(usage.vectorReads ?? 0),
            stages: usage.stages ?? {},
            models: usage.models ?? {},
          }
        : null,
      ingestion: { chunkCount, estTokens: ingestTokens, cost: round(ingestionCost) },
      perQuery: {
        llm: round(perQueryLlm), embedding: round(perQueryEmbed),
        vectorReads: round(perQueryReads), total: round(perQueryTotal),
      },
      storageMonthly,
      infraMonthly: { invocations, cost: infraMonthly },
      totals: {
        avgCostPerInteraction: round(perQueryTotal),
        queriesPerMonth,
        projectedMonthly,
        // Left for the admin to set their own margin on top of cost.
        suggestedRentalPrice: null,
      },
      summaryEs,
      notes,
    };
  },
);
