/**
 * AR content data model (feature /ar-assistant, FASE 0).
 *
 * Firestore collection: `ar_elements/{id}` -- one document per publishable AR
 * element (a marker/GPS anchor + its assets + the assistant that narrates it).
 * Ownership is by `ownerUid` (Firebase Auth uid), NEVER by email: rules validate
 * against ownerUid; ownerEmail is display-only. The viewer (FASE 1) only queries
 * `enabled == true`; `enabled == false` means draft.
 *
 * Storage layout: ar-content/{elementId}/... (assets + optional marker.patt).
 * Write access is enforced by storage.rules via a cross-service firestore.get()
 * on the element's ownerUid -- hence the DRAFT-FIRST flow: the doc must exist
 * (with ownerUid) BEFORE any upload.
 *
 * The collection carries its own schemaVersion (AR_ELEMENT_SCHEMA_VERSION),
 * following the same ordered-migration pattern as assistants (assistant-schema.ts).
 */

export const AR_ELEMENTS_COLLECTION = 'ar_elements';
export const AR_CONTENT_STORAGE_ROOT = 'ar-content';

/** Current ar_element schema version (bump + add a migration step on change). */
export const AR_ELEMENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- size limits
// Upload validation limits (MB). Centralized so they are configurable in one
// place; the manager enforces them client-side (rules are the security layer).
export const AR_ASSET_LIMITS_MB: Record<ArAssetType, number> = {
  model: 15,
  video: 50,
  image: 10,
};
export const AR_PATTERN_LIMIT_KB = 512;

/** Images larger than this are re-encoded client-side (ImageOptimizationService,
 *  WebP quality-preserving) BEFORE upload. Below it they upload untouched. */
export const AR_IMAGE_OPTIMIZE_THRESHOLD_MB = 3;

export type ArMarkerType = 'pattern' | 'nft' | 'gps';
export type ArAssetType = 'image' | 'video' | 'model';
export type ArAnimationPath = 'orbit' | 'line' | null;

/** Per-asset animation config consumed by the FASE 1 viewer (animation-mixer
 *  clips for GLB + orbit/line trajectory components). */
export interface ArAssetAnimation {
  /** GLB animation clip name ('' / '*' = first clip). Ignored for image/video. */
  clip?: string;
  /** Start the clip automatically on markerFound. */
  autoplay: boolean;
  /** Movement trajectory: 'orbit' | 'line' | null (static). */
  path: ArAnimationPath;
  /** Scene-token / gesture triggers that may (re)start the clip (FASE 4). */
  triggers: string[];
}

export interface ArVec3 {
  x: number;
  y: number;
  z: number;
}

/** One displayable asset of an AR element. URLs are NEVER stored -- only the
 *  Storage object path, resolved at runtime via getDownloadURL (repo convention). */
export interface ArAsset {
  id: string;
  type: ArAssetType;
  /** Storage object path under ar-content/{elementId}/. */
  storagePath: string;
  /** Original file name (display only). */
  fileName?: string;
  sizeBytes?: number;
  contentType?: string;
  animation?: ArAssetAnimation;
  /** Uniform scale applied in the AR scene (default 1). */
  scale?: number;
  /** Position offset relative to the anchor (default 0,0,0). */
  position?: ArVec3;
}

export interface ArGeoPoint {
  lat: number;
  lng: number;
}

/**
 * Customizable art template of the printed marker ("envoltorio"). Merged
 * server-side (generateMarkerKit callable): defaults <- doc <- request, then
 * persisted on the doc so regeneration is stable.
 */
export interface ArMarkerTemplate {
  borderColor?: string;      // #rrggbb, default #000000 (tracking frame)
  innerBackground?: string;  // default #ffffff
  accentColor?: string;      // default derived from element id
  title?: string;            // label headline (default element name)
  description?: string;      // short text above the marker box (label)
  brandText?: string;        // big letter(s) inside the marker art, default 'P'
  cornerText?: string;       // corner text inside the marker art, default 'AR'
  /** Storage path of the business logo shown on top of the label. MUST live
   *  under ar-content/{elementId}/ (enforced server-side). */
  logoPath?: string;
  headerBackground?: string; // label header background, default #ffffff
  headerTextColor?: string;  // title + description color, default #111111
  /** Inner fraction of the black frame. Default 0.9 (thin frame). The viewer
   *  configures the SAME value on the arjs scene (ar-scene.service). */
  patternRatio?: number;
}

/** Firestore document shape for ar_elements/{id}. */
export interface ArElement {
  id: string;
  name: string;
  description: string;
  /** false = draft (only owner/admin see it); true = published (viewer loads it). */
  enabled: boolean;
  /** OWNER (Firebase Auth uid). Authoritative for rules; forced on create. */
  ownerUid: string;
  /** Display-only owner email (may go stale; never used for authorization). */
  ownerEmail?: string;
  markerType: ArMarkerType;
  /** Storage path of the .patt file (markerType 'pattern'). Set automatically
   *  by the generateMarkerKit callable (or manually for advanced use). */
  patternUrl?: string;
  /**
   * Marker kit artifacts -- SERVER-OWNED fields written by the
   * generateMarkerKit callable (Storage paths under ar-content/{id}/marker/).
   * Optional: absent until the kit is generated; no schema migration needed.
   * The client save() never writes them (see ArContentService.toRecord).
   */
  qrImageUrl?: string;
  markerImageUrl?: string;
  /** Vertical printable label (logo + description + marker). */
  labelImageUrl?: string;
  markerPdfUrl?: string;
  markerKitGeneratedAt?: number;
  markerTemplate?: ArMarkerTemplate;
  /** NFT descriptor base URL/path (markerType 'nft'). */
  nftUrl?: string;
  /** Anchor coordinates (markerType 'gps'). */
  geo?: ArGeoPoint;
  /** Assistant that narrates this element (assistants/{id}). */
  assistantId: string;
  /** Knowledge source for narration/Q&A: a RAG namespace... */
  ragNamespace?: string;
  /** ...OR a plain-text context for elements without their own knowledge base.
   *  Mutually exclusive with ragNamespace (the manager enforces the XOR). */
  narrationContext?: string;
  assets: ArAsset[];
  schemaVersion: number;
  /** epoch ms (mapped from serverTimestamp on read). */
  createdAt?: number;
  updatedAt?: number;
}

