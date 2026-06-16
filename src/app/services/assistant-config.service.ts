import { Injectable, signal } from '@angular/core';
import { collection, deleteDoc, doc, getDoc, getDocs, getFirestore, serverTimestamp, setDoc } from 'firebase/firestore';
import { getDownloadURL, listAll, ref } from 'firebase/storage';
import { getFirebaseApp, getFirebaseStorageClient } from './firebase-client';
import { AssistantConfig } from '../lib/rag/rag.models';
import { getAssistantId } from '../lib/rag/rag.config';
import { ASSISTANT_SCHEMA_VERSION, migrateAssistantData } from '../lib/rag/assistant-schema';

/**
 * Loads public assistant configurations from Firestore (`assistants/{id}`).
 * Each assistant = an avatar + RAG namespace + persona (systemPrompt) + voice +
 * lead/tail. The /assistants selector lists them; the Function reads
 * ragCollection + systemPrompt server-side so a tampered client can't change the
 * namespace or persona.
 */
@Injectable({ providedIn: 'root' })
export class AssistantConfigService {
  /** Currently active assistant, or null if none/failed to load. */
  readonly current = signal<AssistantConfig | null>(null);
  readonly error = signal<string>('');

  private cache = new Map<string, AssistantConfig>();
  private thumbCache = new Map<string, string | null>();
  private previewMap: Record<string, string> | null = null;

  /** Storage folder of card preview images (basename matched to avatarId/id/name). */
  static readonly PREVIEW_DIR = 'avatars/avatar_preview';

  /**
   * List the preview images under PREVIEW_DIR and return a map of
   * lowercased-basename (no extension) -> download URL. Cached for the session.
   * Best-effort: returns {} on permission/offline errors.
   */
  async listPreviewImages(dir: string = AssistantConfigService.PREVIEW_DIR): Promise<Record<string, string>> {
    if (this.previewMap) return this.previewMap;
    const map: Record<string, string> = {};
    try {
      const res = await listAll(ref(getFirebaseStorageClient(), dir));
      await Promise.all(
        res.items.map(async (item) => {
          const base = item.name.replace(/\.[^.]+$/, '').toLowerCase();
          try {
            map[base] = await getDownloadURL(item);
          } catch {
            /* skip unreadable item */
          }
        }),
      );
    } catch (e) {
      console.warn('[assistant] preview listing failed:', e);
    }
    this.previewMap = map;
    return map;
  }

  /**
   * Resolve a card thumbnail for an assistant: prefer a preview image whose
   * basename matches the avatarId (then assistant id, then name), then an
   * explicit `thumbnail` field, else null.
   */
  async resolveCardThumbnail(asst: AssistantConfig): Promise<string | null> {
    const previews = await this.listPreviewImages();
    const keys = [asst.avatarId, asst.id, asst.name].filter(Boolean).map((k) => String(k).toLowerCase());
    for (const k of keys) {
      if (previews[k]) return previews[k];
    }
    if (asst.thumbnail) return this.resolveThumbnail(asst.thumbnail);
    return null;
  }

  /** Load (and cache) a single assistant config. Returns null if missing. */
  async load(assistantId: string = getAssistantId()): Promise<AssistantConfig | null> {
    const cached = this.cache.get(assistantId);
    if (cached) {
      this.current.set(cached);
      return cached;
    }
    this.error.set('');
    try {
      const db = getFirestore(getFirebaseApp());
      const snap = await getDoc(doc(db, 'assistants', assistantId));
      if (!snap.exists()) {
        // Fall back to a static entry if one matches (keeps dev working).
        const stat = STATIC_ASSISTANTS.find((a) => a.id === assistantId);
        if (stat) {
          this.cache.set(assistantId, stat);
          this.current.set(stat);
          return stat;
        }
        this.error.set(`Assistant "${assistantId}" not found.`);
        return null;
      }
      const cfg = this.mapDoc(assistantId, this.lazyMigrate(assistantId, snap.data()) as Partial<AssistantConfig>);
      this.cache.set(assistantId, cfg);
      this.current.set(cfg);
      return cfg;
    } catch (e: any) {
      const msg = e?.code === 'permission-denied'
        ? 'Not authorized to read this assistant (check Firestore rules / sign-in).'
        : (e?.message ?? String(e));
      this.error.set(msg);
      console.warn('[assistant] load failed:', msg);
      const stat = STATIC_ASSISTANTS.find((a) => a.id === assistantId);
      return stat ?? null;
    }
  }

