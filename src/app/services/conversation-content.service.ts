import { Injectable } from '@angular/core';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFirestoreClient, getFirebaseFunctionsClient } from './firebase-client';
import {
  AssistantConvContent,
  CACHE_SCHEMA,
  CachedConvContent,
  ConvKind,
  GlobalResponses,
  PhraseEntry,
  SuggestedPrompt,
  SyncState,
  UseCustomResponses,
  defaultUseCustom,
  emptyContent,
  normalizeUseCustom,
  seedPhrases,
  seedSuggestedPrompts,
} from '../lib/conversation-content/conv-content.models';
import { cacheGet, cachePut, cacheDelete } from '../lib/conversation-content/conv-content-cache';

const GLOBAL_DOC = 'responses'; // config/responses

/**
 * Three-layer conversational content with flag-driven resolution + read-through
 * cache.
 *
 *   - Per-category flag `assistants/{id}.useCustomResponses[kind]`:
 *       true  -> read that assistant subcollection (custom).
 *       false -> serve the editable GLOBAL defaults (config/responses) with NO
 *                subcollection read.
 *   - Resolution order: in-session memory -> IndexedDB -> Firestore.
 *   - Warm loads: one cheap read of the assistant doc (contentModifiedAt + flags)
 *     plus the global doc modifiedAt -> decide in-sync vs changes. Zero
 *     subcollection reads when in sync.
 */
@Injectable({ providedIn: 'root' })
export class ConversationContentService {
  private mem = new Map<string, CachedConvContent>();
  private globalCache: GlobalResponses | null = null;

  private db() {
    return getFirebaseFirestoreClient();
  }

  // =========================================================== read-through

  async getContent(assistantId: string): Promise<CachedConvContent> {
    const m = this.mem.get(assistantId);
    if (m) return m;
    const cached = await cacheGet(assistantId);
    if (validEnvelope(cached)) {
      this.mem.set(assistantId, cached!);
      return cached!;
    }
    return this.sync(assistantId); // miss OR stale/incompatible envelope -> full sync
  }

  /**
   * Cheap change detection: assistant doc (contentModifiedAt + flags) + global
   * doc modifiedAt vs the cache. No subcollection reads.
   */
  async checkForUpdates(assistantId: string): Promise<SyncState> {
    const cached = this.mem.get(assistantId) ?? (await cacheGet(assistantId));
    if (!validEnvelope(cached)) return 'no-cache';
    if (!this.mem.has(assistantId)) this.mem.set(assistantId, cached!);

    const [meta, globalAt] = await Promise.all([
      this.readAssistantMeta(assistantId),
      this.readGlobalModifiedAt(),
    ]);
    const flagsChanged = CONV_KINDS_changed(cached.flags, meta.flags);
    const assistantNewer = meta.contentModifiedAt > cached.syncedModifiedAt;
    // Global changes only matter for categories currently resolving to global.
    const usesGlobal = (Object.keys(meta.flags) as (keyof UseCustomResponses)[]).some((k) => !meta.flags[k]);
    const globalNewer = usesGlobal && globalAt > cached.syncedGlobalAt;
    return assistantNewer || globalNewer || flagsChanged ? 'changes' : 'in-sync';
  }

  /**
   * Full sync: read flags, then per category fetch the subcollection (flag true)
   * or use the global default (flag false). Always a full re-fetch.
   */
  async sync(assistantId: string): Promise<CachedConvContent> {
    const [meta, globals] = await Promise.all([
      this.readAssistantMeta(assistantId),
      this.loadGlobalResponses(),
    ]);
    const flags = meta.flags;

    const [greetings, infoAcks, farewells, suggested] = await Promise.all([
      flags.greetings ? this.fetchPhrases(assistantId, 'greetings') : Promise.resolve(globals.greetings),
      flags.infoAcknowledgements ? this.fetchPhrases(assistantId, 'infoAcknowledgements') : Promise.resolve(globals.infoAcknowledgements),
      flags.farewells ? this.fetchPhrases(assistantId, 'farewells') : Promise.resolve(globals.farewells),
      flags.suggestedPrompts ? this.fetchPrompts(assistantId) : Promise.resolve(globals.suggestedPrompts),
    ]);

    const envelope: CachedConvContent = {
      assistantId,
      cacheSchema: CACHE_SCHEMA,
      content: { greetings, infoAcknowledgements: infoAcks, farewells, suggestedPrompts: suggested },
      syncedModifiedAt: meta.contentModifiedAt,
      syncedGlobalAt: globals.modifiedAt,
      flags,
      lastSyncAt: Date.now(),
    };
    this.mem.set(assistantId, envelope);
    await cachePut(envelope);
    return envelope;
  }

