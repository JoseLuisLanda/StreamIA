/**
 * RAG informational-mode contract (client side).
 *
 * The Cloud Function (separate repo: Vertex AI Gemini + Firestore vector search,
 * Express HTTPS endpoint behind `validateFirebaseIdToken`) owns all LLM/RAG
 * connectivity and secrets. The client sends a tiny request and receives ONE
 * structured payload. Media is referenced by Storage path only — the bytes are
 * fetched lazily from Firebase Storage via the SDK when the user opens an item.
 */

/** Request body POSTed to the Function endpoint. */
export interface RagRequest {
  /** the user's question */
  query: string;
  /** locks server-side RAG retrieval to this assistant's collection/topic */
  assistantId?: string;
  /** namespace hint; the Function prefers the assistant doc's ragCollection when
   *  the assistant exists, and uses this only as a fallback (static/dev). */
  namespace?: string;
  /** 'es' | 'en' (Spanish primary) */
  language?: string;
  /** optional voice id hint (the assistant's default is used otherwise) */
  voice?: string;
  /** optional explicit RAG topic/path override (server may ignore for security) */
  ragPath?: string;
  /** preview mode — Function may gate premium content (403) when true */
  preview?: boolean;
  /**
   * Answer mode.
   *  - absent/'rag'   = STAGE 1 summary-only (+ media). Fast; detail is empty.
   *  - 'capabilities' = metadata-only answer (no retrieval/media).
   *  - 'detail'       = STAGE 2 detail-only, reusing stage-1 chunks via `chunkIds`.
   */
  mode?: 'rag' | 'capabilities' | 'detail';
  /** STAGE 2: chunk ids from stage 1's `sources`, so the detail reuses the same context. */
  chunkIds?: string[];
}

/**
 * Options bag for RagAvatarService.ask(). All optional; the service falls back to
 * the active assistant id / 'es' when omitted.
 */
export interface RagAskOptions {
  assistantId?: string;
  /** namespace hint (assistant's ragCollection); fallback when no assistant doc. */
  namespace?: string;
  ragPath?: string;
  preview?: boolean;
  language?: string;
  voice?: string;
  /** 'capabilities' = metadata-only; 'detail' = stage-2 detail-only. Default = stage-1 summary. */
  mode?: 'rag' | 'capabilities' | 'detail';
  /** STAGE 2: chunk ids from stage 1's sources (reuses the same context). */
  chunkIds?: string[];
}

export type MediaType = 'image' | 'video' | 'document';

/** Media metadata returned by the Function — NO signed/public URLs. */
export interface MediaItem {
  id: string;
  type: MediaType;
  title: string;
  /** Storage object path to the full asset, resolved via the SDK on open. */
  storagePath: string;
  /** Storage object path to a small thumbnail, resolved for the gallery. */
  thumbnailPath?: string;
  caption?: string;
}

/** A retrieval source/citation the Function used to ground the answer. */
export interface RagSource {
  id: string;
  metadata?: any;
}

/** The single structured payload returned by the Function. */
export interface RagResponse {
  /** spoken/displayed answer, body only (no greeting/closing/CTA). Equals `summary`. */
  body: string;
  /** concise ~120-word spoken summary (the avatar speaks this). */
  summary?: string;
  /** full long-form analysis shown only on "Ver mas" (NOT spoken). Empty -> hide. */
  detail?: string;
  /** body/summary with inline gesture tags the client parser consumes. */
  gestureCommands: string;
  /** media references (resolved lazily from Storage) */
  media?: MediaItem[];
  /** retrieval citations (optional) */
  sources?: RagSource[];
}

/**
 * Normalized response the service always returns to callers.
 *
 * Extends RagResponse (so existing consumers reading body/gestureCommands/media
 * keep working) and guarantees `media` is an array. The service maps the legacy
 * `{ answer, sources }` shape onto this (answer → body & gestureCommands, empty
 * media) so call sites never branch on shape.
 */
export interface RagAvatarResponse extends RagResponse {
  media: MediaItem[];
  sources: RagSource[];
}

/** Legacy Function shape tolerated as a fallback. */
export interface LegacyRagResponse {
  answer: string;
  sources?: RagSource[];
}

/**
 * Public assistant configuration (Firestore: `assistants/{id}`).
 * "OK-Google-style" lock: an avatar + RAG topic + activation command.
 */