  /**
   * List all assistants for the selector. Reads `assistants/*`; if empty or
   * unreachable, returns the STATIC_ASSISTANTS fallback so the screen is never
   * blank in dev. Returns [] only if both yield nothing (real empty state).
   */
  async listAssistants(): Promise<AssistantConfig[]> {
    this.error.set('');
    try {
      const db = getFirestore(getFirebaseApp());
      const snap = await getDocs(collection(db, 'assistants'));
      const list = snap.docs.map((d) => this.mapDoc(d.id, this.lazyMigrate(d.id, d.data()) as Partial<AssistantConfig>));
      list.forEach((c) => this.cache.set(c.id, c));
      if (list.length) return list;
      return STATIC_ASSISTANTS;
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
      console.warn('[assistant] list failed, using static fallback:', this.error());
      return STATIC_ASSISTANTS;
    }
  }

  /** Resolve a thumbnail: pass-through http(s) URL, else resolve a Storage path. */
  async resolveThumbnail(thumbnail?: string): Promise<string | null> {
    if (!thumbnail) return null;
    if (/^https?:\/\//i.test(thumbnail)) return thumbnail;
    if (this.thumbCache.has(thumbnail)) return this.thumbCache.get(thumbnail)!;
    try {
      const url = await getDownloadURL(ref(getFirebaseStorageClient(), thumbnail));
      this.thumbCache.set(thumbnail, url);
      return url;
    } catch {
      this.thumbCache.set(thumbnail, null);
      return null;
    }
  }

  /** Create or update an assistant document (admin editor). */
  async save(cfg: AssistantConfig): Promise<AssistantConfig> {
    const id = (cfg.id || '').trim();
    if (!id) throw new Error('Assistant id is required.');
    if (!cfg.avatarId) throw new Error('Select an avatar.');
    // 1:1 namespace ownership: default the owned namespace to the assistant id.
    const ns = (cfg.ragCollection || cfg.ragNamespace || id).trim();
    if (!ns) throw new Error('Select a RAG namespace.');
    const db = getFirestore(getFirebaseApp());
    const now = Date.now();
    await setDoc(
      doc(db, 'assistants', id),
      {
        name: cfg.name ?? id,
        role: cfg.role ?? '',
        description: cfg.description ?? '',
        avatarId: cfg.avatarId,
        ragCollection: ns,
        ragNamespace: ns,
        llmProfileId: cfg.llmProfileId ?? null,
        // New docs are stamped at the current schema with all fields present.
        schemaVersion: ASSISTANT_SCHEMA_VERSION,
        useCustomResponses: cfg.useCustomResponses ?? {
          greetings: false, infoAcknowledgements: false, farewells: false, suggestedPrompts: false,
        },
        systemPrompt: cfg.systemPrompt ?? '',
        greetingResponse: cfg.greetingResponse ?? null,
        greetingKeywords: cfg.greetingKeywords ?? null,
        farewellKeywords: cfg.farewellKeywords ?? null,
        queryVerbs: cfg.queryVerbs ?? null,
        voice: cfg.voice ?? '',
        language: cfg.language ?? 'es',
        topicTag: cfg.topicTag ?? null,
        leadGestureId: cfg.leadGestureId ?? null,
        tailGestureId: cfg.tailGestureId ?? null,
        activationCommand: cfg.activationCommand ?? null,
        allowAvatarSwitch: cfg.allowAvatarSwitch ?? true,
        enabled: cfg.enabled ?? true,
        createdAt: cfg.createdAt ?? now,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    this.cache.set(id, { ...cfg, id, createdAt: cfg.createdAt ?? now, updatedAt: now });
    return this.cache.get(id)!;
  }

  /** Delete an assistant document. */
  async deleteAssistant(id: string): Promise<void> {
    await deleteDoc(doc(getFirestore(getFirebaseApp()), 'assistants', id));
    this.cache.delete(id);
  }

  /**
   * Apply schema migrations to a raw doc on read. Returns the upgraded data for
   * immediate use, and lazily WRITES BACK the patch so the doc self-heals
   * permanently (fire-and-forget; ignored if the user can't write).
   */
  private lazyMigrate(id: string, raw: any): any {
    const { data, changed } = migrateAssistantData(raw);
    if (changed) void this.writeBackMigration(id, data);
    return data;
  }

  private async writeBackMigration(id: string, data: any): Promise<void> {
    try {
      const db = getFirestore(getFirebaseApp());
      const patch: any = {
        useCustomResponses: data.useCustomResponses,
        schemaVersion: ASSISTANT_SCHEMA_VERSION,
      };
      if (data.__needsContentModified) patch.contentModifiedAt = serverTimestamp();
      await setDoc(doc(db, 'assistants', id), patch, { merge: true });
    } catch {
      /* read-only user / offline -> stays in-memory migrated, harmless */
    }
  }

  private mapDoc(id: string, data: Partial<AssistantConfig>): AssistantConfig {
    return {
      id,
      name: data.name ?? id,
      role: data.role,
      description: data.description,
      avatarId: data.avatarId ?? 'alex-ia',
      ragCollection: data.ragCollection ?? data.ragNamespace ?? id,
      ragNamespace: data.ragNamespace ?? data.ragCollection ?? id,
      llmProfileId: data.llmProfileId ?? undefined,
      useCustomResponses: data.useCustomResponses ?? undefined,
      systemPrompt: data.systemPrompt,
      greetingResponse: data.greetingResponse,
      greetingKeywords: data.greetingKeywords,
      farewellKeywords: data.farewellKeywords,
      queryVerbs: data.queryVerbs,
      language: data.language ?? 'es',
      voice: data.voice ?? '',
      thumbnail: data.thumbnail,
      topicTag: data.topicTag,
      activationCommand: data.activationCommand,
      leadGestureId: data.leadGestureId,
      tailGestureId: data.tailGestureId,
      allowAvatarSwitch: data.allowAvatarSwitch ?? true,
      enabled: data.enabled ?? true,
      schemaVersion: (data as any).schemaVersion,
      createdAt: this.toMs((data as any).createdAt),
      updatedAt: this.toMs((data as any).updatedAt),
    };
  }

  private toMs(v: any): number | undefined {
    if (v == null) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v?.toMillis === 'function') return v.toMillis();
    if (typeof v?.seconds === 'number') return v.seconds * 1000;
    return undefined;
  }
}

/**
 * Static fallback assistants (dev only; used when `assistants/*` is empty or
 * unreachable). Mirror the Firestore document shape. ragCollection should match
 * an ingested RAG namespace for real answers; persona shapes tone/role.
 */
export const STATIC_ASSISTANTS: AssistantConfig[] = [
  {
    id: 'furniture-advisor',
    name: 'Sofia',
    role: 'Asesora de Muebles',
    description: 'Experta en diseno de interiores; te ayuda a elegir del catalogo.',
    avatarId: 'mar-ia',
    ragCollection: 'catalogo',
    systemPrompt:
      'Eres Sofia, una asesora experta de una tienda de muebles. Ayudas a elegir productos del catalogo, das medidas y precios cuando estan en el contexto, con un tono calido y comercial.',
    language: 'es',
    voice: '',
    topicTag: 'Catalogo',
    leadGestureId: 'thinking',
    tailGestureId: 'yes',
    allowAvatarSwitch: true,
  },
  {
    id: 'institutional',
    name: 'Alex',
    role: 'Asistente Institucional',
    description: 'Proporciona informacion general sobre la organizacion y servicios.',
    avatarId: 'alex-ia',
    ragCollection: 'institucional',
    systemPrompt:
      'Eres Alex, asistente institucional. Respondes con informacion general de la organizacion y sus servicios, en tono claro y profesional.',
    language: 'es',
    voice: '',
    topicTag: 'Informacion',
    leadGestureId: 'thinking',
    tailGestureId: 'yes',
    allowAvatarSwitch: true,
  },
  {
    id: 'museum-guide',
    name: 'Elena',
    role: 'Guia de Museo',
    description: 'Conocimiento profundo sobre historia del arte y las galerias.',
    avatarId: 'luis-ia',
    ragCollection: 'museo',
    systemPrompt:
      'Eres Elena, guia de museo. Compartes datos de historia del arte y de las galerias, con un tono cercano y divulgativo.',
    language: 'es',
    voice: '',
    topicTag: 'Historia',
    leadGestureId: 'thinking',
    tailGestureId: 'yes',
    allowAvatarSwitch: true,
  },
];