  /** Which categories are currently resolving to global (for UI indicators). */
  async resolutionFlags(assistantId: string): Promise<UseCustomResponses> {
    return (await this.readAssistantMeta(assistantId)).flags;
  }

  // ============================================================ global layer

  /** Editable global defaults (config/responses) with code last-resort fallback. */
  async loadGlobalResponses(): Promise<GlobalResponses> {
    if (this.globalCache) return this.globalCache;
    try {
      const snap = await getDoc(doc(this.db(), 'config', GLOBAL_DOC));
      if (snap.exists()) {
        const d = snap.data() as any;
        const g: GlobalResponses = {
          greetings: mapPhrases(d.greetings).filter((p) => p.enabled).sort(byOrder),
          infoAcknowledgements: mapPhrases(d.infoAcknowledgements).filter((p) => p.enabled).sort(byOrder),
          farewells: mapPhrases(d.farewells).filter((p) => p.enabled).sort(byOrder),
          suggestedPrompts: mapPrompts(d.suggestedPrompts).filter((p) => p.enabled).sort(byOrder),
          modifiedAt: toMs(d.modifiedAt) ?? 0,
        };
        this.globalCache = g;
        return g;
      }
    } catch {
      /* fall through to code fallback */
    }
    return this.codeFallbackGlobals();
  }

  /** Hardcoded last-resort defaults if config/responses is missing/unreadable. */
  private codeFallbackGlobals(): GlobalResponses {
    const mk = (text: string, i: number): PhraseEntry => ({ id: `code-${i}`, text, order: i, enabled: true });
    return {
      greetings: seedPhrases('greetings').map(mk),
      infoAcknowledgements: seedPhrases('infoAcknowledgements').map(mk),
      farewells: seedPhrases('farewells').map(mk),
      suggestedPrompts: seedSuggestedPrompts().map((p, i) => ({ id: `code-${i}`, ...p, order: i, enabled: true })),
      modifiedAt: 0,
    };
  }

  /** ADMIN: read the full global doc (incl. disabled) for editing. */
  async listGlobalForEdit(): Promise<GlobalResponses> {
    const snap = await getDoc(doc(this.db(), 'config', GLOBAL_DOC));
    if (!snap.exists()) return this.codeFallbackGlobals();
    const d = snap.data() as any;
    return {
      greetings: mapPhrases(d.greetings).sort(byOrder),
      infoAcknowledgements: mapPhrases(d.infoAcknowledgements).sort(byOrder),
      farewells: mapPhrases(d.farewells).sort(byOrder),
      suggestedPrompts: mapPrompts(d.suggestedPrompts).sort(byOrder),
      modifiedAt: toMs(d.modifiedAt) ?? 0,
    };
  }

  /** Seed config/responses from code defaults if it does not exist yet. */
  async seedGlobals(): Promise<void> {
    const ref = doc(this.db(), 'config', GLOBAL_DOC);
    const snap = await getDoc(ref);
    if (snap.exists()) return;
    const g = this.codeFallbackGlobals();
    await setDoc(ref, {
      greetings: g.greetings.map(stripCode),
      infoAcknowledgements: g.infoAcknowledgements.map(stripCode),
      farewells: g.farewells.map(stripCode),
      suggestedPrompts: g.suggestedPrompts.map(stripCode),
      modifiedAt: serverTimestamp(),
    });
    this.globalCache = null;
  }

  /** Replace an entire global category array (used by the /llm-responses editor). */
  async saveGlobalCategory(kind: ConvKind, items: any[]): Promise<void> {
    await setDoc(
      doc(this.db(), 'config', GLOBAL_DOC),
      { [kind]: items, modifiedAt: serverTimestamp() },
      { merge: true },
    );
    this.globalCache = null;
  }

  // ====================================================== per-assistant CRUD

  async listForEdit(assistantId: string): Promise<AssistantConvContent> {
    const [g, i, f, s] = await Promise.all([
      this.listAllPhrases(assistantId, 'greetings'),
      this.listAllPhrases(assistantId, 'infoAcknowledgements'),
      this.listAllPhrases(assistantId, 'farewells'),
      this.listAllPrompts(assistantId),
    ]);
    return { greetings: g, infoAcknowledgements: i, farewells: f, suggestedPrompts: s };
  }

