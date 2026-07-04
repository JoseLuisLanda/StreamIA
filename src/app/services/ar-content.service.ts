import { Injectable, inject, signal } from '@angular/core';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, listAll, ref, uploadBytesResumable } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import {
  getFirebaseAuth,
  getFirebaseFirestoreClient,
  getFirebaseFunctionsClient,
  getFirebaseStorageClient,
} from './firebase-client';
import { ImageOptimizationService } from './image-optimization.service';
import {
  AR_CONTENT_STORAGE_ROOT,
  AR_ELEMENTS_COLLECTION,
  AR_ELEMENT_SCHEMA_VERSION,
  AR_IMAGE_OPTIMIZE_THRESHOLD_MB,
  ArAsset,
  ArAssetType,
  ArElement,
  ArMarkerTemplate,
  migrateArElementData,
  validateAssetMime,
  validateAssetSize,
  validatePatternFile,
} from '../lib/ar/ar.models';

export interface ArUploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
}

/**
 * CRUD for `ar_elements/{id}` + Storage uploads under ar-content/{elementId}/.
 *
 * DRAFT-FIRST flow: createDraft() writes the doc (enabled=false, ownerUid
 * stamped) BEFORE any upload, because storage.rules validates ownership with a
 * cross-service firestore.get() on ar_elements/{elementId}.ownerUid -- an upload
 * for a non-existent doc is rejected.
 *
 * Ownership: ownerUid (auth uid) is authoritative; ownerEmail is display only.
 * A gestor lists/edits only their own docs; an admin lists all and may reassign
 * ownerUid (rules allow it). Same modular Firebase v12 SDK as the rest of the app.
 */
@Injectable({ providedIn: 'root' })
export class ArContentService {
  readonly error = signal<string>('');

  /** Shared client-side image optimizer (same one RAG Admin uses). */
  private imageOpt = inject(ImageOptimizationService);

  private db() {
    return getFirebaseFirestoreClient();
  }

  private col() {
    return collection(this.db(), AR_ELEMENTS_COLLECTION);
  }

  storageFolderFor(elementId: string): string {
    return `${AR_CONTENT_STORAGE_ROOT}/${elementId}`;
  }

  // ------------------------------------------------------------------ queries

  /** Elements owned by the given uid (gestor view). Sorted client-side by
   *  updatedAt desc to avoid a composite index. */
  async listMine(uid: string): Promise<ArElement[]> {
    this.error.set('');
    try {
      const snap = await getDocs(query(this.col(), where('ownerUid', '==', uid)));
      return this.sortByUpdated(snap.docs.map((d) => this.mapDoc(d.id, d.data())));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
      return [];
    }
  }

  /** ALL elements (admin view). Non-admins get permission errors on others'
   *  drafts server-side; call only when the admin check passed. */
  async listAllElements(): Promise<ArElement[]> {
    this.error.set('');
    try {
      const snap = await getDocs(this.col());
      return this.sortByUpdated(snap.docs.map((d) => this.mapDoc(d.id, d.data())));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
      return [];
    }
  }

  async getElement(id: string): Promise<ArElement | null> {
    const snap = await getDoc(doc(this.db(), AR_ELEMENTS_COLLECTION, id));
    return snap.exists() ? this.mapDoc(id, snap.data()) : null;
  }

  /** PUBLISHED elements only -- the AR viewer's query (enabled == true is the
   *  branch the security rules allow for any signed-in user). */
  async listPublished(): Promise<ArElement[]> {
    this.error.set('');
    try {
      const snap = await getDocs(query(this.col(), where('enabled', '==', true)));
      return this.sortByUpdated(snap.docs.map((d) => this.mapDoc(d.id, d.data())));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
      return [];
    }
  }

  // ------------------------------------------------------------- draft + save

