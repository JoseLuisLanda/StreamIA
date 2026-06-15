/**
 * Avatar catalog — data-driven list of selectable avatars.
 *
 * Each entry is *metadata only*: a storage path plus descriptive fields. The
 * runtime download URL is resolved on demand via the Firebase Storage SDK
 * (getDownloadURL(ref(storage, storagePath))) by AvatarCatalogService — we never
 * hardcode signed `?token=` URLs because those tokens can rotate and break.
 *
 * Adding a new avatar later is a single entry in AVATAR_CATALOG below.
 */

export interface AvatarCatalogEntry {
  /** Stable slug, also used as the localStorage key for the last selection. */
  id: string;
  /** Human-friendly label shown in the picker. */
  name: string;
  /**
   * Firebase Storage object path to the .glb. Resolved at runtime via
   * getDownloadURL(ref(storage, storagePath)). REQUIRED for catalog avatars.
   */
  storagePath: string;
  /**
   * Optional Storage path (or absolute URL) to a preview thumbnail. When empty
   * or unresolvable, the picker falls back to a generic person icon.
   * Convention: `avatars/preview/<id>.png`.
   */
  thumbnail?: string;
  /** Free-form descriptor of head/body morphology (e.g. "realistic", "stylized"). */
  morphology?: string;
  /** Visual style tag (e.g. "casual", "studio"). */
  style?: string;
  /**
   * Canonical rig the avatar is expected to conform to. The normalization layer
   * targets this spec; see lib/avatars/rig-spec.ts.
   */
  rigVersion?: string;
  /** Default TTS voice id to preselect when this avatar is chosen. */
  defaultVoice?: string;
  /**
   * Dev/fallback only: a direct GLB URL used when Storage resolution is
   * unavailable (e.g. local testing without Firebase). Not for production.
   */
  fallbackUrl?: string;
}

/** Storage folder holding the GLB model files (source of truth, listed at runtime). */
export const AVATAR_MODELS_DIR = 'avatars/models';

/** Storage folder holding card/picker preview images, matched by avatar id basename. */
export const AVATAR_THUMBNAIL_DIR = 'avatars/avatar_preview';

/**
 * Static seed of the avatars in Storage (avatars/models/*.glb). Shown immediately;
 * AvatarCatalogService.refreshFromStorage() then merges any others actually
 * present so this list never has to be kept perfectly in sync by hand.
 * storagePath is the source of truth; URLs are resolved at runtime.
 */
export const AVATAR_CATALOG: AvatarCatalogEntry[] = [
  {
    id: 'alex-ia',
    name: 'Alex',
    storagePath: `${AVATAR_MODELS_DIR}/alex-ia.glb`,
    thumbnail: `${AVATAR_THUMBNAIL_DIR}/alex-ia.png`,
    rigVersion: 'arkit-52-v1',
    defaultVoice: 'es_MX-claude-high',
  },
  {
    id: 'luis-ia',
    name: 'Luis',
    storagePath: `${AVATAR_MODELS_DIR}/luis-ia.glb`,
    thumbnail: `${AVATAR_THUMBNAIL_DIR}/luis-ia.png`,
    rigVersion: 'arkit-52-v1',
    defaultVoice: 'es_MX-claude-high',
  },
  {
    id: 'mar-ia',
    name: 'Maria',
    storagePath: `${AVATAR_MODELS_DIR}/mar-ia.glb`,
    thumbnail: `${AVATAR_THUMBNAIL_DIR}/mar-ia.png`,
    rigVersion: 'arkit-52-v1',
    defaultVoice: 'es_MX-claude-high',
  },
  {
    id: 'mes-iah',
    name: 'Mesiah',
    storagePath: `${AVATAR_MODELS_DIR}/mes-iah.glb`,
    thumbnail: `${AVATAR_THUMBNAIL_DIR}/mes-iah.png`,
    rigVersion: 'arkit-52-v1',
    defaultVoice: 'es_MX-claude-high',
  },
];

export function getCatalogEntry(id: string): AvatarCatalogEntry | undefined {
  return AVATAR_CATALOG.find((a) => a.id === id);
}

/** Turn a GLB filename/slug into a display name, e.g. "r-ai-ban" -> "R Ai Ban". */
export function prettifyAvatarName(idOrFile: string): string {
  const slug = idOrFile.replace(/\.glb$/i, '');
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || slug;
}

/**
 * Insert or update a catalog entry in the shared AVATAR_CATALOG array so that
 * getCatalogEntry() resolves dynamically-discovered avatars (e.g. GLBs found in
 * Storage that weren't in the static seed). Returns true if it was newly added.
 */
export function upsertCatalogEntry(entry: AvatarCatalogEntry): boolean {
  const i = AVATAR_CATALOG.findIndex((a) => a.id === entry.id);
  if (i >= 0) {
    AVATAR_CATALOG[i] = { ...AVATAR_CATALOG[i], ...entry };
    return false;
  }
  AVATAR_CATALOG.push(entry);
  return true;
}

/** Build a catalog entry for a GLB filename under the owner's Storage folder. */
export function entryFromGlbFile(fileName: string): AvatarCatalogEntry {
  const id = fileName.replace(/\.glb$/i, '');
  return {
    id,
    name: prettifyAvatarName(id),
    storagePath: `${AVATAR_MODELS_DIR}/${fileName}`,
    thumbnail: `${AVATAR_THUMBNAIL_DIR}/${id}.png`,
    rigVersion: 'arkit-52-v1',
    defaultVoice: 'es_MX-claude-high',
  };
}
