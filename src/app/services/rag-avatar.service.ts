import { Injectable, signal } from '@angular/core';
import { getIdToken } from 'firebase/auth';
import { getBlob, getDownloadURL, ref } from 'firebase/storage';
import { getFirebaseAuth, getStorageForBucket } from './firebase-client';
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
  | 'server'
  | 'network';

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
      language: opts.language ?? 'es',
      voice: opts.voice,
      ragPath: opts.ragPath,
      preview: opts.preview,
    };

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
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
      throw await this.toError(res);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new RagAvatarError('server', 'El asistente devolvió una respuesta no válida.', res.status);
    }

    const normalized = this.normalize(data);
    this.lastMedia.set(normalized.media);
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

    // Structured shape: has body or gestureCommands.
    if (typeof obj['body'] === 'string' || typeof obj['gestureCommands'] === 'string') {
      const body = (obj['body'] ?? obj['gestureCommands'] ?? '').toString();
      const gestureCommands = (obj['gestureCommands'] ?? obj['body'] ?? '').toString();
      return {
        body,
        gestureCommands,
        media: Array.isArray(obj['media']) ? (obj['media'] as MediaItem[]) : [],
        sources: Array.isArray(obj['sources']) ? (obj['sources'] as RagSource[]) : [],
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
