/**
 * RAG Function endpoint configuration.
 *
 * The deployed endpoint and the cross-project media bucket live in
 * `src/environments/environment.ts` (NOT hardcoded in components). This module
 * composes them into the values the client uses, and layers an optional
 * localStorage override on top so the endpoint/deployment can be retargeted for
 * dev without a rebuild (Settings → "Modo informativo (RAG)").
 *
 * Resolution order for every getter: localStorage override → environment default.
 *
 * The client never holds LLM/RAG secrets — it only needs the URL and the
 * signed-in user's Firebase ID token (sent as `Authorization: Bearer <token>`).
 */
import { environment } from '../../../environments/environment';

const LS_ENDPOINT = 'rag.endpoint'; // full URL override (base + path), legacy/dev
const LS_API_BASE = 'rag.apiBase';
const LS_CHAT_PATH = 'rag.chatPath';
const LS_ASSISTANT = 'rag.assistantId';
const LS_MEDIA_BUCKET = 'rag.mediaBucket';

/** Default assistant id when none is otherwise selected (phase-one demo). */
export const DEFAULT_ASSISTANT_ID = 'default';

function read(key: string): string {
  try {
    return (localStorage.getItem(key) || '').trim();
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(key, value.trim());
    else localStorage.removeItem(key);
  } catch {
    /* ignore (private mode / SSR) */
  }
}

/** Base URL of the RAG Function router (override → environment). */
export function getRagApiBase(): string {
  return read(LS_API_BASE) || environment.ragApiBase || '';
}

/** Route where chatRag is mounted, normalized to a leading slash. */
export function getRagChatPath(): string {
  const p = read(LS_CHAT_PATH) || environment.ragChatPath || '';
  if (!p) return '';
  return p.startsWith('/') ? p : `/${p}`;
}

/** Cross-project Storage bucket holding RAG media (override → environment). */
export function getRagMediaBucket(): string {
  return read(LS_MEDIA_BUCKET) || environment.ragMediaBucket || '';
}

/**
 * Resolve the full endpoint URL. A whole-URL localStorage override (legacy
 * `rag.endpoint`) wins; otherwise base + path are composed, trimming any double
 * slash at the join.
 */
export function getRagEndpoint(): string {
  const whole = read(LS_ENDPOINT);
  if (whole) return whole;
  const base = getRagApiBase().replace(/\/+$/, '');
  const path = getRagChatPath();
  if (!base) return '';
  return path ? `${base}${path}` : base;
}

/** Set/clear the whole-URL endpoint override (Settings UI). Empty clears it. */
export function setRagEndpoint(url: string): void {
  write(LS_ENDPOINT, url);
}

export function setRagApiBase(url: string): void {
  write(LS_API_BASE, url);
}

export function setRagChatPath(path: string): void {
  write(LS_CHAT_PATH, path);
}

export function setRagMediaBucket(bucket: string): void {
  write(LS_MEDIA_BUCKET, bucket);
}

/** Resolve the active assistant id (localStorage override -> default). */
export function getAssistantId(): string {
  return read(LS_ASSISTANT) || DEFAULT_ASSISTANT_ID;
}

export function setAssistantId(id: string): void {
  write(LS_ASSISTANT, id);
}
