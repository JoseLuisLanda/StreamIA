import { Injectable } from '@angular/core';
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFirestoreClient, getFirebaseFunctionsClient } from './firebase-client';
import { LlmConfigProfile, LlmKeyRef, TestProfileResult } from '../lib/llm-admin/llm-profile.models';
import { LlmProviderId } from '../lib/llm-admin/llm-admin.models';

/**
 * Client transport for LLM config PROFILES. Reads non-secret profile metadata
 * directly from Firestore (`llm_profiles`); all writes (incl. key values to
 * Secret Manager) go through admin-gated callables. Key values are write-only.
 */
@Injectable({ providedIn: 'root' })
export class LlmProfileService {
  private db() {
    return getFirebaseFirestoreClient();
  }

  /** All profiles (admin view). */
  async listAll(): Promise<LlmConfigProfile[]> {
    const snap = await getDocs(collection(this.db(), 'llm_profiles'));
    return snap.docs.map((d) => mapProfile(d.id, d.data()));
  }

  /** Global profiles only. */
  async listGlobal(): Promise<LlmConfigProfile[]> {
    const snap = await getDocs(query(collection(this.db(), 'llm_profiles'), where('scope', '==', 'global')));
    return snap.docs.map((d) => mapProfile(d.id, d.data()));
  }

  /** Global profiles + the private profiles owned by one assistant. */
  async listForAssistant(assistantId: string): Promise<LlmConfigProfile[]> {
    const all = await this.listAll();
    return all.filter((p) => p.scope === 'global' || p.ownerAssistantId === assistantId);
  }

  /** Read the GLOBAL per-stage default profile ids (config/ragModels). */
  async getStageDefaults(): Promise<{ summaryProfileId: string; detailProfileId: string }> {
    try {
      const snap = await getDoc(doc(this.db(), 'config', 'ragModels'));
      const d = (snap.data() as any) ?? {};
      return {
        summaryProfileId: (d.summaryProfileId ?? '').toString(),
        detailProfileId: (d.detailProfileId ?? '').toString(),
      };
    } catch {
      return { summaryProfileId: '', detailProfileId: '' };
    }
  }

  /** Persist the GLOBAL per-stage default profile ids (admin-gated by rules). */
  async saveStageDefaults(v: { summaryProfileId: string; detailProfileId: string }): Promise<void> {
    await setDoc(
      doc(this.db(), 'config', 'ragModels'),
      {
        summaryProfileId: (v.summaryProfileId || '').trim() || null,
        detailProfileId: (v.detailProfileId || '').trim() || null,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  async saveProfile(p: LlmConfigProfile): Promise<string> {
    const fn = httpsCallable<any, { id: string }>(getFirebaseFunctionsClient(), 'saveLlmProfile');
    try {
      const res = await fn({
        id: p.id || undefined,
        name: p.name,
        scope: p.scope,
        ownerAssistantId: p.ownerAssistantId,
        provider: p.provider,
        model: p.model,
        temperature: p.temperature,
        maxOutputTokens: p.maxOutputTokens,
        topP: p.topP,
        baseUrl: p.baseUrl,
      });
      return res.data.id;
    } catch (e: any) {
      throw new Error(describe(e));
    }
  }

  async deleteProfile(id: string): Promise<void> {
    await this.call('deleteLlmProfile', { id });
  }

  async setKey(profileId: string, label: string, key: string, keyId?: string): Promise<void> {
    await this.call('setLlmProfileKey', { profileId, keyId, label, key });
  }

  async setActiveKey(profileId: string, keyId: string): Promise<void> {
    await this.call('setActiveLlmKey', { profileId, keyId });
  }

  async deleteKey(profileId: string, keyId: string): Promise<void> {
    await this.call('deleteLlmProfileKey', { profileId, keyId });
  }

  async setSystemDefault(id: string): Promise<void> {
    await this.call('setSystemDefaultProfile', { id });
  }

  async test(profileId: string): Promise<TestProfileResult> {
    const fn = httpsCallable<{ profileId: string }, TestProfileResult>(
      getFirebaseFunctionsClient(),
      'testLlmProfile',
    );
    try {
      return (await fn({ profileId })).data;
    } catch (e: any) {
      return { ok: false, error: describe(e) };
    }
  }

  /**
   * List the LIVE, valid models for a provider via the admin callable (key read
   * server-side from Secret Manager; never exposed). Returns bare model ids.
   */
  async listModels(provider: string, profileId: string, baseUrl?: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const fn = httpsCallable<{ provider: string; profileId: string; baseUrl?: string }, { ok: boolean; models: string[]; error?: string }>(
      getFirebaseFunctionsClient(),
      'listProviderModels',
    );
    try {
      return (await fn({ provider, profileId, baseUrl })).data;
    } catch (e: any) {
      return { ok: false, models: [], error: describe(e) };
    }
  }

  async migrateLegacy(): Promise<{ ok: boolean; message: string; profileId?: string }> {
    const fn = httpsCallable<unknown, { ok: boolean; message: string; profileId?: string }>(
      getFirebaseFunctionsClient(),
      'migrateLegacyLlmConfig',
    );
    try {
      return (await fn({})).data;
    } catch (e: any) {
      return { ok: false, message: describe(e) };
    }
  }

  private async call(name: string, args: any): Promise<void> {
    const fn = httpsCallable(getFirebaseFunctionsClient(), name);
    try {
      await fn(args);
    } catch (e: any) {
      throw new Error(describe(e));
    }
  }
}

function describe(e: any): string {
  const code = e?.code ? ` (${e.code})` : '';
  const detail = e?.details
    ? `: ${typeof e.details === 'string' ? e.details : JSON.stringify(e.details)}`
    : '';
  return `${e?.message ?? String(e)}${code}${detail}`;
}

function mapProfile(id: string, d: any): LlmConfigProfile {
  const keys: LlmKeyRef[] = Array.isArray(d?.keys)
    ? d.keys.map((k: any) => ({
        id: String(k?.id ?? ''),
        label: String(k?.label ?? ''),
        secretName: String(k?.secretName ?? ''),
        active: !!k?.active,
        updatedAt: toMs(k?.updatedAt),
      }))
    : [];
  return {
    id,
    name: d?.name ?? id,
    scope: d?.scope === 'assistant' ? 'assistant' : 'global',
    ownerAssistantId: d?.ownerAssistantId ?? undefined,
    provider: (d?.provider as LlmProviderId) ?? 'openai',
    model: d?.model ?? 'gpt-4o-mini',
    temperature: num(d?.temperature, 0.2),
    maxOutputTokens: num(d?.maxOutputTokens, 1024),
    topP: d?.topP == null ? undefined : Number(d.topP),
    baseUrl: d?.baseUrl ?? undefined,
    keys,
    isSystemDefault: !!d?.isSystemDefault,
    createdAt: toMs(d?.createdAt),
    updatedAt: toMs(d?.updatedAt),
  };
}

function num(v: any, fb: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
function toMs(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return undefined;
}
