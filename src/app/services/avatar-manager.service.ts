import { Injectable, signal } from '@angular/core';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage';
import { getFirebaseFirestoreClient, getFirebaseStorageClient } from './firebase-client';
import { Avatar } from '../lib/avatars/avatar.models';

export interface UploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
}

/**
 * CRUD for the reusable visual `avatars/{id}` catalog (admin Avatar Manager).
 *
 * Models live at avatars/models/{id}.glb, thumbnails at avatars/thumbnails/{id}.png
 * (same Storage layout the rest of the app loads from). URLs are resolved at
 * runtime via getDownloadURL -- never stored as token URLs. The id is a slug of
 * the name, so the GLB filename matches the id (and the avatar-catalog dynamic
 * discovery picks it up).
 */
@Injectable({ providedIn: 'root' })
export class AvatarManagerService {
  readonly error = signal<string>('');

  private db() {
    return getFirebaseFirestoreClient();
  }

  /** Slugify a name into a stable id / filename (e.g. "Aurora 01" -> "aurora-01"). */
  slugId(name: string): string {
    return (name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  glbPathFor(id: string): string {
    return `avatars/models/${id}.glb`;
  }
  thumbnailPathFor(id: string): string {
    return `avatars/thumbnails/${id}.png`;
  }

  async listAvatars(): Promise<Avatar[]> {
    this.error.set('');
    try {
      const snap = await getDocs(collection(this.db(), 'avatars'));
      return snap.docs.map((d) => this.mapDoc(d.id, d.data()));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
      return [];
    }
  }

  async getAvatar(id: string): Promise<Avatar | null> {
    const snap = await getDoc(doc(this.db(), 'avatars', id));
    return snap.exists() ? this.mapDoc(id, snap.data()) : null;
  }

  /** Upload a GLB to avatars/models/{id}.glb with progress. Returns size in bytes. */
  async uploadGlb(id: string, file: File, onProgress?: (p: UploadProgress) => void): Promise<{ glbPath: string; sizeBytes: number }> {
    if (!/\.glb$/i.test(file.name) && file.type !== 'model/gltf-binary') {
      throw new Error('Please choose a .glb model file.');
    }
    const glbPath = this.glbPathFor(id);
    await this.upload(glbPath, file, 'model/gltf-binary', onProgress);
    return { glbPath, sizeBytes: file.size };
  }

  /** Upload a thumbnail image to avatars/thumbnails/{id}.png. */
  async uploadThumbnail(id: string, file: File, onProgress?: (p: UploadProgress) => void): Promise<string> {
    const thumbnailPath = this.thumbnailPathFor(id);
    await this.upload(thumbnailPath, file, file.type || 'image/png', onProgress);
    return thumbnailPath;
  }

  /** Resolve a Storage path to a download URL (cached by Storage SDK). */
  async resolveUrl(path?: string): Promise<string | null> {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    try {
      return await getDownloadURL(ref(getFirebaseStorageClient(), path));
    } catch {
      return null;
    }
  }

  /** Create or update an avatar document. */
  async save(avatar: Avatar): Promise<Avatar> {
    const id = avatar.id || this.slugId(avatar.name);
    if (!id) throw new Error('Avatar name is required.');
    const now = Date.now();
    const record: Avatar = {
      ...avatar,
      id,
      createdAt: avatar.createdAt ?? now,
      updatedAt: now,
    };
    await setDoc(
      doc(this.db(), 'avatars', id),
      {
        name: record.name,
        description: record.description ?? '',
        glbPath: record.glbPath,
        thumbnailPath: record.thumbnailPath ?? null,
        defaultVoice: record.defaultVoice ?? '',
        rigVersion: record.rigVersion ?? null,
        meshStats: record.meshStats ?? null,
        sizeBytes: record.sizeBytes ?? null,
        createdAt: record.createdAt,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    return record;
  }

  /** Delete an avatar doc + its Storage model/thumbnail (best-effort). */
  async deleteAvatar(a: Avatar): Promise<void> {
    for (const p of [a.glbPath, a.thumbnailPath].filter(Boolean) as string[]) {
      try {
        await deleteObject(ref(getFirebaseStorageClient(), p));
      } catch (e: any) {
        if (!String(e?.code ?? '').includes('object-not-found')) throw e;
      }
    }
    await deleteDoc(doc(this.db(), 'avatars', a.id));
  }

  // ----------------------------------------------------------------- helpers

  private upload(
    path: string,
    file: File,
    contentType: string,
    onProgress?: (p: UploadProgress) => void,
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

  private mapDoc(id: string, data: any): Avatar {
    return {
      id,
      name: data.name ?? id,
      description: data.description ?? '',
      glbPath: data.glbPath ?? '',
      thumbnailPath: data.thumbnailPath || undefined,
      defaultVoice: data.defaultVoice ?? '',
      rigVersion: data.rigVersion || undefined,
      meshStats: data.meshStats || undefined,
      sizeBytes: typeof data.sizeBytes === 'number' ? data.sizeBytes : undefined,
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
