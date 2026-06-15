/**
 * Role management callables (strimearia) -- Admin SDK, server-side.
 *
 *   - bootstrapFirstAdmin()            -> grants the CALLER the admin claim, but
 *                                         ONLY while no admin exists yet (or the
 *                                         caller is on the BOOTSTRAP_ADMIN_EMAILS
 *                                         allowlist). Refuses once an admin exists.
 *   - setUserRole({ uid?, email?, role }) -> admin-only; sets/clears the `admin`
 *                                         custom claim + mirrors admins/{uid} and
 *                                         users/{uid}.role.
 *   - listUsers()                      -> admin-only; lists the Firestore users/
 *                                         registry (populated on sign-in).
 *
 * The authoritative admin signal is the `admin` custom claim (token.role==='admin')
 * AND the admins/{uid} doc (written here via Admin SDK, which bypasses rules).
 * A claim change only takes effect after the affected user's ID token refreshes
 * (sign out/in or ~1h) -- surfaced in the UI.
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

type Role = 'admin' | 'user';

interface SetRoleRequest {
  uid?: string;
  email?: string;
  role: Role;
}
interface SetRoleResponse {
  ok: true;
  uid: string;
  email?: string;
  role: Role;
  note: string;
}

interface UserRow {
  uid: string;
  email?: string;
  role: Role;
  updatedAt?: number;
}

const TOKEN_NOTE =
  'Role updated. The change takes effect after the user signs out and back in ' +
  '(or after their ID token refreshes, up to ~1 hour).';

/** Bootstrap allowlist (optional extra guard). Comma-separated emails. */
function bootstrapAllowlist(): string[] {
  return (process.env['BOOTSTRAP_ADMIN_EMAILS'] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** True if at least one admin already exists (admins/* registry). */
async function adminExists(): Promise<boolean> {
  const snap = await db.collection('admins').limit(1).get();
  return !snap.empty;
}

async function writeRoleDocs(uid: string, email: string | undefined, role: Role): Promise<void> {
  const adminRef = db.collection('admins').doc(uid);
  const userRef = db.collection('users').doc(uid);
  if (role === 'admin') {
    await adminRef.set(
      { email: email ?? null, grantedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  } else {
    await adminRef.delete().catch(() => undefined);
  }
  await userRef.set(
    { email: email ?? null, role, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export const bootstrapFirstAdmin = onCall<unknown, Promise<SetRoleResponse>>(
  CALL_OPTS,
  async (req: CallableRequest<unknown>): Promise<SetRoleResponse> => {
    const uid = assertSignedIn(req.auth);
    const email = (req.auth?.token?.['email'] as string | undefined)?.toLowerCase();

    const allow = bootstrapAllowlist();
    const exists = await adminExists();

    // Refuse if an admin already exists AND the caller isn't on the allowlist.
    if (exists && !(email && allow.includes(email))) {
      throw new HttpsError(
        'failed-precondition',
        'An admin already exists. Ask an existing admin to grant your role in /role-admin.',
      );
    }
    // If an allowlist is configured, the caller must be on it (defense in depth).
    if (allow.length && !(email && allow.includes(email))) {
      throw new HttpsError('permission-denied', 'This account is not on the bootstrap allowlist.');
    }

    await getAuth().setCustomUserClaims(uid, { role: 'admin', admin: true });
    await writeRoleDocs(uid, email, 'admin');
    logger.info('bootstrapFirstAdmin: granted', { uid, email });
    return { ok: true, uid, email, role: 'admin', note: TOKEN_NOTE };
  },
);

export const setUserRole = onCall<SetRoleRequest, Promise<SetRoleResponse>>(
  CALL_OPTS,
  async (req): Promise<SetRoleResponse> => {
    // ALWAYS admin-only (role management is never relaxed by the dev flag).
    await assertAdmin(req.auth);

    const role = req.data?.role;
    if (role !== 'admin' && role !== 'user') {
      throw new HttpsError('invalid-argument', "role must be 'admin' or 'user'.");
    }

    // Resolve the target user by uid or email.
    let uid = (req.data?.uid ?? '').trim();
    let email = (req.data?.email ?? '').trim().toLowerCase() || undefined;
    try {
      if (!uid && email) {
        const u = await getAuth().getUserByEmail(email);
        uid = u.uid;
        email = u.email ?? email;
      } else if (uid) {
        const u = await getAuth().getUser(uid);
        email = u.email ?? email;
      }
    } catch (e) {
      throw new HttpsError('not-found', `User not found: ${email || uid}.`);
    }
    if (!uid) throw new HttpsError('invalid-argument', 'Provide a uid or an email.');

    // Prevent an admin from removing their OWN last admin access by accident:
    if (role === 'user' && uid === req.auth?.uid) {
      const snap = await db.collection('admins').limit(2).get();
      if (snap.size <= 1) {
        throw new HttpsError('failed-precondition', 'Cannot revoke the last remaining admin.');
      }
    }

    const claims = role === 'admin' ? { role: 'admin', admin: true } : {};
    await getAuth().setCustomUserClaims(uid, claims);
    await writeRoleDocs(uid, email, role);
    logger.info('setUserRole', { by: req.auth?.uid, uid, role });
    return { ok: true, uid, email, role, note: TOKEN_NOTE };
  },
);

export const listUsers = onCall<unknown, Promise<{ users: UserRow[] }>>(
  CALL_OPTS,
  async (req): Promise<{ users: UserRow[] }> => {
    await assertAdmin(req.auth);
    const snap = await db.collection('users').orderBy('email').limit(500).get();
    const adminSnap = await db.collection('admins').get();
    const adminUids = new Set(adminSnap.docs.map((d) => d.id));
    const users: UserRow[] = snap.docs.map((d) => {
      const data = d.data() as any;
      const role: Role = adminUids.has(d.id) || data.role === 'admin' ? 'admin' : 'user';
      return { uid: d.id, email: data.email ?? undefined, role, updatedAt: toMs(data.updatedAt) };
    });
    return { users };
  },
);

function toMs(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v?.toMillis === 'function') return v.toMillis();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return undefined;
}
