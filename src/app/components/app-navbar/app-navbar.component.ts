import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { AdminService } from '../../services/admin.service';
import { NAV_CATEGORIES, NavCategory, NavItem, buildAdminCategory } from '../../lib/nav/nav.model';

/**
 * GLOBAL smart navbar -- mounted ONCE in AppComponent, available on every route.
 *
 * Smart behaviors (signals, zoneless):
 *  - Identity filtering: guests see public items; signed-in users see auth
 *    items; admins additionally see the Administracion category (derived from
 *    ADMIN_MODULES). User chip + login/logout live here.
 *  - Route awareness: presentation mode comes from route data `nav`:
 *      'fixed'   (default) glass top bar occupying layout space
 *      'overlay' immersive routes (viewer/text-avatar/live/AR): NO bar; a
 *                discreet floating button (top-left) opens the drawer without
 *                interrupting camera/TTS/tracking (CSS-only open/close)
 *      'hidden'  nothing at all (login)
 *  - Active route highlighting, drawer with category accordion + QUICK SEARCH
 *    filter over the whole registry.
 */
@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RouterLinkActive],
  template: `
    <!-- ============ FIXED BAR ============ -->
    <header class="bar" *ngIf="mode() === 'fixed'">
      <a routerLink="/" class="brand"><span class="logo">AS</span> Avatar Studio</a>

      <nav class="cats">
        <div class="cat" *ngFor="let c of categories()">
          <button class="catbtn" (click)="toggleCat(c.id)" [class.open]="openCat() === c.id">
            {{ c.label }}
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          <div class="dropdown" *ngIf="openCat() === c.id">
            <a class="ditem" *ngFor="let it of c.items" [routerLink]="it.route" routerLinkActive="active" (click)="closeAll()">
              <span class="ic"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="it.icon"/></svg></span>
              <span class="dtxt"><b>{{ it.label }}</b><i *ngIf="it.description">{{ it.description }}</i></span>
            </a>
          </div>
        </div>
      </nav>

      <div class="right">
        <span class="userpill" *ngIf="auth.user() as u">{{ u.email }}</span>
        <a class="abtn" *ngIf="!auth.user()" routerLink="/login">Login</a>
        <button class="abtn ghost" *ngIf="auth.user()" (click)="logout()">Salir</button>
        <button class="burger" (click)="drawerOpen.set(true)" title="Menu">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18 M3 12h18 M3 18h18"/></svg>
        </button>
      </div>
    </header>

    <!-- ============ OVERLAY FAB (immersive routes) ============ -->
    <button class="fab" *ngIf="mode() === 'overlay'" (click)="drawerOpen.set(true)" title="Menu">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18 M3 12h18 M3 18h18"/></svg>
    </button>

    <!-- ============ DRAWER (mobile + overlay mode) ============ -->
    <div class="scrim" *ngIf="drawerOpen()" (click)="drawerOpen.set(false)"></div>
    <aside class="drawer" [class.open]="drawerOpen()">
      <div class="dhead">
        <span class="brand"><span class="logo">AS</span> Avatar Studio</span>
        <button class="x" (click)="drawerOpen.set(false)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12 M18 6L6 18"/></svg>
        </button>
      </div>

      <input class="search" type="text" [ngModel]="query()" (ngModelChange)="query.set($event)"
             placeholder="Buscar seccion... (ej. cuotas, marcador)" />

      <div class="dbody">
        <ng-container *ngIf="query().trim(); else grouped">
          <a class="ditem" *ngFor="let it of searchResults()" [routerLink]="it.route" routerLinkActive="active" (click)="closeAll()">
            <span class="ic"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="it.icon"/></svg></span>
            <span class="dtxt"><b>{{ it.label }}</b><i *ngIf="it.description">{{ it.description }}</i></span>
          </a>
          <p class="none" *ngIf="!searchResults().length">Sin resultados.</p>
        </ng-container>

        <ng-template #grouped>
          <div class="group" *ngFor="let c of categories()">
            <button class="ghead" (click)="toggleAcc(c.id)">
              {{ c.label }}
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"
                   [style.transform]="acc() === c.id ? 'rotate(180deg)' : ''"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="gitems" *ngIf="acc() === c.id">
              <a class="ditem" *ngFor="let it of c.items" [routerLink]="it.route" routerLinkActive="active" (click)="closeAll()">
                <span class="ic"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="it.icon"/></svg></span>
                <span class="dtxt"><b>{{ it.label }}</b><i *ngIf="it.description">{{ it.description }}</i></span>
              </a>
            </div>
          </div>
        </ng-template>
      </div>

      <div class="dfoot">
        <span class="userpill" *ngIf="auth.user() as u">{{ u.email }}</span>
        <a class="abtn" *ngIf="!auth.user()" routerLink="/login" (click)="closeAll()">Login</a>
        <button class="abtn ghost" *ngIf="auth.user()" (click)="logout()">Cerrar sesion</button>
      </div>
    </aside>
  `,
  styles: [`
    :host { display: block; font-family: 'Segoe UI', system-ui, sans-serif; --accent: #8b5cf6; }
    .bar { position: sticky; top: 0; z-index: 900; height: 52px; display: flex; align-items: center; gap: 14px;
      padding: 0 16px; background: rgba(10,14,20,.72); backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(255,255,255,.08); color: #e6e8ee; }
    .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14.5px; color: #e6e8ee; text-decoration: none; white-space: nowrap; }
    .logo { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px;
      background: rgba(139,92,246,.25); color: #c4b0f7; font-size: 10.5px; font-weight: 700; }
    .cats { display: flex; align-items: center; gap: 2px; flex: 1; }
    .cat { position: relative; }
    .catbtn { display: flex; align-items: center; gap: 5px; padding: 7px 12px; border-radius: 9px; font-size: 13px;
      background: transparent; border: 1px solid transparent; color: #c7ccd6; cursor: pointer; }
    .catbtn:hover, .catbtn.open { background: rgba(255,255,255,.07); color: #fff; border-color: rgba(255,255,255,.1); }
    .dropdown { position: absolute; top: calc(100% + 6px); left: 0; min-width: 270px; z-index: 901;
      background: rgba(14,18,26,.97); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,.12);
      border-radius: 14px; padding: 6px; display: flex; flex-direction: column; gap: 2px;
      box-shadow: 0 12px 34px rgba(0,0,0,.5); }
    .ditem { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px;
      color: #d5d9e2; text-decoration: none; }
    .ditem:hover { background: rgba(139,92,246,.14); }
    .ditem.active { background: rgba(139,92,246,.22); color: #fff; }
    .ic { width: 30px; height: 30px; flex: none; display: grid; place-items: center; border-radius: 8px;
      background: rgba(139,92,246,.14); color: #b9a3f5; }
    .dtxt { display: flex; flex-direction: column; min-width: 0; }
    .dtxt b { font-size: 13px; font-weight: 600; }
    .dtxt i { font-size: 11px; font-style: normal; color: #8b93a3; }
    .right { display: flex; align-items: center; gap: 8px; }
    .userpill { font-size: 11.5px; color: #aab; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .abtn { padding: 6px 13px; border-radius: 9px; font-size: 12.5px; cursor: pointer; text-decoration: none;
      background: var(--accent); border: 1px solid var(--accent); color: #fff; }
    .abtn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.14); color: #cdd; }
    .burger { display: none; width: 34px; height: 34px; border-radius: 9px; cursor: pointer;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); color: #e6e8ee; place-items: center; }
    .fab { position: fixed; top: max(10px, env(safe-area-inset-top)); left: 10px; z-index: 950;
      width: 40px; height: 40px; border-radius: 12px; cursor: pointer; display: grid; place-items: center;
      background: rgba(10,14,20,.55); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.22); color: #e6e8ee; }
    .scrim { position: fixed; inset: 0; z-index: 990; background: rgba(0,0,0,.45); }
    .drawer { position: fixed; top: 0; bottom: 0; left: 0; width: min(320px, 86vw); z-index: 991;
      background: rgba(12,16,24,.98); border-right: 1px solid rgba(255,255,255,.1); color: #e6e8ee;
      transform: translateX(-102%); transition: transform .25s ease; display: flex; flex-direction: column; }
    .drawer.open { transform: translateX(0); }
    .dhead { display: flex; align-items: center; justify-content: space-between; padding: 14px 14px 8px; }
    .x { width: 30px; height: 30px; border-radius: 8px; cursor: pointer; display: grid; place-items: center;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: #cdd; }
    .search { margin: 4px 14px 10px; padding: 9px 12px; border-radius: 10px; font-size: 13px;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); color: #e6e8ee; }
    .dbody { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 4px; }
    .group { display: flex; flex-direction: column; }
    .ghead { display: flex; align-items: center; justify-content: space-between; padding: 10px 10px; border-radius: 10px;
      background: transparent; border: none; color: #9aa3b5; font-size: 11.5px; font-weight: 700; letter-spacing: 1px;
      text-transform: uppercase; cursor: pointer; }
    .ghead:hover { color: #fff; }
    .ghead svg { transition: transform .15s; }
    .gitems { display: flex; flex-direction: column; gap: 2px; padding: 0 2px 6px; }
    .none { color: #8b93a3; font-size: 12.5px; padding: 8px 12px; }
    .dfoot { padding: 12px 14px; border-top: 1px solid rgba(255,255,255,.08); display: flex; align-items: center; gap: 10px; justify-content: space-between; }
    @media (max-width: 880px) { .cats { display: none; } .burger { display: grid; } }
  `],
})
export class AppNavbarComponent implements OnInit {
  readonly auth = inject(AuthService);
  private admin = inject(AdminService);
  private router = inject(Router);

