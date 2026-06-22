import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { QuotaService, QuotaState, QuotaLedgerRow } from '../../services/quota.service';
import { RoleAdminService, UserRow } from '../../services/role-admin.service';

/**
 * Cuotas: per-account query-quota admin panel. View any user's allocation/used/
 * remaining + ledger, and allocate or top-up via the admin callables. Reuses the
 * existing user-list source (RoleAdminService.listUsers).
 */
@Component({
  selector: 'app-cuotas',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="wrap">
      <header class="head">
        <div>
          <h1>Cuotas</h1>
          <p class="sub">Consultas por cuenta (se gastan en todos los asistentes). 1 interaccion = 1 unidad; bloqueo duro en 0.</p>
        </div>
        <a class="tlink" routerLink="/admin">&larr; Admin</a>
      </header>

      <p class="err" *ngIf="error()">{{ error() }}</p>

      <div class="cols">
        <!-- User list -->
        <aside class="users">
          <div class="lbl">Usuarios <span class="spin" *ngIf="loadingUsers()"></span></div>
          <button class="urow" *ngFor="let u of users()" [class.sel]="u.uid === selectedUid()" (click)="select(u)">
            <span class="uemail">{{ u.email || u.uid }}</span>
            <span class="urole">{{ u.role }}</span>
          </button>
          <p class="note" *ngIf="!loadingUsers() && !users().length">No hay usuarios en el registro.</p>
        </aside>

        <!-- Detail -->
        <main class="detail" *ngIf="selectedUid() as uid">
          <h2>{{ selectedEmail() || uid }}</h2>
          <span class="spin" *ngIf="loadingQuota()"></span>

          <div class="kpis" *ngIf="quota() as q">
            <div class="kpi"><span>Asignadas</span><b>{{ q.allocated | number }}</b></div>
            <div class="kpi"><span>Usadas</span><b>{{ q.used | number }}</b></div>
            <div class="kpi" [class.zero]="q.remaining <= 0"><span>Restantes</span><b>{{ q.remaining | number }}</b></div>
            <div class="kpi"><span>Modo</span><b>{{ q.resetMode }}</b></div>
          </div>
          <p class="note" *ngIf="!loadingQuota() && !quota()">Este usuario aun no tiene cuota; asigna una abajo.</p>

          <!-- Allocate / top-up -->
          <div class="alloc">
            <label>Cantidad <input type="number" min="0" step="100" [(ngModel)]="amount" /></label>
            <label>Modo
              <select [(ngModel)]="mode">
                <option value="add">Agregar (top-up)</option>
                <option value="set">Establecer (absoluto)</option>
              </select>
            </label>
            <label class="grow">Motivo <input type="text" [(ngModel)]="reason" placeholder="recarga manual" /></label>
            <button class="btn primary" (click)="allocate()" [disabled]="busy() || !(amount >= 0)">Aplicar</button>
            <button class="btn ghost" (click)="reset()" [disabled]="busy() || !quota()" title="Reinicia el periodo: usadas=0, restantes=asignadas">Reiniciar periodo</button>
          </div>

          <!-- Ledger -->
          <h3>Historial (audit)</h3>
          <table class="ledger" *ngIf="ledger().length">
            <tr><th>Fecha</th><th>Tipo</th><th>Monto</th><th>Saldo</th><th>Por</th><th>Motivo</th></tr>
            <tr *ngFor="let l of ledger(); trackBy: trackLed">
              <td>{{ l.at ? (l.at | date:'short') : '' }}</td>
              <td>{{ l.type }}</td>
              <td>{{ l.amount | number }}</td>
              <td>{{ l.balanceAfter | number }}</td>
              <td class="by">{{ l.by }}</td>
              <td>{{ l.reason }}</td>
            </tr>
          </table>
          <p class="note" *ngIf="!ledger().length">Sin movimientos.</p>

          <p class="note pay">Nota: el alta por pago (Stripe, etc.) no esta implementada; el alta manual es el camino activo. allocateQuota queda listo para que un webhook de pago lo invoque a futuro.</p>
        </main>

        <main class="detail empty" *ngIf="!selectedUid()">
          <p class="note">Elige un usuario para ver y asignar su cuota.</p>
        </main>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; background: #0e0f13; color: #e8e9ee; min-height: 100vh; }
    .wrap { max-width: 1040px; margin: 0 auto; padding: 22px 20px 60px; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 22px; }
    h2 { font-size: 15px; margin: 0 0 8px; }
    h3 { font-size: 13px; color: #b9b0e8; margin: 16px 0 6px; }
    .sub { color: #8b92a3; font-size: 12.5px; max-width: 680px; margin: 4px 0 0; }
    .tlink { color: #cbb8f8; text-decoration: none; font-size: 13px; white-space: nowrap; }
    .err { color: #f0a6a6; font-size: 13px; }
    .cols { display: grid; grid-template-columns: 260px 1fr; gap: 16px; margin-top: 16px; }
    .users { background: #15161c; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 10px; height: fit-content; }
    .lbl { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #6b7384; margin: 4px 6px 8px; }
    .urow { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; cursor: pointer; padding: 7px 9px; border-radius: 9px; background: transparent; border: 1px solid transparent; color: #e8e9ee; }
    .urow:hover { background: rgba(255,255,255,.04); }
    .urow.sel { background: rgba(139,92,246,.16); border-color: rgba(139,92,246,.4); }
    .uemail { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .urole { font-size: 10.5px; color: #8b92a3; }
    .detail { background: #15161c; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 16px; }
    .detail.empty { display: grid; place-items: center; min-height: 160px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
    .kpi { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; }
    .kpi span { font-size: 11px; color: #8b92a3; }
    .kpi b { font-size: 18px; }
    .kpi.zero b { color: #f0a6a6; }
    .alloc { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .alloc label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #b6bccb; }
    .alloc .grow { flex: 1; min-width: 160px; }
    .alloc input, .alloc select { background: #0e0f13; color: #e8e9ee; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 7px 9px; font-size: 12.5px; }
    .alloc input[type=number] { width: 120px; }
    .alloc .grow input { width: 100%; }
    .btn { padding: 8px 14px; border-radius: 9px; cursor: pointer; font-size: 12.5px; border: 1px solid rgba(139,92,246,.4); background: rgba(139,92,246,.18); color: #cbb8f8; }
    .btn.primary { background: #8b5cf6; border-color: #8b5cf6; color: #fff; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); color: #cdd2db; }
    .btn:disabled { opacity: .45; cursor: default; }
    table.ledger { width: 100%; border-collapse: collapse; font-size: 11.5px; }
    table.ledger th, table.ledger td { border: 1px solid rgba(255,255,255,.08); padding: 5px 8px; text-align: left; }
    table.ledger .by { color: #8b92a3; }
    .note { color: #8b92a3; font-size: 11.5px; }
    .note.pay { margin-top: 14px; color: #d9a441; }
    .spin { width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.25); border-top-color: #cbb8f8; border-radius: 50%; display: inline-block; animation: sp .8s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
  `]
})
export class CuotasComponent implements OnInit {
  private svc = inject(QuotaService);
  private roleSvc = inject(RoleAdminService);

  readonly users = signal<UserRow[]>([]);
  readonly selectedUid = signal<string>('');
  readonly selectedEmail = signal<string>('');
  readonly quota = signal<QuotaState | null>(null);
  readonly ledger = signal<QuotaLedgerRow[]>([]);
  readonly loadingUsers = signal(false);
  readonly loadingQuota = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  amount = 1000;
  mode: 'set' | 'add' = 'add';
  reason = '';

  trackLed = (_: number, l: QuotaLedgerRow) => l.at + ':' + l.type + ':' + l.amount;

  async ngOnInit(): Promise<void> {
    this.loadingUsers.set(true);
    try {
      this.users.set(await this.roleSvc.listUsers());
    } catch (e: any) {
      this.error.set('No se pudo cargar la lista de usuarios: ' + (e?.message ?? String(e)));
    } finally {
      this.loadingUsers.set(false);
    }
  }

  async select(u: UserRow): Promise<void> {
    this.selectedUid.set(u.uid);
    this.selectedEmail.set(u.email ?? '');
    await this.loadQuota();
  }

  private async loadQuota(): Promise<void> {
    const uid = this.selectedUid();
    if (!uid) return;
    this.loadingQuota.set(true);
    this.error.set('');
    try {
      const { quota, ledger } = await this.svc.getQuota(uid);
      this.quota.set(quota);
      this.ledger.set(ledger);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loadingQuota.set(false);
    }
  }

  async allocate(): Promise<void> {
    const uid = this.selectedUid();
    if (!uid || !(this.amount >= 0)) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.svc.allocateQuota(uid, Math.floor(this.amount), this.mode, this.reason.trim() || undefined);
      this.reason = '';
      await this.loadQuota();
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async reset(): Promise<void> {
    const uid = this.selectedUid();
    if (!uid) return;
    const ok = typeof window !== 'undefined' ? window.confirm('Reiniciar el periodo de cuota de este usuario?') : true;
    if (!ok) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.svc.resetQuotaPeriod(uid);
      await this.loadQuota();
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
