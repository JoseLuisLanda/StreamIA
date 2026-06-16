import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { httpsCallable } from 'firebase/functions';
import { AdminService } from '../../services/admin.service';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { ConversationContentService, phraseWarnings } from '../../services/conversation-content.service';
import { getFirebaseFunctionsClient } from '../../services/firebase-client';
import { AssistantConfig } from '../../lib/rag/rag.models';
import {
  ConvKind,
  GlobalResponses,
  PhraseEntry,
  SuggestedPrompt,
  UseCustomResponses,
} from '../../lib/conversation-content/conv-content.models';
import { environment } from '../../../environments/environment';

type PhraseKind = 'greetings' | 'infoAcknowledgements' | 'farewells';

/**
 * /llm-responses -- admin manager for conversational content. Two tabs:
 *   - Global: CRUD the editable global default responses (config/responses).
 *   - Por asistente: per-category override CRUD + revert-to-global + a global/
 *     custom indicator, driven by the assistant's useCustomResponses flags.
 * Both tabs offer on-demand "Generar con IA" (drafts -> review -> save).
 */
@Component({
  selector: 'app-llm-responses',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="logo">RS</span> LLM Responses</div>
        <nav class="topnav">
          <a routerLink="/admin">&larr; Admin</a>
          <a routerLink="/assistant-manager">Assistant Manager</a>
          <a routerLink="/llm-admin">LLM Admin</a>
        </nav>
      </header>

      <div class="body">
        <div class="denied" *ngIf="!allowed()">You do not have admin access to this panel.</div>

        <main class="content" *ngIf="allowed()">
          <div class="tabs">
            <button [class.on]="tab()==='global'" (click)="tab.set('global')">Global (por defecto)</button>
            <button [class.on]="tab()==='assistant'" (click)="tab.set('assistant')">Por asistente</button>
          </div>

          <!-- ============ GLOBAL ============ -->
          <section *ngIf="tab()==='global'">
            <div class="cathead">
              <h1 class="vtitle">Respuestas globales</h1>
              <button class="btn sm" (click)="runBackfill()" [disabled]="migrating()" title="Normaliza asistentes antiguos (agrega banderas faltantes)">{{ migrating() ? 'Migrando...' : 'Normalizar asistentes' }}</button>
            </div>
            <p class="vsub">Las heredan todos los asistentes cuya bandera de categoria sea "global". 8-18 palabras por frase.</p>
            <p class="ok" *ngIf="migrateMsg()">{{ migrateMsg() }}</p>
            <div class="state" *ngIf="gLoading()"><span class="spin"></span> Cargando...</div>

            <div *ngIf="!gLoading()">
              <div class="cat" *ngFor="let k of phraseKinds">
                <div class="cathead"><h3>{{ titles[k] }}</h3>
                  <span class="genwrap">
                    <button class="btn sm" (click)="genGlobalPhrases(k)" [disabled]="genBusy()">Generar con IA</button>
                    <button class="btn sm primary" (click)="saveGlobalPhrases(k)" [disabled]="gSaving()">Guardar</button>
                  </span>
                </div>
                <div class="row" *ngFor="let p of gPhrases[k]; let i = index">
                  <input class="t" [(ngModel)]="p.text" />
                  <span class="warn" *ngFor="let w of warns(p.text)">{{ w }}</span>
                  <button class="ix danger" (click)="gPhrases[k].splice(i,1)">✕</button>
                </div>
                <button class="btn ghost xs" (click)="gPhrases[k].push({ text: '' })">+ Añadir</button>
              </div>

              <div class="cat">
                <div class="cathead"><h3>{{ titles['suggestedPrompts'] }}</h3>
                  <span class="genwrap">
                    <button class="btn sm" (click)="genGlobalPrompts()" [disabled]="genBusy()">Generar con IA</button>
                    <button class="btn sm primary" (click)="saveGlobalPrompts()" [disabled]="gSaving()">Guardar</button>
                  </span>
                </div>
                <div class="row" *ngFor="let p of gPromptList; let i = index">
                  <input class="t sm" [(ngModel)]="p.label" placeholder="Etiqueta" />
                  <input class="t" [(ngModel)]="p.prompt" placeholder="Prompt" />
                  <button class="ix danger" (click)="gPromptList.splice(i,1)">✕</button>
                </div>
                <button class="btn ghost xs" (click)="gPromptList.push({ label: '', prompt: '' })">+ Añadir</button>
              </div>
              <p class="ok" *ngIf="gMsg()">{{ gMsg() }}</p>
              <p class="err" *ngIf="gErr()">{{ gErr() }}</p>
            </div>
          </section>

          <!-- ============ PER-ASSISTANT ============ -->
          <section *ngIf="tab()==='assistant'">
            <h1 class="vtitle">Respuestas por asistente</h1>
            <label class="fld"><span>Asistente</span>
              <select [(ngModel)]="selId" (ngModelChange)="onSelectAssistant()">
                <option value="">- selecciona -</option>
                <option *ngFor="let a of assistants()" [value]="a.id">{{ a.name }} ({{ a.id }})</option>
              </select>
            </label>

            <div class="state" *ngIf="aLoading()"><span class="spin"></span> Cargando...</div>

            <div *ngIf="selId && !aLoading()">
              <div class="cat" *ngFor="let k of phraseKinds">
                <div class="cathead">
                  <h3>{{ titles[k] }} <span class="badge" [class.custom]="flags()[k]">{{ flags()[k] ? 'Custom' : 'Global' }}</span></h3>
                  <span class="genwrap">
                    <button class="btn sm" (click)="genAsstPhrases(k)" [disabled]="genBusy()">Generar con IA</button>
                    <button class="btn sm" *ngIf="flags()[k]" (click)="revert(k)">Revertir a global</button>
                  </span>
                </div>
                <!-- drafts review -->
                <div *ngIf="draftPhrases[k]?.length">
                  <p class="hint">Borradores (revisa y acepta):</p>
                  <div class="row" *ngFor="let t of draftPhrases[k]; let i = index">
                    <input class="t" [(ngModel)]="draftPhrases[k][i]" />
                    <button class="ix danger" (click)="draftPhrases[k].splice(i,1)">✕</button>
                  </div>
                  <button class="btn sm primary" (click)="acceptPhrases(k)">Aceptar y guardar</button>
                  <button class="btn ghost sm" (click)="draftPhrases[k]=[]">Descartar</button>
                </div>
                <!-- current (read-only summary) -->
                <p class="cur" *ngIf="!draftPhrases[k]?.length">{{ summaryPhrases(k) }}</p>
              </div>

              <div class="cat">
                <div class="cathead">
                  <h3>{{ titles['suggestedPrompts'] }} <span class="badge" [class.custom]="flags().suggestedPrompts">{{ flags().suggestedPrompts ? 'Custom' : 'Global' }}</span></h3>
                  <span class="genwrap">
                    <button class="btn sm" (click)="genAsstPrompts()" [disabled]="genBusy()">Generar con IA</button>
                    <button class="btn sm" *ngIf="flags().suggestedPrompts" (click)="revert('suggestedPrompts')">Revertir a global</button>
                  </span>
                </div>
                <div *ngIf="draftPrompts.length">
                  <p class="hint">Borradores:</p>
                  <div class="row" *ngFor="let p of draftPrompts; let i = index">
                    <input class="t sm" [(ngModel)]="p.label" />
                    <input class="t" [(ngModel)]="p.prompt" />
                    <button class="ix danger" (click)="draftPrompts.splice(i,1)">✕</button>
                  </div>
                  <button class="btn sm primary" (click)="acceptPrompts()">Aceptar y guardar</button>
                  <button class="btn ghost sm" (click)="draftPrompts=[]">Descartar</button>
                </div>
              </div>
              <p class="ok" *ngIf="aMsg()">{{ aMsg() }}</p>
              <p class="err" *ngIf="aErr()">{{ aErr() }}</p>
            </div>
          </section>
        </main>
      </div>
    </div>
  `,
  styles: [`
    :host { display:block; min-height:100vh; } * { box-sizing:border-box; }
    .shell { min-height:100vh; display:flex; flex-direction:column; background:#0a0e14; color:#e6e8ee; font-family:'Segoe UI',system-ui,sans-serif; --accent:#8b5cf6; --line:rgba(255,255,255,.08); --card:#121823; }
    .topbar { height:60px; display:flex; align-items:center; justify-content:space-between; padding:0 22px; border-bottom:1px solid var(--line); }
    .brand { display:flex; align-items:center; gap:10px; font-size:17px; font-weight:700; }
    .logo { width:28px; height:28px; display:grid; place-items:center; border-radius:8px; background:rgba(139,92,246,.22); color:#a78bfa; font-size:11px; font-weight:700; }
    .topnav { display:flex; gap:14px; font-size:13.5px; } .topnav a { color:#c7ccd6; text-decoration:none; padding:6px 10px; border-radius:8px; border:1px solid var(--line); }
    .topnav a:hover { background:rgba(255,255,255,.05); color:#fff; }
    .body { flex:1; display:flex; min-height:0; } .denied { margin:auto; color:#ffb3b3; }
    .content { flex:1; overflow-y:auto; padding:22px 26px; max-width:900px; margin:0 auto; width:100%; }
    .tabs { display:flex; gap:8px; margin-bottom:16px; }
    .tabs button { background:rgba(255,255,255,.05); border:1px solid var(--line); color:#c7ccd6; border-radius:9px; padding:7px 14px; cursor:pointer; font-size:13px; }
    .tabs button.on { background:rgba(139,92,246,.22); border-color:rgba(139,92,246,.5); color:#fff; }
    .vtitle { margin:0 0 4px; font-size:23px; font-weight:700; } .vsub { margin:0 0 16px; font-size:13px; color:#8b93a3; }
    .cat { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:14px; }
    .cathead { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; gap:10px; flex-wrap:wrap; }
    .cathead h3 { margin:0; font-size:14.5px; display:flex; align-items:center; gap:8px; }
    .genwrap { display:flex; gap:6px; }
    .badge { font-size:10.5px; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.08); color:#aeb4c0; }
    .badge.custom { background:rgba(139,92,246,.2); color:#cbb8f8; }
    .row { display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap; }
    .t { flex:1; min-width:140px; background:rgba(255,255,255,.05); color:#e6e8ee; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:6px 9px; font-size:12.5px; }
    .t.sm { flex:0 0 140px; }
    .warn { font-size:10.5px; color:#f0c674; }
    .ix { width:26px; height:28px; border-radius:7px; cursor:pointer; background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.12); color:#aeb4c0; }
    .ix.danger:hover { background:rgba(179,57,57,.25); color:#ffb3b3; }
    .fld { display:flex; flex-direction:column; gap:5px; max-width:420px; margin-bottom:14px; font-size:12px; color:#aeb4c0; }
    .fld select { background:rgba(255,255,255,.05); color:#e6e8ee; border:1px solid rgba(255,255,255,.12); border-radius:9px; padding:8px 10px; font-size:13px; }
    .btn { padding:7px 13px; border-radius:8px; cursor:pointer; font-size:12.5px; background:rgba(139,92,246,.18); border:1px solid rgba(139,92,246,.4); color:#cbb8f8; }
    .btn:hover:not(:disabled) { background:rgba(139,92,246,.3); } .btn:disabled { opacity:.45; cursor:default; }
    .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    .btn.ghost { background:rgba(255,255,255,.06); border-color:var(--line); color:#cdd2db; }
    .btn.sm { padding:5px 10px; font-size:11.5px; } .btn.xs { padding:4px 9px; font-size:11px; }
    .hint { font-size:11.5px; color:#8b93a3; margin:6px 0; } .cur { font-size:12px; color:#8b93a3; margin:4px 0; }
    .ok { color:#6ee7b7; font-size:12.5px; } .err { color:#fca5a5; font-size:12.5px; }
    .state { display:flex; align-items:center; gap:8px; color:#8b93a3; margin:14px 0; }
    .spin { width:14px; height:14px; border:2px solid rgba(255,255,255,.15); border-top-color:var(--accent); border-radius:50%; display:inline-block; animation:rs 1s linear infinite; }
    @keyframes rs { to { transform:rotate(360deg); } }
  `],
})
export class LlmResponsesComponent implements OnInit {
  private admin = inject(AdminService);
  private asstSvc = inject(AssistantConfigService);
  private content = inject(ConversationContentService);

  readonly phraseKinds: PhraseKind[] = ['greetings', 'infoAcknowledgements', 'farewells'];
  readonly titles: Record<string, string> = {
    greetings: 'Saludos', infoAcknowledgements: 'Frases de espera', farewells: 'Despedidas', suggestedPrompts: 'Sugerencias',
  };
  readonly tab = signal<'global' | 'assistant'>('global');
  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  // global editing
  readonly gLoading = signal(true);
  readonly gSaving = signal(false);
  readonly gMsg = signal(''); readonly gErr = signal('');
  gPhrases: Record<PhraseKind, Array<{ text: string }>> = { greetings: [], infoAcknowledgements: [], farewells: [] };
  gPromptList: Array<{ label: string; prompt: string }> = [];

  // per-assistant
  readonly assistants = signal<AssistantConfig[]>([]);
  selId = '';
  readonly aLoading = signal(false);
  readonly aMsg = signal(''); readonly aErr = signal('');
  readonly flags = signal<UseCustomResponses>({ greetings: false, infoAcknowledgements: false, farewells: false, suggestedPrompts: false });
  private current: Record<PhraseKind, PhraseEntry[]> = { greetings: [], infoAcknowledgements: [], farewells: [] };
  private currentPrompts: SuggestedPrompt[] = [];
  draftPhrases: Record<PhraseKind, string[]> = { greetings: [], infoAcknowledgements: [], farewells: [] };
  draftPrompts: Array<{ label: string; prompt: string }> = [];
  readonly genBusy = signal(false);

  warns = phraseWarnings;
  readonly migrating = signal(false);
  readonly migrateMsg = signal('');

  /** One-time backfill of older assistant docs (also self-heal lazily on read). */
  async runBackfill(): Promise<void> {
    this.migrating.set(true); this.migrateMsg.set('');
    try {
      const fn = httpsCallable<unknown, { scanned: number; updated: number }>(getFirebaseFunctionsClient(), 'backfillAssistants');
      const r = (await fn({})).data;
      this.migrateMsg.set(`Listo: ${r.updated} de ${r.scanned} asistentes actualizados.`);
    } catch (e: any) {
      this.migrateMsg.set(`Error: ${e?.message ?? String(e)}`);
    } finally {
      this.migrating.set(false);
    }
  }

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (!this.allowed()) { this.gLoading.set(false); return; }
    await Promise.all([this.loadGlobal(), this.loadAssistants()]);
  }

  // ---- global ----
  private async loadGlobal(): Promise<void> {
    this.gLoading.set(true);
    try {
      await this.content.seedGlobals().catch(() => {});
      const g: GlobalResponses = await this.content.listGlobalForEdit();
      this.gPhrases = {
        greetings: g.greetings.map((p) => ({ text: p.text })),
        infoAcknowledgements: g.infoAcknowledgements.map((p) => ({ text: p.text })),
        farewells: g.farewells.map((p) => ({ text: p.text })),
      };
      this.gPromptList = g.suggestedPrompts.map((p) => ({ label: p.label, prompt: p.prompt }));
    } catch (e: any) { this.gErr.set(e?.message ?? String(e)); }
    finally { this.gLoading.set(false); }
  }

  async saveGlobalPhrases(k: PhraseKind): Promise<void> {
    this.gSaving.set(true); this.gErr.set(''); this.gMsg.set('');
    try {
      const items = this.gPhrases[k].filter((p) => p.text.trim()).map((p, i) => ({ id: `g-${k}-${i}`, text: p.text.trim(), order: i, enabled: true }));
      await this.content.saveGlobalCategory(k, items);
      this.gMsg.set('Guardado.');
    } catch (e: any) { this.gErr.set(e?.message ?? String(e)); }
    finally { this.gSaving.set(false); }
  }
  async saveGlobalPrompts(): Promise<void> {
    this.gSaving.set(true); this.gErr.set(''); this.gMsg.set('');
    try {
      const items = this.gPromptList.filter((p) => p.label.trim() && p.prompt.trim()).map((p, i) => ({ id: `g-sp-${i}`, label: p.label.trim(), prompt: p.prompt.trim(), order: i, enabled: true }));
      await this.content.saveGlobalCategory('suggestedPrompts', items);
      this.gMsg.set('Guardado.');
    } catch (e: any) { this.gErr.set(e?.message ?? String(e)); }
    finally { this.gSaving.set(false); }
  }
  async genGlobalPhrases(k: PhraseKind): Promise<void> {
    this.genBusy.set(true); this.gErr.set('');
    try {
      const r = await this.content.generate({ scope: 'global', category: k, count: 5 });
      if (r.error) this.gErr.set(r.error);
      else (r.phrases ?? []).forEach((t) => this.gPhrases[k].push({ text: t }));
    } finally { this.genBusy.set(false); }
  }
  async genGlobalPrompts(): Promise<void> {
    this.genBusy.set(true); this.gErr.set('');
    try {
      const r = await this.content.generate({ scope: 'global', category: 'suggestedPrompts', count: 4 });
      if (r.error) this.gErr.set(r.error);
      else (r.prompts ?? []).forEach((p) => this.gPromptList.push(p));
    } finally { this.genBusy.set(false); }
  }

  // ---- per-assistant ----
  private async loadAssistants(): Promise<void> {
    try { this.assistants.set(await this.asstSvc.listAssistants()); } catch { /* ignore */ }
  }
  async onSelectAssistant(): Promise<void> {
    if (!this.selId) return;
    this.aLoading.set(true); this.aErr.set(''); this.aMsg.set('');
    this.draftPhrases = { greetings: [], infoAcknowledgements: [], farewells: [] };
    this.draftPrompts = [];
    try {
      this.flags.set(await this.content.resolutionFlags(this.selId));
      const c = await this.content.listForEdit(this.selId);
      this.current = { greetings: c.greetings, infoAcknowledgements: c.infoAcknowledgements, farewells: c.farewells };
      this.currentPrompts = c.suggestedPrompts;
    } catch (e: any) { this.aErr.set(e?.message ?? String(e)); }
    finally { this.aLoading.set(false); }
  }
  summaryPhrases(k: PhraseKind): string {
    if (this.flags()[k]) {
      const n = this.current[k].length;
      return n ? `${n} frase(s) personalizada(s).` : 'Sin frases personalizadas todavia.';
    }
    return 'Usando las respuestas globales.';
  }
  async genAsstPhrases(k: PhraseKind): Promise<void> {
    this.genBusy.set(true); this.aErr.set('');
    try {
      const r = await this.content.generate({ scope: 'assistant', assistantId: this.selId, category: k, count: 5 });
      if (r.error) this.aErr.set(r.error);
      else this.draftPhrases[k] = r.phrases ?? [];
    } finally { this.genBusy.set(false); }
  }
  async genAsstPrompts(): Promise<void> {
    this.genBusy.set(true); this.aErr.set('');
    try {
      const r = await this.content.generate({ scope: 'assistant', assistantId: this.selId, category: 'suggestedPrompts', count: 4 });
      if (r.error) this.aErr.set(r.error);
      else this.draftPrompts = r.prompts ?? [];
    } finally { this.genBusy.set(false); }
  }
  async acceptPhrases(k: PhraseKind): Promise<void> {
    const items = this.draftPhrases[k].map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
    if (!items.length) return;
    this.aErr.set('');
    try {
      await this.content.replaceCategory(this.selId, k, items);
      this.draftPhrases[k] = [];
      this.aMsg.set('Guardado como personalizado.');
      await this.onSelectAssistant();
    } catch (e: any) { this.aErr.set(e?.message ?? String(e)); }
  }
  async acceptPrompts(): Promise<void> {
    const items = this.draftPrompts.filter((p) => p.label.trim() && p.prompt.trim());
    if (!items.length) return;
    this.aErr.set('');
    try {
      await this.content.replaceCategory(this.selId, 'suggestedPrompts', items);
      this.draftPrompts = [];
      this.aMsg.set('Guardado como personalizado.');
      await this.onSelectAssistant();
    } catch (e: any) { this.aErr.set(e?.message ?? String(e)); }
  }
  async revert(k: ConvKind): Promise<void> {
    if (!confirm('¿Revertir esta categoria a las respuestas globales?')) return;
    this.aErr.set('');
    try {
      await this.content.revertCategory(this.selId, k, true);
      this.aMsg.set('Revertido a global.');
      await this.onSelectAssistant();
    } catch (e: any) { this.aErr.set(e?.message ?? String(e)); }
  }
}
