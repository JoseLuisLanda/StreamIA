import { Injectable, signal } from '@angular/core';
import { collection, doc, getDoc, getDocs, getFirestore } from 'firebase/firestore';
import { getDownloadURL, listAll, ref } from 'firebase/storage';
import { getFirebaseApp, getFirebaseStorageClient } from './firebase-client';
import { AssistantConfig } from '../lib/rag/rag.models';
import { getAssistantId } from '../lib/rag/rag.config';

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
      const cfg = this.mapDoc(assistantId, snap.data() as Partial<AssistantConfig>);
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
      const list = snap.docs.map((d) => this.mapDoc(d.id, d.data() as Partial<AssistantConfig>));
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

  private mapDoc(id: string, data: Partial<AssistantConfig>): AssistantConfig {
    return {
      id,
      name: data.name ?? id,
      role: data.role,
      description: data.description,
      avatarId: data.avatarId ?? 'alex-ia',
      ragCollection: data.ragCollection ?? id,
      systemPrompt: data.systemPrompt,
      language: data.language ?? 'es',
      voice: data.voice ?? '',
      thumbnail: data.thumbnail,
      topicTag: data.topicTag,
      activationCommand: data.activationCommand,
      leadGestureId: data.leadGestureId,
      tailGestureId: data.tailGestureId,
      allowAvatarSwitch: data.allowAvatarSwitch ?? true,
    };
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
