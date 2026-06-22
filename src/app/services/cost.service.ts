import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctionsClient } from './firebase-client';

/**
 * Client transport for the cost model. All figures are APPROXIMATE ("aproximado")
 * -- the server estimates tokens (providers return no usage). No secrets here;
 * the callables are admin-gated server-side.
 */

export interface MoneyRate { value: number; lastUpdated: number; source: string; }
export interface LlmRate {
  inputPer1M: number; outputPer1M: number; lastUpdated: number; source: string;
  inputPer1MAbove200k?: number; outputPer1MAbove200k?: number;
  cachedInputPer1M?: number; note?: string;
}
export interface EmbeddingRate { per1MTokens: number; lastUpdated: number; source: string; }

export interface PricingConfig {
  currency: string;
  staleAfterDays: number;
  embedding: { textEmbedding004: EmbeddingRate };
  llm: Record<string, LlmRate>;
  /** optional: older docs may predate these fields (backfilled server-side on load). */
  fallbackLlmRate?: LlmRate;
  firestore: { storagePerGiBMonth: MoneyRate; readPer100kOps: MoneyRate; writePer100kOps: MoneyRate; };
  storage: { cloudStoragePerGiBMonth: MoneyRate; egressPerGiB: MoneyRate; };
  functions: { invocationCost: MoneyRate; gbSecondCost: MoneyRate; };
  tts: { piperBrowser: MoneyRate };
  fx?: { usdToMxn: FxRate };
  updatedAt?: number;
}

export interface FxRate { rate: number; lastUpdated: number; source: string; }

export interface StaleFlag { path: string; ageDays: number; lastUpdated: number; }

export interface ProjectionResult {
  assistantId: string;
  assistantName: string;
  namespace: string;
  currency: string;
  /** USD->MXN rate from config/pricing; MXN is derived = usd * this. null if unset. */
  fxUsdToMxn: number | null;
  basis: 'real-usage' | 'assumptions';
  stale: StaleFlag[];
  models: {
    summary: { model: string; provider: string; rated: boolean; expensive: boolean };
    detail: { model: string; provider: string; rated: boolean; expensive: boolean };
  };
  unratedModels: string[];
  realUsage: {
    month: string; queries: number; embedTokens: number; vectorReads: number;
    stages: Record<string, { inTokens: number; outTokens: number }>;
    models: Record<string, { model: string; provider: string; inTokens: number; outTokens: number }>;
  } | null;
  ingestion: { chunkCount: number; estTokens: number; cost: number };
  perQuery: { llm: number; embedding: number; vectorReads: number; total: number };
  storageMonthly: { vectorsAndChunks: number; documents: number; media: number; conversationHistory: number; total: number };
  infraMonthly: { invocations: number; cost: number };
  totals: { avgCostPerInteraction: number; queriesPerMonth: number; projectedMonthly: number; suggestedRentalPrice: number | null };
  summaryEs: string;
  notes: string[];
}

@Injectable({ providedIn: 'root' })
export class CostService {
  async getPricing(): Promise<{ pricing: PricingConfig; stale: StaleFlag[] }> {
    const callable = httpsCallable<unknown, { pricing: PricingConfig; stale: StaleFlag[] }>(
      getFirebaseFunctionsClient(), 'getPricing',
    );
    const res = await callable({});
    return res.data;
  }

  async updatePricingRate(
    category: 'embedding' | 'llm' | 'firestore' | 'storage' | 'functions' | 'tts' | 'fx',
    key: string, field: string, value: number,
  ): Promise<{ pricing: PricingConfig; stale: StaleFlag[] }> {
    const callable = httpsCallable<
      { category: string; key: string; field: string; value: number },
      { pricing: PricingConfig; stale: StaleFlag[] }
    >(getFirebaseFunctionsClient(), 'updatePricingRate');
    const res = await callable({ category, key, field, value });
    return res.data;
  }

  async projectAssistantCost(assistantId: string, queriesPerMonth?: number): Promise<ProjectionResult> {
    const callable = httpsCallable<{ assistantId: string; queriesPerMonth?: number }, ProjectionResult>(
      getFirebaseFunctionsClient(), 'projectAssistantCost',
    );
    const res = await callable({ assistantId, queriesPerMonth });
    return res.data;
  }
}
