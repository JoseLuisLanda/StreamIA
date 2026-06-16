/**
 * IndexedDB read-through cache for per-assistant conversational content.
 * Survives page reloads / browser restarts. Keyed by assistantId. A thin
 * promise wrapper over the raw IndexedDB API (no external deps).
 *
 * Store: db "textavatar-conv" v1, objectStore "content" (keyPath: assistantId),
 * holding CachedConvContent envelopes.
 */
import { CachedConvContent } from './conv-content.models';

const DB_NAME = 'textavatar-conv';
const DB_VERSION = 1;
const STORE = 'content';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'assistantId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

/** Read a cached envelope, or null on miss / any error (caller falls back to Firestore). */
export async function cacheGet(assistantId: string): Promise<CachedConvContent | null> {
  try {
    const db = await openDb();
    return await new Promise<CachedConvContent | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(assistantId);
      req.onsuccess = () => resolve((req.result as CachedConvContent) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/** Write (overwrite) a cached envelope. Best-effort; swallows errors. */
export async function cachePut(entry: CachedConvContent): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* cache write best-effort */
  }
}

/** Remove a cached envelope (e.g. on assistant delete). */
export async function cacheDelete(assistantId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(assistantId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort */
  }
}
