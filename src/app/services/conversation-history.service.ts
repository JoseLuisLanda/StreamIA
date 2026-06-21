import { Injectable, signal } from '@angular/core';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getFirebaseFirestoreClient } from './firebase-client';
import { ConvMessage } from './conversation.service';

/**
 * Per-user, per-assistant conversation history persisted to Firestore.
 *
 * Storage: users/{uid}/conversations/{conversationId}. Scoped to the signed-in
 * Firebase Auth user (uid); the email is stored on each record for human
 * identification. ONE doc per visit/session to an assistant, created LAZILY on
 * the first real message (never an empty record), then updated in place as more
 * turns happen. A new visit starts a new doc (the component nulls currentId on
 * enter / assistant-change / back via resetCurrent()).
 *
 * This service is transport-only: the component owns session lifecycle and tells
 * us when to save/list/restore/delete. Nothing here touches the 3D scene/audio.
 */

/** A single persisted chat turn (a restorable subset of ConvMessage). */
export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: number;
  meta?: string;
  kind?: 'info' | 'error';
  /** RAG long-form detail (only if it had been fetched). */
  detail?: string;
  /** RAG: a detail CAN be fetched on demand for this message. */
  detailAvailable?: boolean;
  /** RAG: chunk ids reused by the on-demand detail call. */
  sourceIds?: string[];
  /** RAG: the originating user question for the on-demand detail call. */
  srcQuery?: string;
  /** RAG media references (small string metadata; bytes are lazy-fetched from Storage). */
  media?: any[];
}

/** The stored conversation document shape (users/{uid}/conversations/{id}). */
export interface ConversationDoc {
  uid: string;
  email: string | null;
  assistantId: string;
  assistantName: string;
  avatarId: string;
  /** first user message, truncated -- the list label. */
  title: string;
  messageCount: number;
  /** epoch ms */
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

/** Lightweight list-row summary (no messages array) for the history list UI. */
export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

const MAX_TITLE = 80;

@Injectable({ providedIn: 'root' })
export class ConversationHistoryService {
  /** Firestore doc id of the conversation for the ACTIVE session, or null (new session). */
  private currentId = signal<string | null>(null);
  /** History rows for the current assistant (newest first). */
  readonly list = signal<ConversationSummary[]>([]);
  /** True while a list query is in flight (for a small spinner/empty-state gating). */
  readonly loading = signal<boolean>(false);

  currentConversationId(): string | null { return this.currentId(); }
  setCurrent(id: string | null): void { this.currentId.set(id); }
  /** New session: forget the active doc so the next save creates a fresh one. */
  resetCurrent(): void { this.currentId.set(null); }

  /** Build the list label from the first user message (or a fallback). */
  private titleFrom(messages: StoredMessage[]): string {
    const firstUser = messages.find((m) => m.role === 'user' && (m.content ?? '').trim());
    const raw = (firstUser?.content ?? messages.find((m) => (m.content ?? '').trim())?.content ?? 'Conversacion').trim();
    return raw.length > MAX_TITLE ? raw.slice(0, MAX_TITLE - 1).trimEnd() + '...' : raw;
  }

  /** Strip undefined fields (Firestore rejects them) and keep only restorable data. */
  private toStored(m: ConvMessage): StoredMessage {
    const s: StoredMessage = { id: m.id, role: m.role, content: m.content ?? '', at: m.at ?? Date.now() };
    if (m.meta != null) s.meta = m.meta;
    if (m.kind != null) s.kind = m.kind;
    if (m.detail != null && m.detail !== '') s.detail = m.detail;
    if (m.detailAvailable != null) s.detailAvailable = m.detailAvailable;
    if (Array.isArray(m.sourceIds) && m.sourceIds.length) s.sourceIds = m.sourceIds;
    if (m.srcQuery != null && m.srcQuery !== '') s.srcQuery = m.srcQuery;
    if (Array.isArray(m.media) && m.media.length) {
      s.media = m.media.map((x: any) => {
        const o: any = { id: x.id, type: x.type, title: x.title ?? '', storagePath: x.storagePath };
        if (x.thumbnailPath != null) o.thumbnailPath = x.thumbnailPath;
        if (x.caption != null) o.caption = x.caption;
        return o;
      });
    }
    return s;
  }

