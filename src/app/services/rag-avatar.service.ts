import { Injectable, signal } from '@angular/core';
import { getIdToken } from 'firebase/auth';
import { getBlob, getDownloadURL, ref } from 'firebase/storage';
import { doc, getDoc } from 'firebase/firestore';
import { getFirebaseAuth, getFirebaseFirestoreClient, getStorageForBucket } from './firebase-client';
import {
  LegacyRagResponse,
  MediaItem,
  RagAskOptions,
  RagAvatarResponse,
  RagRequest,
  RagSource,
} from '../lib/rag/rag.models';
import { getAssistantId, getRagEndpoint, getRagMediaBucket } from '../lib/rag/rag.config';

/** Thrown when Storage denies a media read — lets the gallery show a 🔒 state. */
export class MediaUnauthorizedError extends Error {
  constructor(public storagePath: string) {
    super(`Unauthorized to read ${storagePath}`);
    this.name = 'MediaUnauthorizedError';
  }
}

/**
 * User-facing error from the RAG Function, carrying a stable `kind` so the UI can
 * render the right message/state without parsing strings. `kind`:
 *  - 'config'        : endpoint not configured (env/localStorage)
 *  - 'auth'          : not signed in / token rejected (401)
 *  - 'forbidden'     : preview/premium or insufficient role (403)
 *  - 'bad-request'   : missing/empty query (400)
 *  - 'no-context'    : no retrieval context for the query (404/503)
 *  - 'server'        : Function/internal error (500 + other 5xx)
 *  - 'network'       : fetch failed (likely CORS or offline)
 */
export type RagErrorKind =
  | 'config'
  | 'auth'
  | 'forbidden'
  | 'bad-request'
  | 'no-context'
  | 'quota'
  | 'server'
  | 'network';

/** Per-account quota snapshot returned with each rag answer (or on a 429 block). */
export interface QuotaInfo {
  remaining: number;
  allocated: number;
  used: number;
  warnThresholds: number[];
  /** threshold this interaction crossed (one-shot warning), or null. */
  warnCrossed: number | null;
}

export class RagAvatarError extends Error {
  constructor(
    public kind: RagErrorKind,
    message: string,
    public status?: number,
    /** true when the failure is consistent with a CORS block (no/opaque response) */
    public corsSuspected = false,
  ) {
    super(message);
    this.name = 'RagAvatarError';
  }
}

/**
 * Client transport for RAG informational mode.
 *
 * - `ask()` POSTs {query, assistantId, language, voice, ragPath?, preview?} to
 *   the Function endpoint (environment.ragApiBase + ragChatPath) with the
 *   signed-in user's Firebase ID token as `Authorization: Bearer <token>`
 *   (the Function verifies it via `validateFirebaseIdToken`). It returns the
 *   structured {body, gestureCommands, media, sources} payload, normalized so
 *   callers never branch on shape. The legacy {answer, sources} shape is mapped
 *   onto the structured one (answer → body & gestureCommands, empty media). NO
 *   LLM/RAG secrets live here.
 * - Media bytes are fetched lazily from Storage via the SDK (`getBlob`), so
 *   access is enforced by Storage rules at fetch time rather than frozen into a
 *   signed/public URL. Consolidated on strimearia: environment.ragMediaBucket is
 *   '' so getStorageForBucket('') resolves the default app bucket (strimearia) --
 *   no cross-project hop. Falls back to `getDownloadURL` if `getBlob` is blocked
 *   by CORS, and surfaces an explicit unauthorized state for graceful degradation.
 */
@Injectable({ providedIn: 'root' })
export class RagAvatarService {
  /** media from the most recent answer (for the gallery) */
  readonly lastMedia = signal<MediaItem[]>([]);
  /** latest per-account quota snapshot (updated on every rag answer / 429). */
  readonly lastQuota = signal<QuotaInfo | null>(null);
  /** true when the account has hit 0 -> the UI shows a hard-blocked state. */
  readonly quotaBlocked = signal<boolean>(false);

