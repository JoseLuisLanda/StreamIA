import { Injectable } from '@angular/core';
import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctionsClient } from './firebase-client';

/**
 * Admin transport for the per-account quota system. All mutations go through
 * admin-gated callables (Admin SDK); quota docs are not client-writable.
 */
export interface QuotaState {
  allocated: number;
  used: number;
  remaining: number;
  periodStart: number;
  periodEnd: number;
  resetMode: 'monthly' | 'manual';
  warnThresholds: number[];
  updatedAt?: number;
}

export interface QuotaLedgerRow {
  type: string;
  amount: number;
  balanceAfter: number;
  by: string;
  reason: string;
  at: number;
}

@Injectable({ providedIn: 'root' })
export class QuotaService {
  async getQuota(uid: string): Promise<{ quota: QuotaState | null; ledger: QuotaLedgerRow[] }> {
    const callable = httpsCallable<{ uid: string }, { quota: QuotaState | null; ledger: QuotaLedgerRow[] }>(
      getFirebaseFunctionsClient(), 'getQuota',
    );
    const res = await callable({ uid });
    return res.data;
  }

  /** mode 'set' = absolute allocation; 'add' = top-up. */
  async allocateQuota(uid: string, amount: number, mode: 'set' | 'add', reason?: string): Promise<QuotaState> {
    const callable = httpsCallable<
      { uid: string; amount: number; mode: 'set' | 'add'; reason?: string },
      { ok: true; quota: QuotaState }
    >(getFirebaseFunctionsClient(), 'allocateQuota');
    const res = await callable({ uid, amount, mode, reason });
    return res.data.quota;
  }

  async resetQuotaPeriod(uid: string): Promise<QuotaState> {
    const callable = httpsCallable<{ uid: string }, { ok: true; quota: QuotaState }>(
      getFirebaseFunctionsClient(), 'resetQuotaPeriod',
    );
    const res = await callable({ uid });
    return res.data.quota;
  }
}