  /**
   * Create-or-update the active session's conversation doc. Creates lazily on the
   * first call (captures the new id into currentId); updates in place after. Skips
   * silently when there is no uid or no persistable message. Best-effort: a write
   * failure (rules/offline) never throws into the chat flow.
   */
  async save(params: {
    uid: string;
    email: string | null;
    assistantId: string;
    assistantName: string;
    avatarId: string;
    messages: ConvMessage[];
  }): Promise<void> {
    const { uid, assistantId } = params;
    if (!uid || !assistantId) return;
    const stored = params.messages
      .filter((m) => m.role !== 'system' && (m.content ?? '').trim())
      .map((m) => this.toStored(m));
    if (!stored.length) return; // never persist an empty conversation
    const now = Date.now();
    try {
      const db = getFirebaseFirestoreClient();
      const id = this.currentId();
      if (id) {
        await updateDoc(doc(db, 'users', uid, 'conversations', id), {
          messages: stored,
          messageCount: stored.length,
          title: this.titleFrom(stored),
          updatedAt: now,
        });
      } else {
        const payload: ConversationDoc = {
          uid,
          email: params.email ?? null,
          assistantId,
          assistantName: params.assistantName ?? '',
          avatarId: params.avatarId ?? '',
          title: this.titleFrom(stored),
          messageCount: stored.length,
          createdAt: now,
          updatedAt: now,
          messages: stored,
        };
        const ref = await addDoc(collection(db, 'users', uid, 'conversations'), payload as any);
        this.currentId.set(ref.id);
      }
    } catch (e) {
      console.warn('[history] save skipped:', (e as any)?.message ?? e);
    }
  }

  /**
   * Load the signed-in user's conversation summaries for ONE assistant, newest
   * first. Returns [] (and clears the list) on any error or empty result.
   */
  async loadList(uid: string, assistantId: string): Promise<void> {
    if (!uid || !assistantId) { this.list.set([]); return; }
    this.loading.set(true);
    try {
      const db = getFirebaseFirestoreClient();
      // Filter by assistantId only (single-field, no composite index needed) and
      // sort newest-first on the client.
      const q = query(
        collection(db, 'users', uid, 'conversations'),
        where('assistantId', '==', assistantId),
      );
      const snap = await getDocs(q);
      const rows: ConversationSummary[] = snap.docs.map((d) => {
        const v = d.data() as any;
        return {
          id: d.id,
          title: v.title ?? 'Conversacion',
          messageCount: v.messageCount ?? (Array.isArray(v.messages) ? v.messages.length : 0),
          createdAt: v.createdAt ?? 0,
          updatedAt: v.updatedAt ?? v.createdAt ?? 0,
        };
      });
      rows.sort((a, b) => b.updatedAt - a.updatedAt);
      this.list.set(rows);
    } catch (e) {
      console.warn('[history] loadList failed:', (e as any)?.message ?? e);
      this.list.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  /** Fetch one conversation's full message array for restore. Returns [] on miss. */
  async restore(uid: string, convId: string): Promise<StoredMessage[]> {
    if (!uid || !convId) return [];
    try {
      const db = getFirebaseFirestoreClient();
      const snap = await getDoc(doc(db, 'users', uid, 'conversations', convId));
      if (!snap.exists()) return [];
      const v = snap.data() as any;
      return Array.isArray(v.messages) ? (v.messages as StoredMessage[]) : [];
    } catch (e) {
      console.warn('[history] restore failed:', (e as any)?.message ?? e);
      return [];
    }
  }

  /** Hard-delete a conversation the user explicitly chose to remove. */
  async remove(uid: string, convId: string): Promise<void> {
    if (!uid || !convId) return;
    const db = getFirebaseFirestoreClient();
    await deleteDoc(doc(db, 'users', uid, 'conversations', convId));
    if (this.currentId() === convId) this.currentId.set(null);
    this.list.update((rows) => rows.filter((r) => r.id !== convId));
  }
}