  async addPhrase(assistantId: string, kind: ConvKind, text: string, order: number): Promise<string> {
    const ref = await addDoc(collection(this.db(), 'assistants', assistantId, kind), {
      text, order, enabled: true, createdAt: serverTimestamp(),
    });
    await this.markCustom(assistantId, kind);
    return ref.id;
  }

  async addPrompt(assistantId: string, label: string, prompt: string, order: number): Promise<string> {
    const ref = await addDoc(collection(this.db(), 'assistants', assistantId, 'suggestedPrompts'), {
      label, prompt, order, enabled: true, createdAt: serverTimestamp(),
    });
    await this.markCustom(assistantId, 'suggestedPrompts');
    return ref.id;
  }

  async updateEntry(assistantId: string, kind: ConvKind, id: string, patch: Record<string, unknown>): Promise<void> {
    await updateDoc(doc(this.db(), 'assistants', assistantId, kind, id), patch);
    await this.markCustom(assistantId, kind);
  }

  async deleteEntry(assistantId: string, kind: ConvKind, id: string): Promise<void> {
    await deleteDoc(doc(this.db(), 'assistants', assistantId, kind, id));
    await this.bump(assistantId);
  }

  async reorder(assistantId: string, kind: ConvKind, idsInOrder: string[]): Promise<void> {
    const batch = writeBatch(this.db());
    idsInOrder.forEach((id, idx) => batch.update(doc(this.db(), 'assistants', assistantId, kind, id), { order: idx }));
    await batch.commit();
    await this.markCustom(assistantId, kind);
  }

  /**
   * Bulk-replace a category from AI-generated/accepted drafts: clears existing
   * subcollection docs, writes the new ones, sets the flag true, bumps marker.
   */
  async replaceCategory(
    assistantId: string,
    kind: ConvKind,
    items: Array<{ text?: string; label?: string; prompt?: string }>,
  ): Promise<void> {
    const colRef = collection(this.db(), 'assistants', assistantId, kind);
    const existing = await getDocs(colRef);
    const batch = writeBatch(this.db());
    existing.docs.forEach((d) => batch.delete(d.ref));
    items.forEach((it, i) => {
      const ref = doc(colRef);
      if (kind === 'suggestedPrompts') {
        batch.set(ref, { label: it.label ?? '', prompt: it.prompt ?? '', order: i, enabled: true, createdAt: serverTimestamp() });
      } else {
        batch.set(ref, { text: it.text ?? '', order: i, enabled: true, createdAt: serverTimestamp() });
      }
    });
    batch.set(doc(this.db(), 'assistants', assistantId), {
      useCustomResponses: { [kind]: true },
      contentModifiedAt: serverTimestamp(),
    }, { merge: true });
    await batch.commit();
    await this.invalidate(assistantId);
  }

