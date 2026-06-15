import { Injectable } from '@angular/core';
import { getIdToken } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseAuth, getFirebaseFunctionsClient } from './firebase-client';

export type Role = 'admin' | 'user';

export interface UserRow {
  uid: string;
  email?: string;
  role: Role;
  updatedAt?: number;
}

export interface SetRoleResult {
  ok: boolean;
  uid: string;
  email?: string;
  role: Role;
  note: string;
}

/**
 * Client transport for the Role Admin panel. All authority is server-side
 * (Admin SDK callables); this only invokes them and force-refreshes the local
 * token after a self-affecting change so the new claim is picked up.
 */
@Injectable({ providedIn: 'root' })
export class RoleAdminService {
  /** List users from the Firestore registry (admin-only callable). */
  async listUsers(): Promise<UserRow[]> {
    const callable = httpsCallable<unknown, { users: UserRow[] }>(
      getFirebaseFunctionsClient(),
      'listUsers',
    );
    const res = await callable({});
    return res.data.users ?? [];
  }

  /** Grant/revoke admin by uid or email (admin-only callable). */
  async setUserRole(target: { uid?: string; email?: string }, role: Role): Promise<SetRoleResult> {
    const callable = httpsCallable<{ uid?: string; email?: string; role: Role }, SetRoleResult>(
      getFirebaseFunctionsClient(),
      'setUserRole',
    );
    try {
      const res = await callable({ ...target, role });
      await this.maybeRefreshSelf(res.data?.uid);
      return res.data;
    } catch (e: any) {
      throw new Error(describe(e));
    }
  }

  /** One-time: grant the caller admin if no admin exists / on the allowlist. */
  async bootstrapFirstAdmin(): Promise<SetRoleResult> {
    const callable = httpsCallable<unknown, SetRoleResult>(
      getFirebaseFunctionsClient(),
      'bootstrapFirstAdmin',
    );
    try {
      const res = await callable({});
      await this.maybeRefreshSelf(res.data?.uid);
      return res.data;
    } catch (e: any) {
      throw new Error(describe(e));
    }
  }

  /** Force a token refresh when the change targeted the current user. */
  private async maybeRefreshSelf(targetUid?: string): Promise<void> {
    const user = getFirebaseAuth().currentUser;
    if (user && targetUid && user.uid === targetUid) {
      try { await getIdToken(user, /* forceRefresh */ true); } catch { /* ignore */ }
    }
  }
}

function describe(e: any): string {
  const code = e?.code ? ` (${e.code})` : '';
  const detail = e?.details
    ? `: ${typeof e.details === 'string' ? e.details : JSON.stringify(e.details)}`
    : '';
  return `${e?.message ?? String(e)}${code}${detail}`;
}
