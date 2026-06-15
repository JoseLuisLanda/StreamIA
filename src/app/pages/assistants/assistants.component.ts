import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { AssistantConfig } from '../../lib/rag/rag.models';

/**
 * Assistant selector landing (`/assistants`).
 *
 * Lists "assistants" = AssistantConfig docs from Firestore `assistants/*`
 * (with a static fallback). Selecting one navigates to
 * `/text-avatar?assistant={id}`, where Text-Avatar loads the config and turns
 * RAG mode on. Persona (systemPrompt) + ragCollection are applied server-side by
 * the chatRag Function from the assistantId.
 */
@Component({
  selector: 'app-assistants',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="wrap">
      <header class="bar">
        <div class="brand"><span class="logo">A</span> Aetheris AI</div>
      </header>

      <main class="main">
        <h1 class="title">Selecciona tu asistente</h1>
        <p class="sub">Elige con quien quieres conversar y comienza a optimizar tus flujos con IA especializada.</p>

        <!-- loading: shimmer skeletons -->
        <div class="grid" *ngIf="loading()">
          <div class="card skel" *ngFor="let s of [1,2,3,4,5,6]">
            <div class="sk-thumb"></div><div class="sk-line w60"></div>
            <div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-btn"></div>
          </div>
        </div>

        <!-- empty -->
        <div class="empty" *ngIf="!loading() && !assistants().length">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.4">
              <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/>
            </svg>
          </div>
          <h2>No hay asistentes disponibles todavia</h2>
          <p>Crea un assistant en Firestore (coleccion <code>assistants</code>) para que aparezca aqui.</p>
        </div>

        <!-- cards -->
        <div class="grid" *ngIf="!loading() && assistants().length">
          <button class="card" *ngFor="let a of assistants()" (click)="select(a)"
                  [attr.aria-label]="'Conversar con ' + (a.name || a.id)">
            <div class="portrait">
              <img *ngIf="thumbUrl(a)" [src]="thumbUrl(a)!" [alt]="a.name || a.id" />
              <span *ngIf="!thumbUrl(a)" class="portrait-ph">
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.4">
                  <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/>
                </svg>
              </span>
            </div>
            <div class="name">{{ a.name || a.id }}</div>
            <div class="role" *ngIf="a.role">{{ a.role }}</div>
            <div class="desc" *ngIf="a.description">{{ a.description }}</div>
            <div class="chips">
              <span class="chip" *ngIf="a.topicTag">#{{ a.topicTag }}</span>
              <span class="chip" *ngIf="a.language">#{{ a.language | uppercase }}</span>
            </div>
            <span class="cta">Conversar</span>
          </button>
        </div>

        <p class="err" *ngIf="svc.error() && !loading() && !assistants().length">{{ svc.error() }}</p>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; }
    * { box-sizing: border-box; }
    .wrap { min-height: 100vh; background: #0a0e14; color: #e6e8ee;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; --accent: #8b5cf6; }
    .bar { height: 60px; display: flex; align-items: center; padding: 0 24px; border-bottom: 1px solid rgba(255,255,255,.07); }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 17px; }
    .logo { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px;
      background: rgba(139,92,246,.22); color: #c4b0f7; font-weight: 700; }

    .main { max-width: 1180px; margin: 0 auto; padding: 40px 24px 64px; }
    .title { text-align: center; font-size: 40px; font-weight: 800; margin: 0 0 10px; }
    .sub { text-align: center; color: #8b93a3; font-size: 15px; max-width: 620px; margin: 0 auto 36px; line-height: 1.5; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 22px; }

    .card { text-align: center; cursor: pointer; display: flex; flex-direction: column; align-items: center;
      gap: 8px; padding: 26px 22px; border-radius: 16px; color: inherit;
      background: #121823; border: 1px solid rgba(255,255,255,.08);
      transition: transform .15s, box-shadow .15s, border-color .15s; }
    .card:hover { transform: translateY(-4px); border-color: rgba(139,92,246,.5);
      box-shadow: 0 14px 40px rgba(139,92,246,.22); }
    .portrait { width: 104px; height: 104px; border-radius: 50%; margin-bottom: 6px; overflow: hidden;
      display: grid; place-items: center; border: 2px solid rgba(139,92,246,.5);
      background: radial-gradient(circle at 50% 30%, rgba(139,92,246,.4), rgba(139,92,246,.05)); }
    .portrait img { width: 100%; height: 100%; object-fit: cover; }
    .portrait-ph { color: #c4b0f7; opacity: .85; }
    .name { font-size: 20px; font-weight: 700; }
    .role { font-size: 12px; padding: 3px 12px; border-radius: 999px; color: #c4b0f7;
      background: rgba(139,92,246,.16); border: 1px solid rgba(139,92,246,.35); }
    .desc { font-size: 13.5px; color: #9aa2b1; line-height: 1.5; margin: 4px 0; min-height: 40px; }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-bottom: 4px; }
    .chip { font-size: 11px; color: #8b93a3; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1);
      border-radius: 7px; padding: 3px 9px; font-family: ui-monospace, Menlo, monospace; }
    .cta { margin-top: 8px; width: 100%; padding: 11px 0; border-radius: 10px; font-weight: 700; font-size: 14px;
      background: var(--accent); color: #fff; transition: background .15s; }
    .card:hover .cta { background: #7c4ff0; }

    /* skeleton */
    .card.skel { pointer-events: none; }
    .sk-thumb, .sk-line, .sk-btn { background: linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.1), rgba(255,255,255,.05));
      background-size: 200% 100%; animation: shimmer 1.3s infinite; border-radius: 8px; }
    .sk-thumb { width: 104px; height: 104px; border-radius: 50%; }
    .sk-line { height: 12px; width: 80%; } .sk-line.w60 { width: 60%; } .sk-line.w40 { width: 40%; }
    .sk-btn { height: 38px; width: 100%; margin-top: 8px; border-radius: 10px; }
    @keyframes shimmer { to { background-position: -200% 0; } }

    .empty { text-align: center; margin: 80px auto 0; max-width: 460px; }
    .empty-icon { width: 64px; height: 64px; margin: 0 auto 14px; display: grid; place-items: center;
      border-radius: 16px; background: rgba(255,255,255,.04); color: #6b7384; }
    .empty h2 { font-size: 20px; margin: 0 0 8px; }
    .empty p { color: #8b93a3; font-size: 14px; line-height: 1.5; }
    code { background: rgba(255,255,255,.08); padding: 1px 6px; border-radius: 5px; font-size: 12px; }
    .err { text-align: center; color: #ff9c9c; font-size: 12.5px; margin-top: 16px; }
  `]
})
export class AssistantsComponent implements OnInit {
  svc = inject(AssistantConfigService);
  private router = inject(Router);

  readonly assistants = signal<AssistantConfig[]>([]);
  readonly loading = signal(true);
  private thumbs = signal<Record<string, string | null>>({});

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await this.svc.listAssistants();
      this.assistants.set(list);
      // Resolve card pictures from avatars/avatar_preview (matched by avatarId/id/
      // name), falling back to an explicit thumbnail, else the avatar-icon.
      for (const a of list) {
        this.svc.resolveCardThumbnail(a)
          .then((url) => this.thumbs.update((m) => ({ ...m, [a.id]: url })))
          .catch(() => {});
      }
    } finally {
      this.loading.set(false);
    }
  }

  thumbUrl(a: AssistantConfig): string | null {
    return this.thumbs()[a.id] ?? null;
  }

  select(a: AssistantConfig): void {
    this.router.navigate(['/text-avatar'], { queryParams: { assistant: a.id } });
  }
}