  /**
   * Read users/{uid}/quota/current ONCE (owner-readable; never written client-side)
   * so the live counter shows the account balance the moment an assistant loads,
   * before the first interaction. Best-effort: a missing doc / denied read leaves
   * the counter hidden until the first server response reconciles it.
   */
  async loadQuotaForUser(uid: string): Promise<void> {
    if (!uid) return;
    try {
      const snap = await getDoc(doc(getFirebaseFirestoreClient(), 'users', uid, 'quota', 'current'));
      if (!snap.exists()) { this.lastQuota.set(null); this.quotaBlocked.set(false); return; }
      const v = snap.data() as any;
      const remaining = Number(v.remaining ?? 0);
      this.lastQuota.set({
        remaining,
        allocated: Number(v.allocated ?? 0),
        used: Number(v.used ?? 0),
        warnThresholds: Array.isArray(v.warnThresholds) ? v.warnThresholds : [],
        warnCrossed: null,
      });
      this.quotaBlocked.set(remaining <= 0);
    } catch {
      /* read denied / offline -> leave counter to reconcile from the next response */
    }
  }

  /**
   * Call the Function. Throws `RagAvatarError` (with a `kind`) on any failure.
   *
   * Back-compat: also accepts the old positional call
   * `ask(query, assistantId, language, voice)` -- both forms are supported so no
   * existing call site breaks.
   */
  async ask(query: string, opts?: RagAskOptions): Promise<RagAvatarResponse>;
  async ask(query: string, assistantId: string, language?: string, voice?: string): Promise<RagAvatarResponse>;
  async ask(
    query: string,
    optsOrAssistantId?: RagAskOptions | string,
    language?: string,
    voice?: string,
  ): Promise<RagAvatarResponse> {
    const opts: RagAskOptions =
      typeof optsOrAssistantId === 'string'
        ? { assistantId: optsOrAssistantId, language, voice }
        : optsOrAssistantId ?? {};

    const q = (query ?? '').trim();
    if (!q) {
      throw new RagAvatarError('bad-request', 'Escribe una pregunta primero.');
    }

    const endpoint = getRagEndpoint();
    if (!endpoint) {
      throw new RagAvatarError(
        'config',
        'RAG endpoint not configured. Set the Function URL in environment.ts or Settings.',
      );
    }

    const user = getFirebaseAuth().currentUser;
    if (!user) {
      throw new RagAvatarError('auth', 'Sign-in required to use the informational assistant.');
    }
    // forceRefresh on every call keeps a near-expiry token from being rejected.
    const token = await getIdToken(user, /* forceRefresh */ true);

    const payload: RagRequest = {
      query: q,
      assistantId: opts.assistantId ?? getAssistantId(),
      namespace: opts.namespace,
      language: opts.language ?? 'es',
      voice: opts.voice,
      ragPath: opts.ragPath,
      preview: opts.preview,
      // 'capabilities' = metadata-only; 'detail' = stage-2 detail-only (reuses
      // stage-1 chunks via chunkIds). Absent = stage-1 summary (normal RAG).
      mode: opts.mode,
      chunkIds: opts.chunkIds,
      knowledgeMode: opts.knowledgeMode,
      categoryChunkIds: opts.categoryChunkIds,
    };

    // OPTIMISTIC quota decrement: only the rag (summary) interaction consumes a
    // unit server-side, so decrement the local counter for that mode BEFORE the
    // round-trip (feels instant). capabilities/detail/suggestions do NOT consume.
    // The server response reconciles to the authoritative `remaining`; a network
    // failure (request never reached the server) rolls this back.
    const consumesQuota = (payload.mode ?? 'rag') === 'rag';
    if (consumesQuota) {
      this.lastQuota.update((qq) => (qq && qq.remaining > 0
        ? { ...qq, remaining: qq.remaining - 1, used: qq.used + 1 } : qq));
    }

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
      // Request never reached the server -> roll back the optimistic decrement.
      if (consumesQuota) {
        this.lastQuota.update((qq) => (qq
          ? { ...qq, remaining: qq.remaining + 1, used: Math.max(0, qq.used - 1) } : qq));
      }
      // A thrown fetch (TypeError "Failed to fetch") is the classic CORS / offline
      // signature — the browser blocked the response before we could read status.
      throw new RagAvatarError(
        'network',
        'No se pudo contactar al asistente (posible bloqueo CORS o sin conexión). ' +
          'Si el problema es CORS, debe habilitarse en la Function (lado servidor).',
        undefined,
        /* corsSuspected */ true,
      );
    }

