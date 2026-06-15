import { Injectable } from '@angular/core';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFirestoreClient, getFirebaseFunctionsClient } from './firebase-client';
import {
  DEFAULT_LLM_CONFIG,
  KeyStatus,
  LlmConfig,
  LlmProviderId,
  TestConnectionResult,
} from '../lib/llm-admin/llm-admin.models';

/**
 * Client transport for the LLM Admin panel.
 *
 * - Non-secret config (provider/model/params) is read/written directly to
 *   Firestore `config/llm`.
 * - The API key is write-only via the `setLlmApiKey` callable (stored in Secret
 *   Manager server-side); it is NEVER read back. We only read `keyStatus` to show
 *   a masked "configured" state.
 * - `testLlmConnection` runs a tiny server-side generation and returns the real
 *   provider error for diagnosis.
 */
@Injectable({ providedIn: 'root' })
export class LlmAdminService {
  private db() {
    return getFirebaseFirestoreClient();
  }

  /** Load the non-secret config (defaults applied) + per-provider key status. */
  async load(): Promise<{ config: LlmConfig; keyStatus: KeyStatus }> {
    try {
      const snap = await getDoc(doc(this.db(), 'config', 'llm'));
      if (!snap.exists()) return { config: { ...DEFAULT_LLM_CONFIG }, keyStatus: {} };
      const d = snap.data() as any;
      const config: LlmConfig = {
        provider: (d.provider as LlmProviderId) ?? DEFAULT_LLM_CONFIG.provider,
        model: d.model ?? DEFAULT_LLM_CONFIG.model,
        temperature: num(d.temperature, DEFAULT_LLM_CONFIG.temperature),
        maxOutputTokens: num(d.maxOutputTokens, DEFAULT_LLM_CONFIG.maxOutputTokens),
        topP: d.topP == null ? DEFAULT_LLM_CONFIG.topP : Number(d.topP),
        baseUrl: d.baseUrl ?? undefined,
        updatedAt: toMs(d.updatedAt),
        updatedBy: d.updatedBy ?? undefined,
      };
      const keyStatus = normalizeKeyStatus(d.keyStatus);
      return { config, keyStatus };
    } catch {
      return { config: { ...DEFAULT_LLM_CONFIG }, keyStatus: {} };
    }
  }

  /** Save NON-SECRET config only. Never writes any key material. */
  async saveConfig(config: LlmConfig, updatedBy?: string): Promise<void> {
    await setDoc(
      doc(this.db(), 'config', 'llm'),
      {
        provider: config.provider,
        model: (config.model ?? '').trim(),
        temperature: Number(config.temperature),
        maxOutputTokens: Number(config.maxOutputTokens),
        topP: config.topP == null ? null : Number(config.topP),
        baseUrl: config.baseUrl?.trim() || null,
        updatedAt: serverTimestamp(),
        updatedBy: updatedBy ?? null,
      },
      { merge: true },
    );
  }

  /** Submit a key to Secret Manager via the callable (write-only). */
  async setApiKey(provider: LlmProviderId, apiKey: string): Promise<void> {
    const callable = httpsCallable<{ provider: LlmProviderId; apiKey: string }, { ok: boolean }>(
      getFirebaseFunctionsClient(),
      'setLlmApiKey',
    );
    try {
      await callable({ provider, apiKey });
    } catch (e: any) {
      throw new Error(describeCallableError(e));
    }
  }

  /** Test the configured (or overridden) provider; returns the real result. */
  async testConnection(override?: Partial<LlmConfig>): Promise<TestConnectionResult> {
    const callable = httpsCallable<{ override?: Partial<LlmConfig> }, TestConnectionResult>(
      getFirebaseFunctionsClient(),
      'testLlmConnection',
    );
    try {
      const res = await callable({ override });
      return res.data;
    } catch (e: any) {
      return { ok: false, provider: override?.provider ?? '', model: override?.model ?? '', error: describeCallableError(e) };
    }
  }
}

function describeCallableError(e: any): string {
  const code = e?.code ? ` (${e.code})` : '';
  const detail = e?.details
    ? `: ${typeof e.details === 'string' ? e.details : JSON.stringify(e.details)}`
    : '';
  return `${e?.message ?? String(e)}${code}${detail}`;
}

function normalizeKeyStatus(raw: any): KeyStatus {
  const out: KeyStatus = {};
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      const v = raw[k] ?? {};
      out[k as LlmProviderId] = { updatedAt: toMs(v.updatedAt), updatedBy: v.updatedBy };
    }
  }
  return out;
}

function num(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function toMs(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return undefined;
}
