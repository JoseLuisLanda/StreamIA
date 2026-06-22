import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AdminService } from '../../services/admin.service';
import { environment } from '../../../environments/environment';

/** One admin module card. Add a module = add ONE entry to ADMIN_MODULES. */
interface AdminModule {
  title: string;
  route: string;
  description: string;
  /** inline SVG path data (24x24 viewBox, stroked). */
  icon: string;
}

/**
 * Data-driven module list. Adding a future admin module is a single entry here.
 */
export const ADMIN_MODULES: AdminModule[] = [
  {
    title: 'Avatar Manager',
    route: '/avatar-manager',
    description: 'Gestiona los modelos 3D reutilizables (GLB, thumbnail, voz).',
    icon: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  },
  {
    title: 'Assistant Manager',
    route: '/assistant-manager',
    description: 'Configura asistentes: avatar + RAG + persona + voz.',
    icon: 'M12 8a4 4 0 1 0 0-0.01 M4 20c0-4 3.6-6 8-6s8 2 8 6',
  },
  {
    title: 'RAG Admin',
    route: '/rag-admin',
    description: 'Sube e ingiere documentos y media por asistente.',
    icon: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5',
  },
  {
    title: 'LLM Admin',
    route: '/llm-admin',
    description: 'Configura proveedor, modelo y credenciales del LLM.',
    icon: 'M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  },
  {
    title: 'Role Admin',
    route: '/role-admin',
    description: 'Otorga o revoca el rol admin de los usuarios.',
    icon: 'M16 11a4 4 0 1 0 0-0.01 M8 14c-3 0-5 1.6-5 4 M14 19l2 2 4-4',
  },
  {
    title: 'LLM Responses',
    route: '/llm-responses',
    description: 'Respuestas globales + por asistente (saludos, despedidas, sugerencias) con IA.',
    icon: 'M4 5h16v10H7l-3 3z M8 9h8 M8 12h5',
  },
  {
    title: 'Costos',
    route: '/costos',
    description: 'Modelo de costos: tarifas, uso real por asistente y proyeccion mensual (aproximado).',
    icon: 'M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  },
  {
    title: 'Cuotas',
    route: '/cuotas',
    description: 'Cuota de consultas por cuenta: asignar, recargar y ver consumo (ledger).',
    icon: 'M3 3v18h18 M7 14l4-4 3 3 5-6',
  },
];

/**
 * Admin Hub (/admin): central landing that links to every admin module.
 * Gated by the existing enforceAdminRole flag (dev = any signed-in user, prod =
 * admin). Cards are data-driven from ADMIN_MODULES. Additive only -- no module
 * functionality changes.
 */
@Component({
  selector: 'app-admin-hub',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="logo">AH</span> Admin Hub</div>
        <nav class="topnav">
          <a routerLink="/home">Home</a>
          <a routerLink="/assistants">Assistants</a>
          <a routerLink="/text-avatar">Text-Avatar</a>
        </nav>
      </header>

      <div class="body">
        <div class="denied" *ngIf="!allowed()">You do not have admin access to this panel.</div>

        <main class="content" *ngIf="allowed()">
          <h1 class="vtitle">Panel de administracion</h1>
          <p class="vsub">Accede a todos los modulos de gestion desde un solo lugar.</p>

          <div class="grid">
            <a class="card" *ngFor="let m of modules" [routerLink]="m.route">
              <span class="ic">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6"
                     stroke-linecap="round" stroke-linejoin="round">
                  <path [attr.d]="m.icon"></path>
                </svg>
              </span>
              <span class="ctitle">{{ m.title }}</span>
              <span class="cdesc">{{ m.description }}</span>
              <span class="go">Abrir &rarr;</span>
            </a>
          </div>
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
    .content { flex: 1; min-width: 0; overflow-y: auto; padding: 28px 26px; max-width: 1040px; margin: 0 auto; width: 100%; }
    .vtitle { margin: 0 0 4px; font-size: 26px; font-weight: 700; }
    .vsub { margin: 0 0 24px; font-size: 13.5px; color: #8b93a3; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; }
    .card { display: flex; flex-direction: column; gap: 8px; text-decoration: none; color: inherit;
      background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px 20px 18px;
      transition: border-color .15s, transform .15s, background .15s; }
    .card:hover { border-color: rgba(139,92,246,.5); background: #151b28; transform: translateY(-2px); }
    .ic { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 12px;
      background: rgba(139,92,246,.16); color: var(--accent2); margin-bottom: 6px; }
    .ctitle { font-size: 16px; font-weight: 700; }
    .cdesc { font-size: 12.8px; color: #8b93a3; line-height: 1.5; flex: 1; }
    .go { font-size: 12.5px; color: var(--accent2); font-weight: 600; margin-top: 4px; }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  `],
})
export class AdminHubComponent implements OnInit {
  private admin = inject(AdminService);
  readonly modules = ADMIN_MODULES;
  readonly checked = signal(false);
  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    this.checked.set(true);
  }
}