    if (!res.ok) {
      // 429 = quota exhausted: latch the blocked state for the UI before throwing.
      if (res.status === 429) {
        this.quotaBlocked.set(true);
        this.lastQuota.update((q) => (q ? { ...q, remaining: 0 } : { remaining: 0, allocated: 0, used: 0, warnThresholds: [], warnCrossed: null }));
        throw new RagAvatarError(
          'quota',
          'Has agotado tus consultas; contacta para recargar.',
          429,
        );
      }
      throw await this.toError(res);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new RagAvatarError('server', 'El asistente devolvió una respuesta no válida.', res.status);
    }

    // Capture the quota snapshot the server returns with a rag answer (if any).
    const rawQuota = (data as any)?.quota;
    if (rawQuota && typeof rawQuota === 'object') {
      this.quotaBlocked.set(false);
      this.lastQuota.set({
        remaining: Number(rawQuota.remaining ?? 0),
        allocated: Number(rawQuota.allocated ?? 0),
        used: Number(rawQuota.used ?? 0),
        warnThresholds: Array.isArray(rawQuota.warnThresholds) ? rawQuota.warnThresholds : [],
        warnCrossed: rawQuota.warnCrossed ?? null,
      });
    }

    const normalized = this.normalize(data);
    this.lastMedia.set(normalized.media);
    // Analysis logging: full structured response (summary/detail lengths + media).
    console.info('[RagAvatar] response', {
      assistantId: payload.assistantId,
      query: q,
      summaryLen: (normalized.summary ?? normalized.body ?? '').length,
      detailLen: (normalized.detail ?? '').length,
      mediaCount: normalized.media.length,
      media: normalized.media,
      sources: normalized.sources,
      raw: data,
    });
    return normalized;
  }

  /** Map an HTTP error response to a typed, user-facing RagAvatarError. */
  private async toError(res: Response): Promise<RagAvatarError> {
    const body = await res.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 180)}` : '';
    switch (res.status) {
      case 400:
        return new RagAvatarError('bad-request', 'Falta la pregunta o la solicitud es inválida.', 400);
      case 401:
        return new RagAvatarError(
          'auth',
          'Sesión no válida o token rechazado. Inicia sesión de nuevo.',
          401,
        );
      case 403:
        return new RagAvatarError(
          'forbidden',
          'Contenido restringido (vista previa/premium) o permisos insuficientes.',
          403,
        );
      case 404:
      case 503:
        return new RagAvatarError(
          'no-context',
          'No encontré información para esa consulta en este momento.',
          res.status,
        );
      case 500:
        return new RagAvatarError('server', `Error interno del asistente${detail}`, 500);
      default:
        return new RagAvatarError(
          res.status >= 500 ? 'server' : 'bad-request',
          `Error del asistente (HTTP ${res.status})${detail}`,
          res.status,
        );
    }
  }

  /**
   * Normalize the raw payload to RagAvatarResponse. Accepts the structured shape
   * ({body, gestureCommands, media, sources}) and tolerates the legacy
   * ({answer, sources}) shape, mapping `answer` to both body and gestureCommands
   * with empty media.
   */
  private normalize(data: unknown): RagAvatarResponse {
    const obj = (data ?? {}) as Record<string, any>;
    const suggestions = Array.isArray(obj['suggestions'])
      ? (obj['suggestions'] as any[]).map((s) => String(s)) : undefined;

    // Suggestions-mode payload: { suggestions: [...] } with no body/summary.
    if (suggestions && typeof obj['summary'] !== 'string' && typeof obj['body'] !== 'string' && typeof obj['gestureCommands'] !== 'string') {
      return { body: '', gestureCommands: '', media: [], sources: [], suggestions };
    }

    // Structured shape: has summary/body or gestureCommands.
    if (typeof obj['summary'] === 'string' || typeof obj['body'] === 'string' || typeof obj['gestureCommands'] === 'string') {
      const summary = (obj['summary'] ?? obj['body'] ?? obj['gestureCommands'] ?? '').toString();
      const body = summary;
      const gestureCommands = (obj['gestureCommands'] ?? summary).toString();
      const detail = (obj['detail'] ?? '').toString();
      // OPTIONAL contract segments. Validated minimally; absent -> undefined so the
      // rest of the app keeps today's spoken == display == summary behavior.
      const rawSegments = obj['segments'];
      const segments = Array.isArray(rawSegments)
        ? (rawSegments as any[])
            .filter((s) => s && (typeof s.spoken === 'string' || typeof s.display === 'string'))
            .map((s) => ({
              spoken: (s.spoken ?? s.display ?? '').toString(),
              display: (s.display ?? s.spoken ?? '').toString(),
              gestureHints: Array.isArray(s.gestureHints) ? s.gestureHints.map((g: any) => String(g)) : undefined,
            }))
        : undefined;
      return {
        body,
        summary,
        detail,
        gestureCommands,
        media: Array.isArray(obj['media']) ? (obj['media'] as MediaItem[]) : [],
        sources: Array.isArray(obj['sources']) ? (obj['sources'] as RagSource[]) : [],
        suggestions,
        ...(segments && segments.length ? { segments } : {}),
      };
    }

    // Legacy shape: { answer, sources }.
    const legacy = obj as LegacyRagResponse;
    if (typeof legacy.answer === 'string') {
      return {
        body: legacy.answer,
        gestureCommands: legacy.answer,
        media: [],
        sources: Array.isArray(legacy.sources) ? legacy.sources : [],
      };
    }

    // Unknown/empty — return a safe empty answer rather than throwing.
    return { body: '', gestureCommands: '', media: [], sources: [] };
  }

  /**
   * Resolve a Storage object to an object URL, enforcing rules at fetch time.
   * Reads from the CROSS-PROJECT RAG media bucket (environment.ragMediaBucket).
   * Prefers getBlob (auth-scoped, no forgeable URL); falls back to getDownloadURL
   * only when getBlob is blocked by CORS. Throws MediaUnauthorizedError on denial.
   * Caller is responsible for URL.revokeObjectURL when done with a blob URL.
   */
  async resolveMediaUrl(storagePath: string, maxBytes = 96 * 1024 * 1024): Promise<string> {
    const storage = getStorageForBucket(getRagMediaBucket());
    const r = ref(storage, storagePath);
    try {
      const blob = await getBlob(r, maxBytes);
      return URL.createObjectURL(blob);
    } catch (e: any) {
      const code: string = e?.code ?? '';
      if (code.includes('unauthorized') || code.includes('permission-denied')) {
        throw new MediaUnauthorizedError(storagePath);
      }
      // getBlob uses XHR and needs CORS configured; fall back to a download URL,
      // which still requires read permission (rules enforced server-side).
      try {
        return await getDownloadURL(r);
      } catch (e2: any) {
        const code2: string = e2?.code ?? '';
        if (code2.includes('unauthorized') || code2.includes('permission-denied')) {
          throw new MediaUnauthorizedError(storagePath);
        }
        throw e2;
      }
    }
  }
}