  readonly mode = signal<'fixed' | 'overlay' | 'hidden'>('fixed');
  readonly openCat = signal<string | null>(null);
  readonly drawerOpen = signal(false);
  readonly acc = signal<string | null>('experiencias');
  readonly query = signal('');

  /** Categories filtered by identity (public/auth/admin). */
  readonly categories = computed<NavCategory[]>(() => {
    const signedIn = !!this.auth.user();
    const isAdmin = this.admin.isAdmin() === true;
    const base = NAV_CATEGORIES.map((c) => ({
      ...c,
      items: c.items.filter((it) => it.requires === 'public' || (it.requires === 'auth' && signedIn) || (it.requires === 'admin' && isAdmin)),
    })).filter((c) => c.items.length > 0);
    if (isAdmin) base.push(buildAdminCategory());
    return base;
  });

  readonly searchResults = computed<NavItem[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return [];
    return this.categories()
      .flatMap((c) => c.items)
      .filter((it) => (it.label + ' ' + (it.description ?? '')).toLowerCase().includes(q));
  });

  constructor() {
    // Resolve admin status whenever the signed-in user changes (cached per uid).
    effect(() => {
      if (this.auth.user()) void this.admin.check();
    });
  }

  ngOnInit(): void {
    this.applyMode();
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) {
        this.applyMode();
        this.closeAll();
      }
    });
  }

  /** Read the deepest route's data.nav (default 'fixed'). */
  private applyMode(): void {
    let r = this.router.routerState.snapshot.root;
    let nav: string | undefined;
    while (r) {
      if (r.data && r.data['nav']) nav = r.data['nav'];
      if (!r.firstChild) break;
      r = r.firstChild;
    }
    this.mode.set(nav === 'overlay' || nav === 'hidden' ? nav : 'fixed');
  }

  toggleCat(id: string): void {
    this.openCat.update((cur) => (cur === id ? null : id));
  }

  toggleAcc(id: string): void {
    this.acc.update((cur) => (cur === id ? null : id));
  }

  closeAll(): void {
    this.openCat.set(null);
    this.drawerOpen.set(false);
    this.query.set('');
  }

  async logout(): Promise<void> {
    this.closeAll();
    await this.auth.logout?.();
    void this.router.navigate(['/home']);
  }
}
