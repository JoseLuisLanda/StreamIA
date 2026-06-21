import { Injectable, computed, signal } from '@angular/core';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { getFirebaseFirestoreClient } from './firebase-client';
import { PIPER_VOICES } from './tts-lipsync.service';

/** A selectable Piper voice. `id` is a vits-web VoiceId (e.g. "es_ES-sharvard-medium"). */
export interface VoiceOption { id: string; label: string; lang: string; }
/** Voices grouped by language for <optgroup> rendering. */
export interface VoiceGroup { lang: string; langLabel: string; voices: VoiceOption[]; }

/** How the current catalog was resolved (for diagnostics / UI hints). */
export type CatalogSource = 'seed' | 'loading' | 'manifest' | 'cache' | 'error';

/** Firestore backup location for the catalog LIST (not the model binaries). */
const CATALOG_COL = 'config';
const CATALOG_DOC = 'voiceCatalog';

/** Human-readable language headers for the dropdown groups. ASCII only. */
const LANG_LABELS: Record<string, string> = {
  es: 'Espanol', en: 'English', de: 'Deutsch', fr: 'Francais', it: 'Italiano',
  pt: 'Portugues', ru: 'Russian', zh: 'Chinese', ca: 'Catalan', nl: 'Dutch',
};

/** Last-resort seed: mirrors the previously hardcoded PIPER_VOICES (6 voices). */
function seedVoices(): VoiceOption[] {
  const out: VoiceOption[] = [];
  for (const lang of Object.keys(PIPER_VOICES) as (keyof typeof PIPER_VOICES)[]) {
    for (const v of PIPER_VOICES[lang]) out.push({ id: v.id, label: v.label, lang });
  }
  return out;
}

/**
 * Dynamic, self-maintaining Piper voice catalog (the LIST only).
 *
 * Resolution order (load):
 *   1) PRIMARY  -> vits-web voices() (fetches voices.json from Hugging Face), mapped to
 *                  {id,label,lang}. On success, the list is BACKED UP to Firestore
 *                  config/voiceCatalog (best-effort).
 *   2) FALLBACK -> Firestore config/voiceCatalog (if the HF manifest is unreachable).
 *   3) LAST RESORT -> the hardcoded seed (current 6 voices), so the dropdown is never empty.
 *
 * Only the LIST is sourced here. Voice ids stay vits-web VoiceIds; model binaries still
 * download from HF on first use and cache in OPFS (synthesis path unchanged).
 */
@Injectable({ providedIn: 'root' })
export class VoiceCatalogService {
  /** Full catalog across ALL languages (seed until load() resolves). */
  readonly all = signal<VoiceOption[]>(seedVoices());
  /** Where `all` currently came from. */
  readonly source = signal<CatalogSource>('seed');
  /** Languages surfaced (in display order). Default ES then EN; open to extension:
   *  set this to e.g. ['es','en','pt'] to allow more without any rewrite. */
  readonly allowedLangs = signal<string[]>(['es', 'en']);

  /** Flat, filtered + sorted list (allowed langs first by order, then label). */
  readonly display = computed<VoiceOption[]>(() => {
    const langs = this.allowedLangs();
    const rank = (l: string) => { const i = langs.indexOf(l); return i < 0 ? 999 : i; };
    return this.all()
      .filter(v => langs.includes(v.lang))
      .sort((a, b) => rank(a.lang) - rank(b.lang) || a.label.localeCompare(b.label));
  });

  /** Grouped by language (for <optgroup>), in allowedLangs order. */
  readonly groups = computed<VoiceGroup[]>(() => {
    const out: VoiceGroup[] = [];
    for (const lang of this.allowedLangs()) {
      const voices = this.all()
        .filter(v => v.lang === lang)
        .sort((a, b) => a.label.localeCompare(b.label));
      if (voices.length) out.push({ lang, langLabel: LANG_LABELS[lang] ?? lang.toUpperCase(), voices });
    }
    return out;
  });

  private loaded = false;

  /** Idempotent loader (runs the resolution chain once; pass force to refresh). */
  async ensureLoaded(force = false): Promise<void> {
    if (this.loaded && !force) return;
    this.loaded = true;
    this.source.set('loading');

    // 1) PRIMARY: vits-web manifest from Hugging Face.
    try {
      const mod: any = await import('@diffusionstudio/vits-web');
      const manifest: any[] = await mod.voices();
      const list = this.mapManifest(manifest);
      if (list.length) {
        this.all.set(list);
        this.source.set('manifest');
        void this.backupToFirestore(list); // best-effort LIST cache
        return;
      }
    } catch (e) {
      console.warn('[voice-catalog] manifest fetch failed; trying Firestore cache.', e);
    }

    // 2) FALLBACK: Firestore cached list.
    try {
      const cached = await this.loadFromFirestore();
      if (cached.length) { this.all.set(cached); this.source.set('cache'); return; }
    } catch (e) {
      console.warn('[voice-catalog] Firestore cache unavailable; using seed.', e);
    }

    // 3) LAST RESORT: keep the hardcoded seed (already the signal value).
    this.source.set('error');
  }

  // ----------------------------------------------------------------- helpers

  private mapManifest(manifest: any[]): VoiceOption[] {
    const out: VoiceOption[] = [];
    for (const v of manifest || []) {
      const id = v?.key;
      if (typeof id !== 'string' || !id) continue;
      out.push({ id, label: this.labelFor(v, id), lang: this.langOf(id) });
    }
    return out;
  }

  /** Language from the id prefix (matches the downstream lang derivation). */
  private langOf(id: string): string {
    const p = id.split('_')[0]?.toLowerCase() ?? '';
    return p || 'es';
  }

  /** Readable label from manifest fields; never double-appends a locale suffix. */
  private labelFor(v: any, id: string): string {
    const rawName = (v?.name ?? '').toString().trim();
    const name = rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : id;
    const region = (v?.language?.country_english ?? v?.language?.region ?? '').toString().trim();
    const quality = (v?.quality ?? '').toString().trim();
    let label = name;
    if (region) label += ` - ${region}`;
    if (quality) label += ` (${quality})`;
    return label;
  }

  private docRef() {
    return doc(getFirebaseFirestoreClient(), CATALOG_COL, CATALOG_DOC);
  }

  /** Best-effort write of the catalog LIST (public voice metadata only; no secrets). */
  private async backupToFirestore(list: VoiceOption[]): Promise<void> {
    try {
      await setDoc(this.docRef(), { voices: list, fetchedAt: Date.now() }, { merge: false });
    } catch (e) {
      console.warn('[voice-catalog] Firestore backup write skipped (rules/offline).', e);
    }
  }

  private async loadFromFirestore(): Promise<VoiceOption[]> {
    const snap = await getDoc(this.docRef());
    const data = snap.exists() ? (snap.data() as any) : null;
    const arr = Array.isArray(data?.voices) ? data.voices : [];
    return arr
      .filter((x: any) => x && typeof x.id === 'string')
      .map((x: any) => ({ id: x.id, label: x.label ?? x.id, lang: x.lang ?? this.langOf(x.id) }));
  }
}
