import { Injectable } from '@angular/core';
import {
  deleteObject,
  ref,
  uploadBytes
} from 'firebase/storage';
import { getFirebaseAuth, getFirebaseStorageClient } from './firebase-client';

@Injectable({
  providedIn: 'root'
})
export class FirebaseAvatarStorageService {
  getAuthenticatedEmail(): string | null {
    return getFirebaseAuth().currentUser?.email ?? null;
  }

  buildAvatarPath(email: string, avatarName: string): string {
    const safeEmail = this.sanitizePathPart(email);
    const safeAvatarName = this.sanitizePathPart(avatarName);
    return `avatars/${safeEmail}/${safeAvatarName}.glb`;
  }

  async uploadAvatar(email: string, avatarName: string, arrayBuffer: ArrayBuffer): Promise<{ path: string }> {
    const path = this.buildAvatarPath(email, avatarName);
    const avatarRef = ref(getFirebaseStorageClient(), path);
    const avatarBlob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });

    await uploadBytes(avatarRef, avatarBlob, { contentType: 'model/gltf-binary' });
    return { path };
  }

  async deleteAvatar(storagePath: string): Promise<void> {
    const avatarRef = ref(getFirebaseStorageClient(), storagePath);
    await deleteObject(avatarRef);
  }

  private sanitizePathPart(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9@._-]/g, '');
  }
}
