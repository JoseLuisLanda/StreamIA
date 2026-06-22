/**
 * Quota administration callables (strimearia) -- Admin SDK, server-side.
 *
 *   - allocateQuota({ uid, amount, mode, reason }) -> set absolute OR add (top-up)
 *     a user's allocation, recompute remaining, append a ledger entry.
 *   - getQuota({ uid }) -> current quota + recent ledger (for the admin panel).
 *   - resetQuotaPeriod({ uid }) -> roll the monthly period: used=0,
 *     remaining=allocated, new period window, ledger entry.
 *
 * Quota docs are NOT client-writable (firestore.rules): every mutation flows
 * through these admin callables (or the server-side consumeOneQuota). Admin-gated
 * the same way as the other admin callables.
 *
 * PAYMENT HOOK (stub): allocateQuota is the single entry point a future payment
 * webhook (Stripe, etc.) would call after a confirmed purchase -- see the TODO in
 * allocateQuota. No real payment processing is implemented here; manual admin
 * top-up is the working path for now.
 */
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';
import {
  currentRef, ledgerCol, freshQuota, addMonth, QuotaState, DEFAULT_WARN_THRESHOLDS,
} from './lib/quota';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

async function gate(auth: Parameters<typeof assertSignedIn>[0]): Promise<string> {
  const uid = assertSignedIn(auth);
  if (ENFORCE_ADMIN_ROLE) await assertAdmin(auth);
  return uid;
}

interface AllocateReq {
  uid: string;
  amount: number;
  /** 'set' = absolute allocation; 'add' = top-up (default). */
  mode?: 'set' | 'add';
  reason?: string;
  /** internal marker so a future payment webhook can label the source. */
  source?: string;
}

/**
 * Set or top-up a user's allocation (atomic). Recomputes remaining = allocated -
 * used (never negative) and appends a ledger entry.
 *
 * TODO(payment): a Stripe (or other) webhook handler, after verifying a paid
 * checkout.session, should call allocateQuota({ uid, amount, mode:'add',
 * reason:'purchase <sku>', source:'stripe:<eventId>' }). Keep that the ONLY path
 * that grants quota so the ledger stays the single source of truth.
 */
export const allocateQuota = onCall<AllocateReq, Promise<{ ok: true; quota: QuotaState }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true; quota: QuotaState }> => {
    const by = await gate(req.auth);
    const uid = (req.data?.uid ?? '').trim();
    const amount = Number(req.data?.amount);
    const mode = req.data?.mode === 'set' ? 'set' : 'add';
    const reason = (req.data?.reason ?? '').toString().slice(0, 200) || (mode === 'set' ? 'admin set allocation' : 'admin top-up');
    if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');
    if (!Number.isFinite(amount) || amount < 0) throw new HttpsError('invalid-argument', 'amount must be a non-negative number.');

    const ref = currentRef(uid);
    const out = await db.runTransaction(async (tx): Promise<QuotaState> => {
      const snap = await tx.get(ref);
      const q: QuotaState = snap.exists ? (snap.data() as QuotaState) : freshQuota(0);
      const used = Number(q.used ?? 0);
      const allocated = mode === 'set' ? amount : Number(q.allocated ?? 0) + amount;
      const remaining = Math.max(0, allocated - used);
      const next: QuotaState = {
        allocated,
        used,
        remaining,
        periodStart: Number(q.periodStart ?? Date.now()),
        periodEnd: Number(q.periodEnd ?? addMonth(Date.now())),
        resetMode: q.resetMode === 'manual' ? 'manual' : 'monthly',
        warnThresholds: Array.isArray(q.warnThresholds) && q.warnThresholds.length ? q.warnThresholds : DEFAULT_WARN_THRESHOLDS,
      };
      tx.set(ref, { ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(ledgerCol(uid).doc(), {
        type: mode === 'set' ? 'allocation' : 'topup',
        amount: mode === 'set' ? amount : amount,
        balanceAfter: remaining,
        by: req.data?.source ? `${by} (${req.data.source})` : by,
        reason,
        at: Date.now(),
        createdAt: FieldValue.serverTimestamp(),
      });
      return next;
    });
    logger.info('allocateQuota', { by, uid, amount, mode });
    return { ok: true, quota: out };
  },
);

interface LedgerRow {
  type: string; amount: number; balanceAfter: number; by: string; reason: string; at: number;
}

export const getQuota = onCall<{ uid: string }, Promise<{ quota: QuotaState | null; ledger: LedgerRow[] }>>(
  CALL_OPTS,
  async (req): Promise<{ quota: QuotaState | null; ledger: LedgerRow[] }> => {
    await gate(req.auth);
    const uid = (req.data?.uid ?? '').trim();
    if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');
    const snap = await currentRef(uid).get();
    const quota = snap.exists ? (snap.data() as QuotaState) : null;
    const led = await ledgerCol(uid).orderBy('at', 'desc').limit(25).get();
    const ledger: LedgerRow[] = led.docs.map((d) => {
      const v = d.data() as any;
      return {
        type: v.type ?? '', amount: Number(v.amount ?? 0), balanceAfter: Number(v.balanceAfter ?? 0),
        by: v.by ?? '', reason: v.reason ?? '', at: Number(v.at ?? 0),
      };
    });
    return { quota, ledger };
  },
);

export const resetQuotaPeriod = onCall<{ uid: string }, Promise<{ ok: true; quota: QuotaState }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true; quota: QuotaState }> => {
    const by = await gate(req.auth);
    const uid = (req.data?.uid ?? '').trim();
    if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');
    const ref = currentRef(uid);
    const out = await db.runTransaction(async (tx): Promise<QuotaState> => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', `No quota for user ${uid}.`);
      const q = snap.data() as QuotaState;
      const now = Date.now();
      const next: QuotaState = {
        ...q,
        used: 0,
        remaining: Number(q.allocated ?? 0),
        periodStart: now,
        periodEnd: addMonth(now),
      };
      tx.set(ref, { ...next, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(ledgerCol(uid).doc(), {
        type: 'reset', amount: Number(q.allocated ?? 0), balanceAfter: Number(q.allocated ?? 0),
        by, reason: 'period reset', at: now, createdAt: FieldValue.serverTimestamp(),
      });
      return next;
    });
    logger.info('resetQuotaPeriod', { by, uid });
    return { ok: true, quota: out };
  },
);

// TODO(scheduler): auto monthly reset. A Cloud Scheduler job (firebase-functions/v2
// scheduler onSchedule '0 0 1 * *') could query users whose quota.resetMode ==
// 'monthly' AND periodEnd <= now and reset each (reusing the resetQuotaPeriod
// transaction). Left as a TODO: it needs the Cloud Scheduler API enabled and a
// paginated sweep over users; the per-user callable above covers manual resets.
