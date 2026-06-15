/**
 * Reusable VISUAL avatar (Firestore `avatars/{id}`). This is purely the 3D
 * resource: model + thumbnail + default voice + rig info. It is NOT an assistant.
 *
 * Assistants (`assistants/{id}`) reference an `avatarId` from this catalog and add
 * RAG namespace + persona (systemPrompt) + voice override. Persona/RAG must NEVER
 * live on the Avatar -- keep this visual-only.
 *
 * Storage layout (consistent with how avatars are already loaded elsewhere):
 *   avatars/models/{id}.glb        GLB model (resolved at runtime via getDownloadURL)
 *   avatars/thumbnails/{id}.png    card thumbnail
 */
export interface AvatarMeshStats {
  /** total vertices across meshes */
  vertices?: number;
  /** total triangles (polygons) across meshes */
  polygons?: number;
  /** e.g. "Humanoid (skinned)" | "Static (no skeleton)" */
  skeletonType?: string;
}

export interface Avatar {
  id: string;
  name: string;
  description: string;
  /** Storage path to the GLB (NOT a token URL) */
  glbPath: string;
  /** Storage path to the thumbnail image */
  thumbnailPath?: string;
  /** default TTS voice id (assistants may override) */
  defaultVoice: string;
  /** canonical rig classification, e.g. "arkit-52" / "remapped" / "partial" */
  rigVersion?: string;
  /** mesh stats read from the GLB on load */
  meshStats?: AvatarMeshStats;
  /** GLB file size in bytes (set on upload) */
  sizeBytes?: number;
  /** epoch ms */
  createdAt?: number;
  updatedAt?: number;
}