  /**
   * Create a DRAFT element owned by the current user. Auto-id; enabled=false.
   * Must run before uploads (see class doc).
   */
  async createDraft(): Promise<ArElement> {
    const user = getFirebaseAuth().currentUser;
    if (!user) throw new Error('Inicia sesion para crear contenido RA.');
    const refDoc = doc(this.col());
    const el: ArElement = {
      id: refDoc.id,
      name: '',
      description: '',
      enabled: false,
      ownerUid: user.uid,
      ownerEmail: user.email ?? '',
      markerType: 'gps',
      assistantId: '',
      assets: [],
      schemaVersion: AR_ELEMENT_SCHEMA_VERSION,
    };
    await setDoc(refDoc, {
      ...this.toRecord(el),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return el;
  }

  /** Create or update an element document (merge). ownerUid is kept as-is; only
   *  an admin reassignment changes it (rules enforce this server-side). */
  async save(el: ArElement): Promise<void> {
    if (!el.id) throw new Error('Element id is required.');
    await setDoc(
      doc(this.db(), AR_ELEMENTS_COLLECTION, el.id),
      { ...this.toRecord(el), updatedAt: serverTimestamp() },
      { merge: true },
    );
  }

  /**
   * Generate the marker kit SERVER-SIDE (client-agnostic callable): QR +
   * printable custom marker + .patt + PDF, stored under
   * ar-content/{id}/marker/ with the doc patched (patternUrl etc.).
   * baseUrl defaults to this client's origin -- other frontends pass theirs.
   * WARNING: regeneration overwrites in place; previously PRINTED markers stop
   * tracking if the art changes (the UI must confirm).
   */
  async generateMarkerKit(
    elementId: string,
    template?: ArMarkerTemplate,
    baseUrl: string = location.origin,
  ): Promise<{ deepLink: string; qrPath: string; markerPath: string; patternPath: string; pdfPath: string }> {
    const call = httpsCallable(getFirebaseFunctionsClient(), 'generateMarkerKit');
    const res = await call({ elementId, baseUrl, template: template ?? null });
    return res.data as any;
  }

  /** Admin-only: reassign ownership. Rules reject this for non-admins. */
  async reassignOwner(elementId: string, newOwnerUid: string, newOwnerEmail?: string): Promise<void> {
    const uid = (newOwnerUid || '').trim();
    if (!uid) throw new Error('Nuevo ownerUid requerido.');
    await setDoc(
      doc(this.db(), AR_ELEMENTS_COLLECTION, elementId),
      { ownerUid: uid, ownerEmail: newOwnerEmail ?? '', updatedAt: serverTimestamp() },
      { merge: true },
    );
  }

  /**
   * Delete the doc AND best-effort clean its Storage folder
   * (ar-content/{elementId}/). Partial Storage failures are logged and DO NOT
   * block the doc delete (acceptable residue in POC).
   */
  async deleteElement(el: ArElement): Promise<void> {
    try {
      await this.deleteStorageFolder(this.storageFolderFor(el.id));
    } catch (e) {
      console.warn('[ar-content] Storage cleanup failed for', el.id, e);
    }
    await deleteDoc(doc(this.db(), AR_ELEMENTS_COLLECTION, el.id));
  }

  // ------------------------------------------------------------------ uploads

  /**
   * Upload an asset file to ar-content/{elementId}/{assetId}__{name}.
   *
   * Images above AR_IMAGE_OPTIMIZE_THRESHOLD_MB (3 MB) are re-encoded
   * client-side FIRST via the shared ImageOptimizationService (WebP, longest
   * side <= 2048px, quality-preserving; keeps the original if the re-encode is
   * not smaller) -- same pipeline RAG Admin uses. MIME is validated on the
   * original; the size limit is validated on the payload that actually uploads
   * (so a 12 MB photo that compresses to 1 MB passes).
   */
  async uploadAsset(
    elementId: string,
    assetId: string,
    type: ArAssetType,
    file: File,
    onProgress?: (p: ArUploadProgress) => void,
  ): Promise<Pick<ArAsset, 'storagePath' | 'fileName' | 'sizeBytes' | 'contentType'>> {
    const mimeErr = validateAssetMime(type, file);
    if (mimeErr) throw new Error(mimeErr);

    let payload: Blob = file;
    let fileName = file.name;
    let contentType = file.type || (type === 'model' ? 'model/gltf-binary' : 'application/octet-stream');

    if (
      type === 'image' &&
      file.size > AR_IMAGE_OPTIMIZE_THRESHOLD_MB * 1024 * 1024 &&
      this.imageOpt.isOptimizableImage(file)
    ) {
      const r = await this.imageOpt.optimizeImage(file, {
        maxDimension: 2048,
        quality: 0.8,
        format: 'webp',
        keepOriginalIfSmaller: true,
      });
      if (r.blob !== file) {
        payload = r.blob;
        contentType = r.blob.type || contentType;
        fileName = this.renameForMime(file.name, contentType);
        console.info(
          '[ar-content] imagen optimizada:',
          Math.round(file.size / 1024) + ' KB -> ' + Math.round(r.bytes / 1024) + ' KB',
          `(${r.width}x${r.height})`,
        );
      }
    }

    const sizeErr = validateAssetSize(type, payload.size);
    if (sizeErr) throw new Error(sizeErr);

    const safeName = this.safeFileName(fileName);
    const storagePath = `${this.storageFolderFor(elementId)}/${assetId}__${safeName}`;
    await this.upload(storagePath, payload, contentType, onProgress);
    return { storagePath, fileName, sizeBytes: payload.size, contentType };
  }

  /** Upload the .patt marker file to ar-content/{elementId}/marker.patt. */
  async uploadPattern(
    elementId: string,
    file: File,
    onProgress?: (p: ArUploadProgress) => void,
  ): Promise<string> {
    const err = validatePatternFile(file);
    if (err) throw new Error(err);
    const storagePath = `${this.storageFolderFor(elementId)}/marker.patt`;
    await this.upload(storagePath, file, 'text/plain', onProgress);
    return storagePath;
  }

  /** Best-effort delete of one Storage object (asset removal in the editor). */
  async deleteAssetObject(storagePath?: string): Promise<void> {
    if (!storagePath) return;
    try {
      await deleteObject(ref(getFirebaseStorageClient(), storagePath));
    } catch (e: any) {
      if (!String(e?.code ?? '').includes('object-not-found')) {
        console.warn('[ar-content] asset delete failed:', storagePath, e);
      }
    }
  }

  /** Resolve a Storage path to a download URL (null when unreadable). */
  async resolveUrl(path?: string): Promise<string | null> {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    try {
      return await getDownloadURL(ref(getFirebaseStorageClient(), path));
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ helpers

  /** Recursively delete every object under a Storage folder (best-effort). */
  private async deleteStorageFolder(folder: string): Promise<void> {
    const folderRef = ref(getFirebaseStorageClient(), folder);
    const res = await listAll(folderRef);
    for (const item of res.items) {
      try {
        await deleteObject(item);
      } catch (e) {
        console.warn('[ar-content] could not delete', item.fullPath, e);
      }
    }
    for (const prefix of res.prefixes) {
      await this.deleteStorageFolder(prefix.fullPath);
    }
  }

  /** Map a MIME type to the matching file extension after re-encoding. */
  private renameForMime(name: string, mime: string): string {
    const ext = mime === 'image/webp' ? 'webp'
      : mime === 'image/jpeg' ? 'jpg'
      : mime === 'image/png' ? 'png'
      : '';
    if (!ext) return name;
    const base = name.replace(/\.[^.]+$/, '');
    return `${base}.${ext}`;
  }

  private upload(
    path: string,
    file: Blob,
    contentType: string,
    onProgress?: (p: ArUploadProgress) => void,
  ): Promise<void> {
    const storageRef = ref(getFirebaseStorageClient(), path);
    return new Promise<void>((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, file, { contentType });
      task.on(
        'state_changed',
        (snap) => {
          const total = snap.totalBytes || file.size || 1;
          onProgress?.({
            bytesTransferred: snap.bytesTransferred,
            totalBytes: total,
            percent: Math.round((snap.bytesTransferred / total) * 100),
          });
        },
        (err) => reject(err),
        () => resolve(),
      );
    });
  }

  private safeFileName(name: string): string {
    return (name || 'file')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 80);
  }

  private sortByUpdated(list: ArElement[]): ArElement[] {
    return list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /** Firestore record (no id; timestamps handled by callers). */
  private toRecord(el: ArElement): Record<string, unknown> {
    return {
      name: el.name ?? '',
      description: el.description ?? '',
      enabled: el.enabled === true,
      ownerUid: el.ownerUid,
      ownerEmail: el.ownerEmail ?? '',
      markerType: el.markerType,
      patternUrl: el.patternUrl ?? null,
      nftUrl: el.nftUrl ?? null,
      geo: el.geo ?? null,
      assistantId: el.assistantId ?? '',
      ragNamespace: el.ragNamespace ?? null,
      narrationContext: el.narrationContext ?? null,
      assets: (el.assets ?? []).map((a) => ({
        id: a.id,
        type: a.type,
        storagePath: a.storagePath,
        fileName: a.fileName ?? null,
        sizeBytes: a.sizeBytes ?? null,
        contentType: a.contentType ?? null,
        animation: a.animation ?? null,
        scale: typeof a.scale === 'number' ? a.scale : null,
        position: a.position ?? null,
      })),
      schemaVersion: AR_ELEMENT_SCHEMA_VERSION,
    };
  }

  private mapDoc(id: string, raw: any): ArElement {
    const { data } = migrateArElementData(raw);
    return {
      id,
      name: data.name ?? '',
      description: data.description ?? '',
      enabled: data.enabled === true,
      ownerUid: data.ownerUid ?? '',
      ownerEmail: data.ownerEmail ?? '',
      markerType: data.markerType ?? 'gps',
      patternUrl: data.patternUrl || undefined,
      nftUrl: data.nftUrl || undefined,
      geo: data.geo && Number.isFinite(data.geo.lat) && Number.isFinite(data.geo.lng)
        ? { lat: Number(data.geo.lat), lng: Number(data.geo.lng) }
        : undefined,
      assistantId: data.assistantId ?? '',
      ragNamespace: data.ragNamespace || undefined,
      narrationContext: data.narrationContext || undefined,
      // Server-owned marker-kit fields (written by generateMarkerKit).
      qrImageUrl: data.qrImageUrl || undefined,
      markerImageUrl: data.markerImageUrl || undefined,
      markerPdfUrl: data.markerPdfUrl || undefined,
      markerKitGeneratedAt: this.toMs(data.markerKitGeneratedAt),
      markerTemplate: data.markerTemplate || undefined,
      assets: Array.isArray(data.assets)
        ? data.assets.map((a: any) => ({
            id: a.id ?? '',
            type: a.type ?? 'image',
            storagePath: a.storagePath ?? '',
            fileName: a.fileName || undefined,
            sizeBytes: typeof a.sizeBytes === 'number' ? a.sizeBytes : undefined,
            contentType: a.contentType || undefined,
            animation: a.animation || undefined,
            scale: typeof a.scale === 'number' ? a.scale : undefined,
            position: a.position || undefined,
          }))
        : [],
      schemaVersion: Number(data.schemaVersion ?? AR_ELEMENT_SCHEMA_VERSION),
      createdAt: this.toMs(data.createdAt),
      updatedAt: this.toMs(data.updatedAt),
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