// ---------------------------------------------------------------- validation

const MIME_BY_TYPE: Record<ArAssetType, RegExp> = {
  image: /^image\//i,
  video: /^video\//i,
  model: /^(model\/gltf-binary)?$/i, // GLB often has empty type; extension decides
};

/** Infer the asset type from a File (MIME first, extension fallback). */
export function inferAssetType(file: File): ArAssetType | null {
  if (/^image\//i.test(file.type)) return 'image';
  if (/^video\//i.test(file.type)) return 'video';
  if (file.type === 'model/gltf-binary' || /\.glb$/i.test(file.name)) return 'model';
  return null;
}

/** MIME/extension validation only. Returns an error message or null. */
export function validateAssetMime(type: ArAssetType, file: File): string | null {
  if (type === 'model') {
    if (!/\.glb$/i.test(file.name) && file.type !== 'model/gltf-binary') {
      return 'El modelo debe ser un archivo .glb';
    }
    return null;
  }
  if (!MIME_BY_TYPE[type].test(file.type)) {
    return `Tipo MIME invalido para ${type}: ${file.type || '(vacio)'}`;
  }
  return null;
}

/** Size validation only (bytes may be the POST-optimization payload). */
export function validateAssetSize(type: ArAssetType, bytes: number): string | null {
  const maxMb = AR_ASSET_LIMITS_MB[type];
  if (bytes > maxMb * 1024 * 1024) {
    return `El archivo excede el limite de ${maxMb} MB para ${type}`;
  }
  return null;
}

/**
 * Validate an asset file against MIME + size limits.
 * Returns an error message, or null when the file is acceptable.
 */
export function validateAssetFile(type: ArAssetType, file: File): string | null {
  return validateAssetMime(type, file) ?? validateAssetSize(type, file.size);
}

/** Validate a .patt marker file. Returns an error message or null. */
export function validatePatternFile(file: File): string | null {
  if (!/\.patt$/i.test(file.name)) return 'El marcador debe ser un archivo .patt';
  if (file.size > AR_PATTERN_LIMIT_KB * 1024) {
    return `El .patt excede el limite de ${AR_PATTERN_LIMIT_KB} KB`;
  }
  return null;
}

/** Default animation config for a new asset. */
export function defaultAssetAnimation(): ArAssetAnimation {
  return { clip: '', autoplay: true, path: null, triggers: [] };
}

/**
 * Publish-readiness check (shared by manager UI + save guard). An element may
 * only be enabled when it has a name, an assistant, a narration source and its
 * marker-type-specific anchor data.
 */
export function publishBlockers(el: ArElement): string[] {
  const errs: string[] = [];
  if (!(el.name || '').trim()) errs.push('Falta el nombre');
  if (!el.assistantId) errs.push('Selecciona un asistente');
  const hasNs = !!(el.ragNamespace || '').trim();
  const hasCtx = !!(el.narrationContext || '').trim();
  if (!hasNs && !hasCtx) errs.push('Define un namespace RAG o un contexto de narracion');
  if (hasNs && hasCtx) errs.push('Namespace RAG y contexto de narracion son excluyentes');
  if (el.markerType === 'pattern' && !el.patternUrl) errs.push('Genera el kit de marcador (o sube un .patt manualmente)');
  if (el.markerType === 'nft' && !(el.nftUrl || '').trim()) errs.push('Indica la URL/base del descriptor NFT');
  if (el.markerType === 'gps') {
    const g = el.geo;
    const ok = !!g && Number.isFinite(g.lat) && Number.isFinite(g.lng)
      && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180
      && !(g.lat === 0 && g.lng === 0);
    if (!ok) errs.push('Fija la posicion GPS (pin en el mapa)');
  }
  if (!el.assets.length) errs.push('Agrega al menos un asset');
  return errs;
}

// ---------------------------------------------------------------- migrations
// Same ordered-migration pattern as lib/rag/assistant-schema.ts, scoped to
// ar_elements. v1 is the initial shape, so the list starts empty; future fields
// append a step here and bump AR_ELEMENT_SCHEMA_VERSION.

export interface ArMigrationStep {
  to: number;
  apply: (d: any) => void;
}

export const AR_ELEMENT_MIGRATIONS: ArMigrationStep[] = [];

export function migrateArElementData(raw: any): { data: any; changed: boolean } {
  const d = { ...(raw ?? {}) };
  const from = Number(d.schemaVersion ?? 0);
  let changed = false;
  for (const step of AR_ELEMENT_MIGRATIONS) {
    if (from < step.to) {
      step.apply(d);
      changed = true;
    }
  }
  if (changed) d.schemaVersion = AR_ELEMENT_SCHEMA_VERSION;
  return { data: d, changed };
}
