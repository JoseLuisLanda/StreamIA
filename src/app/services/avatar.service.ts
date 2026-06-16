import { Injectable, inject } from '@angular/core';
import { AvatarManagerService } from './avatar-manager.service';
import { ModelCacheService } from './model-cache.service';
import { Avatar } from '../lib/avatars/avatar.models';

/**
 * CENTRAL avatar service -- the single way any component resolves + loads an
 * avatar model. Resolution + caching live here so changing how avatars load is a
 * one-place change.
 *
 * Resolution: read avatars/{id} (Firestore) -> glbPath/thumbnailPath -> download
 * URL via getDownloadURL (NO hardcoded token URLs).
 *
 * Two-layer global cache for the large GLBs (4.5-12 MB):
 *   1. in-memory: resolved blob-URL per avatarId (instant reuse across component
 *      switches, no re-parse of the URL / re-resolve).
 *   2. IndexedDB (ModelCacheService): the GLB BINARY, keyed by glbPath + version
 *      (avatar.updatedAt). Survives reloads -> no re-download.
 * Read-through order: in-memory -> IndexedDB -> Storage (download + populate both).
 * Version-invalidated: a new updatedAt changes the key, so an updated model is
 * re-downloaded and the stale in-memory entry is dropped.
 */
@Injectable({ providedIn: 'root' })
export class AvatarService {
  private mgr = inject(AvatarManagerService);
  private cache = inject(ModelCacheService);

  /** id -> { url: blob/download URL ready for GLTFLoader, version } */
  private modelUrls = new Map<string, { url: string; version: number }>();
  /** id -> resolved thumbnail URL (or null) */
  private thumbUrls = new Map<string, string | null>();
  /** id -> metadata */
  private metaCache = new Map<string, Avatar | null>();
  private listCache: Avatar[] | null = null;

  /** Avatar metadata (cached per session). */
  async getAvatar(avatarId: string): Promise<Avatar | null> {
    if (this.metaCache.has(avatarId)) return this.metaCache.get(avatarId)!;
    const av = await this.mgr.getAvatar(avatarId).catch(() => null);
    this.metaCache.set(avatarId, av);
    return av;
  }

  /** List the avatar catalog (cached per session; pass force to refresh). */
  async listAvatars(force = false): Promise<Avatar[]> {
    if (!force && this.listCache) return this.listCache;
    this.listCache = await this.mgr.listAvatars();
    for (const a of this.listCache) this.metaCache.set(a.id, a);
    return this.listCache;
  }

  /** Resolve an avatar's thumbnail URL (cached). */
  async resolveThumb(avatarId: string): Promise<string | null> {
    if (this.thumbUrls.has(avatarId)) return this.thumbUrls.get(avatarId)!;
    const av = await this.getAvatar(avatarId);
    const url = av?.thumbnailPath ? await this.mgr.resolveUrl(av.thumbnailPath) : null;
    this.thumbUrls.set(avatarId, url);
    return url;
  }

  /**
   * Resolve a GLTFLoader-ready DOWNLOAD URL for an avatar's model.
   *
   * IMPORTANT: we return the Storage download URL (via getDownloadURL), NOT a
   * blob: URL. The shared avatar viewers normalize the URL (append `.glb` /
   * `?morphTargets=...`) which would corrupt a blob URL; a real download URL
   * tolerates the extra query params (Storage ignores them).
   *
   * Two-layer cache:
   *   - in-memory (here): the resolved URL per avatarId, version-checked against
   *     updatedAt -> instant re-resolution across component switches.
   *   - IndexedDB binary: handled by the shared ModelCacheService used inside the
   *     viewers (keyed by URL) -> no re-download across reloads.
   * A re-uploaded model bumps updatedAt -> new getDownloadURL token -> cache miss
   * -> re-download (automatic invalidation).
   */
  async resolveModelUrl(avatarId: string): Promise<string> {
    const av = await this.getAvatar(avatarId);
    if (!av?.glbPath) {
      throw new Error(`Avatar "${avatarId}" has no glbPath (check avatars/${avatarId}).`);
    }
    const version = av.updatedAt ?? 0;

    const mem = this.modelUrls.get(avatarId);
    if (mem && mem.version === version) return mem.url;

    const downloadUrl = await this.mgr.resolveUrl(av.glbPath);
    if (!downloadUrl) throw new Error(`Could not resolve a download URL for ${av.glbPath}.`);
    this.modelUrls.set(avatarId, { url: downloadUrl, version });
    return downloadUrl;
  }

  /** Best-effort: warm the shared binary cache so the first viewer load is instant. */
  async prefetch(avatarId: string): Promise<void> {
    try {
      const av = await this.getAvatar(avatarId);
      if (!av?.glbPath) return;
      const url = await this.mgr.resolveUrl(av.glbPath);
      if (!url) return;
      if (await this.cache.getCachedModel(url)) return;
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) await this.cache.cacheModel(url, await res.arrayBuffer());
    } catch { /* best-effort */ }
  }

  /** Alias: returns a GLTFLoader-ready (cached) URL for the avatar's model. */
  loadModel(avatarId: string): Promise<string> {
    return this.resolveModelUrl(avatarId);
  }

  /** Drop cached entries for one avatar (or all) and revoke blob URLs. */
  invalidate(avatarId?: string): void {
    if (avatarId) {
      const m = this.modelUrls.get(avatarId);
      if (m) this.revoke(m.url);
      this.modelUrls.delete(avatarId);
      this.thumbUrls.delete(avatarId);
      this.metaCache.delete(avatarId);
      this.listCache = null;
      return;
    }
    for (const m of this.modelUrls.values()) this.revoke(m.url);
    this.modelUrls.clear();
    this.thumbUrls.clear();
    this.metaCache.clear();
    this.listCache = null;
  }

  private revoke(url: string): void {
    if (url.startsWith('blob:')) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
  }
}
