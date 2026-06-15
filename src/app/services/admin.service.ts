import { Injectable, signal } from '@angular/core';
import { getIdTokenResult } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getFirebaseAuth, getFirebaseFirestoreClient } from './firebase-client';

/**
 * Admin authorization for the RAG Admin panel (and any other admin-only surface).
 *
 * An account is admin if EITHER:
 *   - its Firebase Auth custom claims include `role == 'admin'` or `admin == true`
 *     (matches the Express `requireRole('admin')` middleware and firestore.rules
 *     `isAdmin()`), OR
 *   - there is an allowlist doc at Firestore `admins/{uid}` (any existing doc).
 *
 * The claim path is authoritative and cheap (read from the ID token). The
 * allowlist is a convenience for granting admin without minting claims; it is
 * also enforced server-side by the recommended rules. NOTE: client-side checks
 * are for UX only -- real enforcement lives in Firestore/Storage rules and the
 * callable Functions. Never trust this signal for security decisions.
 */
@Injectable({ providedIn: 'root' })
export class AdminService {
  /** Latest known admin status (null = not yet determined). */
  readonly isAdmin = signal<boolean | null>(null);
  readonly checking = signal(false);

  private lastUid: string | null = null;
  private inflight: Promise<boolean> | null = null;

  /**
   * Resolve whether the current user is an admin. Cached per uid for the session;
   * pass force=true to re-read (e.g. after a claims refresh).
   */
  async check(force = false): Promise<boolean> {
    const user = getFirebaseAuth().currentUser;
    if (!user) {
      this.lastUid = null;
      this.isAdmin.set(false);
      return false;
    }
    if (!force && this.lastUid === user.uid && this.isAdmin() !== null) {
      return this.isAdmin() === true;
    }
    if (this.inflight) return this.inflight;

    this.checking.set(true);
    this.inflight = (async () => {
      let admin = false;
      try {
        // 1) Custom claims from the ID token (force-refresh to pick up recent grants).
        const res = await getIdTokenResult(user, force);
        const claims = res.claims as Record<string, unknown>;
        admin = claims['role'] === 'admin' || claims['admin'] === true;

        // 2) Fallback: Firestore allowlist doc admins/{uid}.
        if (!admin) {
          try {
            const snap = await getDoc(doc(getFirebaseFirestoreClient(), 'admins', user.uid));
            admin = snap.exists() && (snap.data()?.['disabled'] !== true);
          } catch {
            // permission-denied / offline -> treat as non-admin (UX only).
          }
        }
      } catch {
        admin = false;
      } finally {
        this.lastUid = user.uid;
        this.isAdmin.set(admin);
        this.checking.set(false);
        this.inflight = null;
      }
      return admin;
    })();

    return this.inflight;
  }
}
