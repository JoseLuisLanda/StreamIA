import { Injectable, computed, inject, signal } from '@angular/core';
import { getDownloadURL, listAll, ref } from 'firebase/storage';
import { getFirebaseStorageClient } from './firebase-client';
import {
  AVATAR_CATALOG,
  AVATAR_MODELS_DIR,
  AvatarCatalogEntry,
  entryFromGlbFile,
  getCatalogEntry,
  upsertCatalogEntry,
} from '../lib/avatars/avatar-catalog';
import { Conformance, RigReport } from '../lib/avatars/rig-spec';

const LS_SELECTED = 'avatarCatalog.selectedId';

export interface ResolvedAvatar {
  entry: AvatarCatalogEntry;
  /** Resolved GLB URL (Firebase download URL or fallback direct URL). */
  url: string;
}

/**
 * Owns the avatar catalog and resolves Storage paths → download URLs at runtime
 * via the Firebase Storage SDK (getDownloadURL(ref(storage, path))). Never
 * stores signed `?token=` URLs in source; tokens are resolved on demand and may
 * rotate safely.
 *
 * Also tracks the selected avatar (persisted) and the latest rig conformance
 * report per avatar so the picker UI can show a status badge.
 */
@Injectable({ providedIn: 'root' })
export class AvatarCatalogService {
  /**
   * Reactive catalog signal. Seeded from the static AVATAR_CATALOG, then merged
   * with whatever GLBs actually exist under avatars/{owner}/ in Storage
   * (refreshFromStorage), so newly uploaded avatars appear without a code change.
   * Templates iterate `catalog.catalog()`.
   */
  readonly catalog = signal<AvatarCatalogEntry[]>([...AVATAR_CATALOG]);

  constructor() {
    // Best-effort dynamic discovery (non-blocking; static seed shows immediately).
    void this.refreshFromStorage();
  }

  /** Currently selected catalog avatar id (null = using a manual/dev URL). */
  readonly selectedId = signal<string | null>(this.loadSelectedId());
  readonly selected = computed<AvatarCatalogEntry | null>(() => {
    const id = this.selectedId();
    return id ? getCatalogEntry(id) ?? null : null;
  });

  /** Per-avatar rig reports, filled in after each avatar loads + is inspected. */
  readonly reports = signal<Record<string, RigReport>>({});

  // resolved-URL memo caches (avoid repeat network round-trips per session)
  private glbUrlCache = new Map<string, string>();
  private thumbUrlCache = new Map<string, string | null>();

  private loadSelectedId(): string | null {
    try {
      return localStorage.getItem(LS_SELECTED);
    } catch {
      return null;
    }
  }

  /**
   * Discover GLBs under avatars/{owner}/ in Storage and merge any not already in
   * the catalog. Best-effort: on permission/offline errors it silently keeps the
   * static seed. Updates the `catalog` signal so pickers re-render reactively.
   */
  async refreshFromStorage(): Promise<void> {
    try {
      const storage = getFirebaseStorageClient();
      const res = await listAll(ref(storage, AVATAR_MODELS_DIR));
      let changed = false;
      for (const item of res.items) {
        if (!/\.glb$/i.test(item.name)) continue;
        const id = item.name.replace(/\.glb$/i, '');
        if (getCatalogEntry(id)) continue; // already known (static or earlier scan)
        upsertCatalogEntry(entryFromGlbFile(item.name));
        changed = true;
      }
      if (changed) this.catalog.set([...AVATAR_CATALOG]);
    } catch (e) {
      console.warn('[avatar-catalog] storage listing failed; using static seed.', e);
    }
  }

  /** Persist + set the selected avatar (does not itself load the model). */
  select(id: string | null): void {
    this.selectedId.set(id);
    try {
      if (id) localStorage.setItem(LS_SELECTED, id);
      else localStorage.removeItem(LS_SELECTED);
    } catch {
      /* ignore quota/private-mode errors */
    }
  }

  /**
   * Resolve a catalog entry's GLB to a loadable URL.
   * Order: in-memory cache → fallbackUrl (if storagePath empty) → Firebase
   * getDownloadURL(ref(storage, storagePath)). The dev fallbackUrl is used only
   * when Storage resolution throws (e.g. offline / rules / local testing).
   */
  async resolveGlbUrl(entry: AvatarCatalogEntry): Promise<string> {
    const cacheKey = entry.id;
    const cached = this.glbUrlCache.get(cacheKey);
    if (cached) return cached;

    // No storage path → dev/local direct URL only.
    if (!entry.storagePath) {
      if (entry.fallbackUrl) {
        this.glbUrlCache.set(cacheKey, entry.fallbackUrl);
        return entry.fallbackUrl;
      }
      throw new Error(`Avatar "${entry.id}" has neither storagePath nor fallbackUrl.`);
    }

    try {
      const storage = getFirebaseStorageClient();
      const url = await getDownloadURL(ref(storage, entry.storagePath));
      this.glbUrlCache.set(cacheKey, url);
      return url;
    } catch (e) {
      if (entry.fallbackUrl) {
        console.warn(
          `[avatar-catalog] Storage resolution failed for "${entry.id}" (${entry.storagePath}); using dev fallbackUrl.`,
          e
        );
        return entry.fallbackUrl;
      }
      throw e;
    }
  }

  /** Resolve by id (convenience). */
  async resolveGlbUrlById(id: string): Promise<ResolvedAvatar> {
    const entry = getCatalogEntry(id);
    if (!entry) throw new Error(`Unknown avatar id "${id}".`);
    const url = await this.resolveGlbUrl(entry);
    return { entry, url };
  }

  /**
   * Resolve a thumbnail to a URL, or null when none exists / can't be resolved
   * (the picker then shows a generic person icon). Thumbnails are optional and
   * `avatars/preview/*` is not populated yet, so a miss is expected.
   */
  async resolveThumbnailUrl(entry: AvatarCatalogEntry): Promise<string | null> {
    if (this.thumbUrlCache.has(entry.id)) return this.thumbUrlCache.get(entry.id)!;
    const thumb = entry.thumbnail?.trim();
    if (!thumb) {
      this.thumbUrlCache.set(entry.id, null);
      return null;
    }
    // Absolute URL → use directly.
    if (/^https?:\/\//i.test(thumb) || thumb.startsWith('data:')) {
      this.thumbUrlCache.set(entry.id, thumb);
      return thumb;
    }
    try {
      const storage = getFirebaseStorageClient();
      const url = await getDownloadURL(ref(storage, thumb));
      this.thumbUrlCache.set(entry.id, url);
      return url;
    } catch {
      // Expected until preview thumbnails are uploaded.
      this.thumbUrlCache.set(entry.id, null);
      return null;
    }
  }

  /** Store a rig report for an avatar id (called by the renderer after load). */
  setReport(id: string, report: RigReport): void {
    this.reports.update((r) => ({ ...r, [id]: report }));
  }

  getReport(id: string): RigReport | undefined {
    return this.reports()[id];
  }

  /** Conformance for the picker badge, if known yet. */
  conformanceOf(id: string): Conformance | undefined {
    return this.reports()[id]?.conformance;
  }
}