export interface AssistantConfig {
  id: string;
  /** display name of the assistant, e.g. "Sofia" */
  name?: string;
  /** short role for the card pill, e.g. "Asesora de Muebles" */
  role?: string;
  /** one-line card description */
  description?: string;
  /** default avatar (catalog id) loaded for this deployment */
  avatarId: string;
  /**
   * The RAG namespace this assistant OWNS (1:1). Canonical owned knowledge base;
   * documents/chunks/media live under rag/{ragCollection}/... . Convention:
   * usually equals the assistant id. `ragNamespace` is an explicit alias kept for
   * clarity; the service treats ragCollection as authoritative.
   */
  ragCollection: string;
  /** Explicit alias of the owned namespace (optional; falls back to ragCollection). */
  ragNamespace?: string;
  /**
   * Assigned LLM config profile id (llm_profiles/{id}) -- a GLOBAL profile or one
   * of this assistant's OWN private profiles. Absent -> chatRag uses the
   * system-default global profile. chatRag enforces private-profile ownership.
   */
  llmProfileId?: string;
  /**
   * Per-stage LLM profile OVERRIDES (chatRag summary vs detail). Empty/unset ->
   * fall back to the global default (config/ragModels), then to llmProfileId /
   * system default. Independent: summary and detail may use different models.
   */
  summaryProfileId?: string;
  detailProfileId?: string;
  /**
   * Per-category resolution flags. true => read that assistant subcollection;
   * false/absent => serve the global default responses (no subcollection read).
   * Auto-set true on first explicit save of that category.
   */
  useCustomResponses?: {
    greetings: boolean;
    infoAcknowledgements: boolean;
    farewells: boolean;
    suggestedPrompts: boolean;
    /** true => use this assistant's own capabilities config; false/absent => global. */
    capabilities?: boolean;
  };
  /**
   * Capabilities/purpose config (singleton). Optional pre-written `answer`
   * (spoken directly, NO chatRag) and/or a `promptTemplate` used server-side by
   * chatRag's metadata-only capabilities mode. Resolved global-vs-custom by the
   * `useCustomResponses.capabilities` flag.
   */
  capabilities?: { answer?: string; promptTemplate?: string };
  /** Instant reply for greetings/small talk (no RAG call). Per-assistant override. */
  greetingResponse?: string;
  /** Extra greeting trigger words for the intent router (merged with global defaults). */
  greetingKeywords?: string[];
  /** Extra farewell trigger words for the intent router (merged with global defaults). */
  farewellKeywords?: string[];
  /** Extra query-verb triggers for the intent router (merged with global defaults). */
  queryVerbs?: string[];
  /**
   * Persona / behavior for the LLM. The chatRag Function reads this server-side
   * from assistants/{id}.systemPrompt (client cannot tamper). Shapes tone/role
   * but does NOT relax the body-only / grounded contract.
   */
  systemPrompt?: string;
  /** primary language 'es' | 'en' */
  language: string;
  /** default voice id (Piper/WebSpeech) */
  voice: string;
  /** card portrait: Storage path (resolved via SDK) or a direct URL */
  thumbnail?: string;
  /** card chip, e.g. "Catalogo de productos" */
  topicTag?: string;
  /** wake phrase, e.g. "ok strimearia" */
  activationCommand?: string;
  /** stored lead-in gesture id (filler covering Function/RAG latency) */
  leadGestureId?: string;
  /** stored tail gesture id (played after body speech) */
  tailGestureId?: string;
  /** phase-one: may the public user switch the avatar (viz) only? */
  allowAvatarSwitch?: boolean;
  /** whether this assistant shows in the public /assistants selector */
  enabled?: boolean;
  /** Document schema version (see lib/rag/assistant-schema.ts). */
  schemaVersion?: number;
  /** epoch ms */
  createdAt?: number;
  updatedAt?: number;
}

/** A media item plus its resolved object-URL + load state, for the gallery UI. */
export interface ResolvedMedia {
  item: MediaItem;
  /** object URL for the full asset (created on popup open), or null */
  fullUrl?: string | null;
  /** object URL for the thumbnail, or null */
  thumbUrl?: string | null;
  state: 'idle' | 'loading' | 'ready' | 'unauthorized' | 'error';
  error?: string;
}
