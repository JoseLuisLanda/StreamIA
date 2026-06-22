import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { getFirebaseFirestoreClient } from '../../services/firebase-client';
import { AuthService } from '../../services/auth.service';

/**
 * User Profile: the "understand my usage" view. Reads the per-account quota and
 * its ledger LIVE from Firestore (owner-readable; never written client-side).
 * This is a deliberate visit, not a hot path, so a direct read is fine. Quota is
 * per ACCOUNT -- the same balance is spent across every assistant.
 */
interface QuotaDoc {
  allocated: number; used: number; remaining: number;
  periodStart: number; periodEnd: number;
  resetMode: 'monthly' | 'manual'; warnThresholds: number[];
}
interface LedgerRow { type: string; amount: number; balanceAfter: number; by: string; reason: string; at: number; }

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="wrap">
      <header class="head">
        <div>
          <h1>Mi cuenta</h1>
          <p class="sub">Tu saldo de consultas es por CUENTA: se comparte entre todos los asistentes.</p>
        </div>
        <a class="tlink" routerLink="/assistants">&larr; Asistentes</a>
      </header>

      <p class="note" *ngIf="!auth.user()">Inicia sesion para ver tu cuota.</p>
      <p class="err" *ngIf="error()">{{ error() }}</p>

      <ng-container *ngIf="auth.user()">
        <section class="card">
          <div class="ch"><h2>Consultas</h2><span class="spin" *ngIf="loading()"></span></div>

          <ng-container *ngIf="quota() as q; else noq">
            <div class="bar"><i [style.width.%]="usedPct()"></i></div>
            <div class="kpis">
              <div class="kpi"><span>Asignadas</span><b>{{ q.allocated | number }}</b></div>
              <div class="kpi"><span>Usadas</span><b>{{ q.used | number }}</b></div>
              <div class="kpi" [class.zero]="q.remaining <= 0"><span>Restantes</span><b>{{ q.remaining | number }}</b></div>
            </div>
            <div class="meta">
              <span>Periodo: {{ q.periodStart | date:'mediumDate' }} &rarr; {{ q.periodEnd | date:'mediumDate' }}</span>
              <span>Modo: {{ q.resetMode === 'monthly' ? 'mensual' : 'manual' }}</span>
              <span *ngIf="q.resetMode === 'monthly'">Proximo reinicio: {{ q.periodEnd | date:'mediumDate' }}</span>
            </div>
            <p class="blocked" *ngIf="q.remaining <= 0">Has agotado tus consultas; contacta para recargar.</p>
          </ng-container>
          <ng-template #noq>
            <p class="note" *ngIf="!loading()">Aun no tienes una cuota asignada. Contacta a un administrador.</p>
          </ng-template>
        </section>

        <section class="card" *ngIf="ledger().length">
          <h2>Historial</h2>
          <table class="ledger">
            <tr><th>Fecha</th><th>Tipo</th><th>Monto</th><th>Saldo</th><th>Motivo</th></tr>
            <tr *ngFor="let l of ledger(); trackBy: trackLed">
              <td>{{ l.at ? (l.at | date:'short') : '' }}</td>
              <td>{{ label(l.type) }}</td>
              <td>{{ l.amount | number }}</td>
              <td>{{ l.balanceAfter | number }}</td>
              <td>{{ l.reason }}</td>
            </tr>
          </table>
        </section>
      </ng-container>
    </div>
  `,
  styles: [`
    :host { display: block; background: #0e0f13; color: #e8e9ee; min-height: 100vh; }
    .wrap { max-width: 760px; margin: 0 auto; padding: 24px 20px 60px; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 22px; }
    h2 { margin: 0; font-size: 15px; }
    .ch { display: flex; align-items: center; gap: 10px; }
    .sub { color: #8b92a3; font-size: 12.5px; margin: 4px 0 0; }
    .tlink { color: #cbb8f8; text-decoration: none; font-size: 13px; white-space: nowrap; }
    .err { color: #f0a6a6; font-size: 13px; }
    .note { color: #8b92a3; font-size: 12.5px; }
    .card { background: #15161c; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 16px; margin-top: 16px; }
    .bar { height: 8px; background: rgba(255,255,255,.08); border-radius: 999px; overflow: hidden; margin: 12px 0; }
    .bar i { display: block; height: 100%; background: linear-gradient(90deg,#8b5cf6,#b6e84a); }
    .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .kpi { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
    .kpi span { font-size: 11px; color: #8b92a3; }
    .kpi b { font-size: 20px; }
    .kpi.zero b { color: #f0a6a6; }
    .meta { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; color: #aab; }
    .blocked { margin-top: 12px; color: #f0a6a6; font-size: 13px; }
    table.ledger { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
    table.ledger th, table.ledger td { border: 1px solid rgba(255,255,255,.08); padding: 6px 9px; text-align: left; }
    .spin { width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.25); border-top-color: #cbb8f8; border-radius: 50%; display: inline-block; animation: sp .8s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
  `]
})
export class ProfileComponent implements OnInit {
  auth = inject(AuthService);
  readonly quota = signal<QuotaDoc | null>(null);
  readonly ledger = signal<LedgerRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

  readonly usedPct = computed(() => {
    const q = this.quota();
    if (!q || !q.allocated) return 0;
    return Math.min(100, Math.round((q.used / q.allocated) * 100));
  });

  trackLed = (_: number, l: LedgerRow) => l.at + ':' + l.type + ':' + l.amount;

  async ngOnInit(): Promise<void> {
    await this.auth.waitUntilReady();
    const u = this.auth.user();
    if (!u) return;
    this.loading.set(true);
    try {
      const db = getFirebaseFirestoreClient();
      const cur = await getDoc(doc(db, 'users', u.uid, 'quota', 'current'));
      this.quota.set(cur.exists() ? (cur.data() as QuotaDoc) : null);
      const led = await getDocs(query(
        collection(db, 'users', u.uid, 'quota', 'current', 'ledger'),
        orderBy('at', 'desc'), limit(50),
      ));
      this.ledger.set(led.docs.map((d) => {
        const v = d.data() as any;
        return {
          type: v.type ?? '', amount: Number(v.amount ?? 0), balanceAfter: Number(v.balanceAfter ?? 0),
          by: v.by ?? '', reason: v.reason ?? '', at: Number(v.at ?? 0),
        };
      }));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  label(type: string): string {
    switch (type) {
      case 'allocation': return 'Asignacion';
      case 'topup': return 'Recarga';
      case 'reset': return 'Reinicio';
      case 'auto-allocation': return 'Alta automatica';
      case 'consumption': return 'Consumo';
      default: return type;
    }
  }
}
