import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminService } from '../../services/admin.service';
import { RoleAdminService, UserRow } from '../../services/role-admin.service';
import { getFirebaseAuth } from '../../services/firebase-client';
import { environment } from '../../../environments/environment';

/**
 * Role Admin (/role-admin): grant/revoke the `admin` role from the UI.
 *
 * Gated by enforceAdminRole for ROUTE access (dev = any signed-in user), but the
 * underlying callables are ALWAYS admin-only server-side -- except
 * bootstrapFirstAdmin, which is the safe chicken-and-egg path to create the first
 * admin. If listing fails because the caller isn't admin yet, the bootstrap panel
 * is shown.
 */
@Component({
  selector: 'app-role-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="logo">RO</span> Role Admin</div>
        <nav class="topnav">
          <a routerLink="/admin">&larr; Admin</a>
          <a routerLink="/assistant-manager">Assistant Manager</a>
          <a routerLink="/llm-admin">LLM Admin</a>
        </nav>
      </header>

      <div class="body">
        <div class="denied" *ngIf="!allowed()">You do not have access to this panel.</div>

        <main class="content" *ngIf="allowed()">
          <h1 class="vtitle">Roles y permisos</h1>
          <p class="vsub">Otorga o revoca el rol <code>admin</code>. Los cambios requieren que el usuario
            actualice su token (cerrar e iniciar sesion, o esperar ~1 hora).</p>

          <!-- Bootstrap panel (only relevant before the first admin exists / not admin yet) -->
          <section class="card warn" *ngIf="!isAdmin()">
            <h3>Primer administrador</h3>
            <p class="hint">
              No tienes el rol admin todavia. Si aun no existe ningun admin (o tu correo esta en la
              lista de bootstrap del servidor), puedes auto-asignarte el primer admin una sola vez.
            </p>
            <div class="row">
              <button class="btn primary" (click)="bootstrap()" [disabled]="busy()">
                {{ busy() ? 'Procesando...' : 'Convertirme en el primer admin' }}
              </button>
            </div>
            <p class="ok" *ngIf="bootstrapMsg()">{{ bootstrapMsg() }}</p>
            <p class="err" *ngIf="bootstrapErr()">{{ bootstrapErr() }}</p>
          </section>

          <!-- Add by email -->
          <section class="card">
            <h3>Agregar por correo</h3>
            <div class="addrow">
              <input type="email" [(ngModel)]="addEmail" placeholder="correo@ejemplo.com" />
              <button class="btn" (click)="grantByEmail()" [disabled]="!addEmail.trim() || busy()">Otorgar admin</button>
            </div>
            <p class="err" *ngIf="addErr()">{{ addErr() }}</p>
          </section>

          <!-- User list -->
          <section class="card">
            <div class="card-head">
              <h3>Usuarios</h3>
              <div class="search">
                <input type="text" [(ngModel)]="filter" placeholder="Filtrar por correo..." />
              </div>
            </div>

            <div class="state" *ngIf="loading()"><span class="spin"></span> Cargando...</div>
            <p class="err" *ngIf="listErr()">{{ listErr() }}</p>

            <div class="empty" *ngIf="!loading() && !listErr() && !filtered().length">
              No hay usuarios en el registro todavia (se llena cuando inician sesion).
            </div>

            <table class="users" *ngIf="!loading() && filtered().length">
              <thead><tr><th>Correo</th><th>UID</th><th>Rol</th><th class="ar">Accion</th></tr></thead>
              <tbody>
                <tr *ngFor="let u of filtered()">
                  <td>{{ u.email || '(sin correo)' }}</td>
                  <td class="uid" [title]="u.uid">{{ u.uid }}</td>
                  <td><span class="pill" [class.admin]="u.role === 'admin'">{{ u.role }}</span></td>
                  <td class="ar">
                    <button class="btn sm" *ngIf="u.role !== 'admin'" (click)="setRole(u, 'admin')" [disabled]="busy()">Otorgar admin</button>
                    <button class="btn sm danger" *ngIf="u.role === 'admin'" (click)="setRole(u, 'user')" [disabled]="busy()">Revocar admin</button>
                  </td>
                </tr>
              </tbody>
            </table>

            <p class="note" *ngIf="actionMsg()">{{ actionMsg() }}</p>
          </section>
        </main>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; }
    * { box-sizing: border-box; }
    .shell { min-height: 100vh; display: flex; flex-direction: column; background: #0a0e14; color: #e6e8ee;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      --accent: #8b5cf6; --accent2: #a78bfa; --card: #121823; --line: rgba(255,255,255,.08); }
    .topbar { flex: none; height: 60px; display: flex; align-items: center; justify-content: space-between;
      padding: 0 22px; border-bottom: 1px solid var(--line); }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; }
    .logo { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px;
      background: rgba(139,92,246,.22); color: var(--accent2); font-size: 11px; font-weight: 700; }
    .topnav { display: flex; gap: 14px; font-size: 13.5px; }
    .topnav a { color: #c7ccd6; text-decoration: none; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); }
    .topnav a:hover { background: rgba(255,255,255,.05); color: #fff; }
    .body { flex: 1; display: flex; min-height: 0; }
    .denied { margin: auto; color: #ffb3b3; font-size: 15px; }
    .content { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 26px; max-width: 920px; margin: 0 auto; width: 100%; }
    .vtitle { margin: 0 0 4px; font-size: 26px; font-weight: 700; }
    .vsub { margin: 0 0 20px; font-size: 13.5px; color: #8b93a3; line-height: 1.55; }
    code { background: rgba(255,255,255,.06); padding: 1px 6px; border-radius: 6px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin-bottom: 18px; }
    .card.warn { border-color: rgba(240,198,116,.4); background: rgba(240,198,116,.06); }
    .card h3 { margin: 0 0 12px; font-size: 16px; font-weight: 700; }
    .hint { margin: 0 0 12px; font-size: 12.5px; color: #8b93a3; line-height: 1.5; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .addrow { display: flex; gap: 10px; flex-wrap: wrap; }
    .addrow input { flex: 1; min-width: 220px; }
    input { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid var(--line);
      border-radius: 9px; padding: 9px 11px; font-size: 13px; }
    input:focus { outline: none; border-color: rgba(139,92,246,.6); }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .search input { min-width: 220px; }
    table.users { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.users th { text-align: left; color: #6b7384; font-weight: 600; font-size: 11px; letter-spacing: .5px;
      text-transform: uppercase; padding: 8px 10px; border-bottom: 1px solid var(--line); }
    table.users th.ar, td.ar { text-align: right; }
    table.users td { padding: 11px 10px; border-bottom: 1px solid rgba(255,255,255,.05); vertical-align: middle; }
    .uid { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #8b93a3; max-width: 220px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill { font-size: 11px; padding: 3px 9px; border-radius: 999px; background: rgba(255,255,255,.08); color: #aeb4c0; }
    .pill.admin { background: rgba(139,92,246,.2); color: #cbb8f8; }
    .btn { padding: 8px 14px; border-radius: 9px; cursor: pointer; font-size: 12.5px;
      background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.sm { padding: 5px 11px; font-size: 11.5px; }
    .btn.danger { background: rgba(179,57,57,.2); border-color: rgba(179,57,57,.5); color: #ffb3b3; }
    .ok { color: #6ee7b7; font-size: 12.5px; margin: 10px 0 0; }
    .err { color: #fca5a5; font-size: 12.5px; margin: 8px 0 0; }
    .note { color: #f0c674; font-size: 12.5px; margin: 12px 0 0; }
    .empty { color: #8b93a3; font-size: 13px; padding: 10px 0; }
    .state { display: flex; align-items: center; gap: 8px; color: #8b93a3; font-size: 13px; padding: 10px 0; }
    .spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.15); border-top-color: var(--accent);
      border-radius: 50%; display: inline-block; animation: rospin 1s linear infinite; }
    @keyframes rospin { to { transform: rotate(360deg); } }
  `],
})
export class RoleAdminComponent implements OnInit {
  private admin = inject(AdminService);
  private svc = inject(RoleAdminService);

  users = signal<UserRow[]>([]);
  filter = '';
  addEmail = '';

  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly listErr = signal('');
  readonly addErr = signal('');
  readonly actionMsg = signal('');
  readonly bootstrapMsg = signal('');
  readonly bootstrapErr = signal('');

  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);
  readonly isAdmin = computed(() => this.admin.isAdmin() === true);

  readonly filtered = computed(() => {
    const q = this.filter.trim().toLowerCase();
    const list = this.users();
    return q ? list.filter((u) => (u.email || '').toLowerCase().includes(q) || u.uid.includes(q)) : list;
  });

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (this.allowed()) await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.listErr.set('');
    try {
      this.users.set(await this.svc.listUsers());
    } catch (e: any) {
      // Most common: caller isn't admin yet -> guide them to bootstrap.
      this.listErr.set((e?.message ?? String(e)) + ' — si aun no eres admin, usa el panel de arriba.');
    } finally {
      this.loading.set(false);
    }
  }

  async setRole(u: UserRow, role: 'admin' | 'user'): Promise<void> {
    this.busy.set(true);
    this.actionMsg.set('');
    try {
      const res = await this.svc.setUserRole({ uid: u.uid }, role);
      this.users.update((list) => list.map((x) => (x.uid === u.uid ? { ...x, role } : x)));
      this.actionMsg.set(res.note);
      await this.admin.check(true);
    } catch (e: any) {
      this.actionMsg.set('');
      this.listErr.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async grantByEmail(): Promise<void> {
    const email = this.addEmail.trim();
    if (!email) return;
    this.busy.set(true);
    this.addErr.set('');
    this.actionMsg.set('');
    try {
      const res = await this.svc.setUserRole({ email }, 'admin');
      this.actionMsg.set(res.note);
      this.addEmail = '';
      await this.refresh();
    } catch (e: any) {
      this.addErr.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async bootstrap(): Promise<void> {
    this.busy.set(true);
    this.bootstrapMsg.set('');
    this.bootstrapErr.set('');
    try {
      const res = await this.svc.bootstrapFirstAdmin();
      this.bootstrapMsg.set(res.note + ' Cierra e inicia sesion para activar el rol, luego recarga.');
      await this.admin.check(true);
      await this.refresh();
    } catch (e: any) {
      this.bootstrapErr.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