  /** Revert a category to the global defaults: flag -> false (optionally clear docs). */
  async revertCategory(assistantId: string, kind: ConvKind, clearDocs = false): Promise<void> {
    if (clearDocs) {
      const existing = await getDocs(collection(this.db(), 'assistants', assistantId, kind));
      const batch = writeBatch(this.db());
      existing.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    await setDoc(doc(this.db(), 'assistants', assistantId), {
      useCustomResponses: { [kind]: false },
      contentModifiedAt: serverTimestamp(),
    }, { merge: true });
    await this.invalidate(assistantId);
  }

  /** Set the category flag true + bump the content marker (idempotent). */
  private async markCustom(assistantId: string, kind: ConvKind): Promise<void> {
    await setDoc(doc(this.db(), 'assistants', assistantId), {
      useCustomResponses: { [kind]: true },
      contentModifiedAt: serverTimestamp(),
    }, { merge: true });
  }

  async bump(assistantId: string): Promise<void> {
    await setDoc(doc(this.db(), 'assistants', assistantId), { contentModifiedAt: serverTimestamp() }, { merge: true });
  }

  async invalidate(assistantId: string): Promise<void> {
    this.mem.delete(assistantId);
    await cacheDelete(assistantId);
  }

  // ============================================================== internals

  private async readAssistantMeta(assistantId: string): Promise<{ contentModifiedAt: number; flags: UseCustomResponses }> {
    try {
      const snap = await getDoc(doc(this.db(), 'assistants', assistantId));
      const d = (snap.data() as any) ?? {};
      return { contentModifiedAt: toMs(d.contentModifiedAt) ?? 0, flags: normalizeUseCustom(d.useCustomResponses) };
    } catch {
      return { contentModifiedAt: 0, flags: defaultUseCustom() };
    }
  }

  private async readGlobalModifiedAt(): Promise<number> {
    try {
      const snap = await getDoc(doc(this.db(), 'config', GLOBAL_DOC));
      return toMs((snap.data() as any)?.modifiedAt) ?? 0;
    } catch {
      return 0;
    }
  }

  private async fetchPhrases(assistantId: string, kind: ConvKind): Promise<PhraseEntry[]> {
    try {
      const snap = await getDocs(collection(this.db(), 'assistants', assistantId, kind));
      return mapPhrases(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))).filter((p) => p.enabled && p.text.trim()).sort(byOrder);
    } catch { return []; }
  }

  private async fetchPrompts(assistantId: string): Promise<SuggestedPrompt[]> {
    try {
      const snap = await getDocs(collection(this.db(), 'assistants', assistantId, 'suggestedPrompts'));
      return mapPrompts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))).filter((p) => p.enabled && p.prompt.trim()).sort(byOrder);
    } catch { return []; }
  }

  private async listAllPhrases(assistantId: string, kind: ConvKind): Promise<PhraseEntry[]> {
    const snap = await getDocs(collection(this.db(), 'assistants', assistantId, kind));
    return mapPhrases(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))).sort(byOrder);
  }

  private async listAllPrompts(assistantId: string): Promise<SuggestedPrompt[]> {
    const snap = await getDocs(collection(this.db(), 'assistants', assistantId, 'suggestedPrompts'));
    return mapPrompts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))).sort(byOrder);
  }

  // ============================================================ AI generation

  /**
   * Request AI-generated DRAFTS for a category (not saved). Returns phrases or
   * label+prompt pairs depending on category.
   */
  async generate(req: {
    scope: 'global' | 'assistant';
    assistantId?: string;
    category: ConvKind;
    count?: number;
    context?: { name?: string; role?: string; description?: string; topicTag?: string; language?: string; persona?: string };
  }): Promise<{ phrases?: string[]; prompts?: Array<{ label: string; prompt: string }>; error?: string }> {
    const fn = httpsCallable<typeof req, { ok: boolean; phrases?: string[]; prompts?: Array<{ label: string; prompt: string }>; error?: string }>(
      getFirebaseFunctionsClient(),
      'generateResponses',
    );
    try {
      const res = (await fn(req)).data;
      if (!res.ok) return { error: res.error ?? 'Generation failed.' };
      return { phrases: res.phrases, prompts: res.prompts };
    } catch (e: any) {
      const code = e?.code ? ` (${e.code})` : '';
      return { error: `${e?.message ?? String(e)}${code}` };
    }
  }

  emptyContent = emptyContent;
}

/** Soft validation for generated/edited phrases (warn, never hard-block). */
export function phraseWarnings(text: string): string[] {
  const w: string[] = [];
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  if (words > 0 && words < 5) w.push('muy corta (<5 palabras)');
  if (words > 25) w.push('muy larga (>25 palabras)');
  if (/\b(mierda|puta|pendejo|joder|carajo)\b/i.test(text || '')) w.push('posible groseria');
  return w;
}

// --------------------------------------------------------------- helpers

/** A cache envelope is usable only if it matches the current schema + shape. */
function validEnvelope(c: CachedConvContent | null | undefined): c is CachedConvContent {
  return !!c && c.cacheSchema === CACHE_SCHEMA && !!c.flags && typeof c.syncedGlobalAt === 'number';
}

function CONV_KINDS_changed(a: UseCustomResponses, b: UseCustomResponses): boolean {
  return (['greetings', 'infoAcknowledgements', 'farewells', 'suggestedPrompts'] as (keyof UseCustomResponses)[])
    .some((k) => !!a[k] !== !!b[k]);
}

function byOrder(a: { order: number }, b: { order: number }): number { return a.order - b.order; }

function mapPhrases(arr: any): PhraseEntry[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((x, i) => ({
    id: String(x?.id ?? `idx-${i}`),
    text: String(x?.text ?? ''),
    order: Number(x?.order ?? i),
    enabled: x?.enabled !== false,
    createdAt: toMs(x?.createdAt),
  }));
}
function mapPrompts(arr: any): SuggestedPrompt[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((x, i) => ({
    id: String(x?.id ?? `idx-${i}`),
    label: String(x?.label ?? ''),
    prompt: String(x?.prompt ?? ''),
    order: Number(x?.order ?? i),
    enabled: x?.enabled !== false,
    createdAt: toMs(x?.createdAt),
  }));
}
function stripCode<T extends { id: string }>(o: T): any {
  const { id, ...rest } = o as any;
  return rest;
}
function toMs(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return undefined;
}
