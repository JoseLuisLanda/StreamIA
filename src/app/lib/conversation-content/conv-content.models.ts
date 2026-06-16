/**
 * Per-assistant conversational content (stored as nested subcollections under
 * assistants/{id}). Each phrase/prompt is its own document so it is individually
 * editable, deletable, orderable and scalable (NOT an inline string array).
 *
 *   assistants/{id}/greetings/{id}            -> { text, order, enabled, createdAt }
 *   assistants/{id}/infoAcknowledgements/{id} -> { text, order, enabled }  (said WHILE fetching)
 *   assistants/{id}/farewells/{id}            -> { text, order, enabled }
 *   assistants/{id}/suggestedPrompts/{id}     -> { label, prompt, order, enabled }
 *
 * The parent assistant doc carries `contentModifiedAt` (bumped on any write) used
 * for cheap change detection against the local cache's `syncedModifiedAt`.
 */

export type ConvKind = 'greetings' | 'infoAcknowledgements' | 'farewells' | 'suggestedPrompts';

export const CONV_KINDS: ConvKind[] = ['greetings', 'infoAcknowledgements', 'farewells', 'suggestedPrompts'];

/**
 * Per-category resolution flags on assistants/{id}. `true` => the assistant has
 * its OWN configured content for that category (read its subcollection). `false`
 * (default) => never configured => serve the GLOBAL defaults with NO subcollection
 * read. Auto-set true on the first explicit save; toggleable back to false.
 */
export interface UseCustomResponses {
  greetings: boolean;
  infoAcknowledgements: boolean;
  farewells: boolean;
  suggestedPrompts: boolean;
}

export function defaultUseCustom(): UseCustomResponses {
  return { greetings: false, infoAcknowledgements: false, farewells: false, suggestedPrompts: false };
}

export function normalizeUseCustom(v: any): UseCustomResponses {
  const d = defaultUseCustom();
  if (v && typeof v === 'object') {
    for (const k of CONV_KINDS) (d as any)[k] = v[k] === true;
  }
  return d;
}

/** A phrase entry (greetings / infoAcknowledgements / farewells). */
export interface PhraseEntry {
  id: string;
  text: string;
  order: number;
  enabled: boolean;
  createdAt?: number;
}

/** A suggested prompt chip. */
export interface SuggestedPrompt {
  id: string;
  label: string;
  prompt: string;
  order: number;
  enabled: boolean;
  createdAt?: number;
}

/** All four subcollections for one assistant (filtered to enabled, sorted by order). */
export interface AssistantConvContent {
  greetings: PhraseEntry[];
  infoAcknowledgements: PhraseEntry[];
  farewells: PhraseEntry[];
  suggestedPrompts: SuggestedPrompt[];
}

/**
 * Cache schema version. Bump when the envelope shape changes so older,
 * incompatible cached envelopes (e.g. pre-flag) are treated as a miss and
 * re-synced instead of serving stale/empty content.
 */
export const CACHE_SCHEMA = 2;

/** Cache envelope persisted in IndexedDB, keyed by assistantId. */
export interface CachedConvContent {
  assistantId: string;
  /** Envelope schema version (see CACHE_SCHEMA). */
  cacheSchema: number;
  content: AssistantConvContent;
  /** The assistants/{id}.contentModifiedAt value this cache was synced against (epoch ms). */
  syncedModifiedAt: number;
  /** The config/responses.modifiedAt this cache was synced against (epoch ms). */
  syncedGlobalAt: number;
  /** Snapshot of the flags used to build this cache (to detect flag flips). */
  flags: UseCustomResponses;
  /** Wall-clock time of the last successful sync (epoch ms). */
  lastSyncAt: number;
}

/** The editable global default responses (config/responses), shared by all assistants. */
export interface GlobalResponses {
  greetings: PhraseEntry[];
  infoAcknowledgements: PhraseEntry[];
  farewells: PhraseEntry[];
  suggestedPrompts: SuggestedPrompt[];
  modifiedAt: number;
}

export type SyncState = 'no-cache' | 'in-sync' | 'changes';

export function emptyContent(): AssistantConvContent {
  return { greetings: [], infoAcknowledgements: [], farewells: [], suggestedPrompts: [] };
}

// --------------------------------------------------------------- seed defaults

/** Spanish seed defaults (admin-editable). suggestedPrompts adapt by role. */
export function seedPhrases(kind: 'greetings' | 'infoAcknowledgements' | 'farewells'): string[] {
  switch (kind) {
    case 'greetings':
      return ['¡Hola! Qué gusto verte por aquí 😄', '¡Hey! ¿En qué te echo la mano hoy?'];
    case 'infoAcknowledgements':
      return ['Déjame revisar mi base de conocimiento...', 'Un segundo, lo busco para ti...'];
    case 'farewells':
      return ['¡Hasta pronto! Aquí estaré cuando me necesites', '¡Cuídate! Vuelve cuando quieras'];
  }
}

/** Role-adaptable suggested-prompt seeds ({label, prompt}). */
export function seedSuggestedPrompts(role?: string): Array<{ label: string; prompt: string }> {
  const r = (role || '').toLowerCase();
  if (/univ|escuela|académ|academ|estudi/.test(r)) {
    return [
      { label: 'Convocatorias abiertas', prompt: '¿Cuáles son las convocatorias abiertas?' },
      { label: 'Fechas de inscripción', prompt: '¿Cuáles son las fechas de inscripción?' },
      { label: 'Becas', prompt: '¿Qué becas hay disponibles?' },
    ];
  }
  if (/mueble|tienda|catál|catal|venta|product/.test(r)) {
    return [
      { label: 'Productos destacados', prompt: '¿Qué productos me recomiendas?' },
      { label: 'Medidas y precios', prompt: '¿Me das medidas y precios?' },
      { label: 'Disponibilidad', prompt: '¿Qué hay disponible ahora?' },
    ];
  }
  return [
    { label: 'Qué puedes hacer', prompt: '¿Qué puedes hacer por mí?' },
    { label: 'Información general', prompt: 'Dame información general.' },
  ];
}
