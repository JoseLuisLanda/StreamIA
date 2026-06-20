import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminService } from '../../services/admin.service';
import { LlmProfileService } from '../../services/llm-profile.service';
import { LlmProfileEditorComponent } from './llm-profile-editor.component';
import { LlmConfigProfile, activeKeyOf, newProfileDraft } from '../../lib/llm-admin/llm-profile.models';
import { PROVIDER_LABELS } from '../../lib/llm-admin/llm-admin.models';
import { environment } from '../../../environments/environment';

/**
 * /llm-admin = manager of GLOBAL LLM config profiles (reusable, one system
 * default). Create/edit/delete profiles, manage each profile's labeled keys (in
 * the embedded editor), and mark one as the system default. Admin-gated.
 * Per-assistant (private) profiles are managed in the Assistant Manager.
 */
@Component({
  selector: 'app-llm-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, LlmProfileEditorComponent],
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="logo">AI</span> LLM Admin</div>
        <nav class="topnav">
          <a routerLink="/admin">&larr; Admin</a>
          <a routerLink="/assistant-manager">Assistant Manager</a>
          <a routerLink="/rag-admin">RAG Admin</a>
          <a routerLink="/role-admin">Roles</a>
          <a routerLink="/llm-responses">Respuestas</a>
        </nav>
      </header>

      <div class="body">
        <div class="denied" *ngIf="!allowed()">You do not have admin access to this panel.</div>

        <main class="content" *ngIf="allowed()">
          <div class="head">
            <div>
              <h1 class="vtitle">Global LLM profiles</h1>
              <p class="vsub">Reusable provider/model/params + labeled keys. One is the system default used by
                assistants without an assignment. Keys are stored in Secret Manager (write-only).</p>
            </div>
            <div class="headbtns">
              <button class="btn" (click)="migrate()" [disabled]="busy()" title="Migrate legacy config/llm">Migrar config/llm</button>
              <button class="btn primary" (click)="newProfile()">+ New profile</button>
            </div>
          </div>
          <p class="ok" *ngIf="msg()">{{ msg() }}</p>
          <p class="err" *ngIf="error()">{{ error() }}</p>

          <!-- GLOBAL per-stage default models (config/ragModels). -->
          <section class="card stagecard" *ngIf="!loading()">
            <h3>RAG stage models (global defaults)</h3>
            <p class="vsub">Which profile serves each chatRag stage by default. Assistants can override per stage in the Assistant Manager.</p>
            <div class="stagerow">
              <label class="fld"><span>Default Summary model</span>
                <select [ngModel]="stageSummaryId()" (ngModelChange)="stageSummaryId.set($event)">
                  <option value="">- system default profile -</option>
                  <option *ngFor="let p of profiles()" [value]="p.id">{{ p.name }} ({{ labels[p.provider] }}/{{ p.model }})</option>
                </select>
              </label>
              <label class="fld"><span>Default Detail model</span>
                <select [ngModel]="stageDetailId()" (ngModelChange)="stageDetailId.set($event)">
                  <option value="">- system default profile -</option>
                  <option *ngFor="let p of profiles()" [value]="p.id">{{ p.name }} ({{ labels[p.provider] }}/{{ p.model }})</option>
                </select>
              </label>
            </div>
            <div class="row">
              <button class="btn primary" (click)="saveStageDefaults()" [disabled]="stageSaving()">{{ stageSaving() ? 'Saving...' : 'Save stage defaults' }}</button>
              <span class="ok" *ngIf="stageMsg()">{{ stageMsg() }}</span>
            </div>
          </section>

          <div class="state" *ngIf="loading()"><span class="spin"></span> Loading...</div>

          <div class="empty" *ngIf="!loading() && !profiles().length">
            No global profiles yet. Create one, or migrate the legacy config.
          </div>

          <!-- list -->
          <div class="rows" *ngIf="!loading() && profiles().length">
            <div class="prow" *ngFor="let p of profiles()">
              <div class="pinfo">
                <div class="pname">
                  {{ p.name }}
                  <span class="pill" *ngIf="p.isSystemDefault">system default</span>
                </div>
                <div class="pmeta">
                  {{ labels[p.provider] }} · {{ p.model }} · {{ p.keys.length }} key(s)
                  <span *ngIf="activeKey(p)"> · active: {{ activeKey(p)!.label }}</span>
                </div>
              </div>
              <div class="pactions">
                <button class="btn xs" *ngIf="!p.isSystemDefault" (click)="setDefault(p)" [disabled]="busy()">Set default</button>
                <button class="btn xs" (click)="edit(p)">Edit</button>
                <button class="btn xs danger" (click)="remove(p)" [disabled]="busy()">Delete</button>
              </div>
            </div>
          </div>

          <!-- editor -->
          <section class="card" *ngIf="editing()">
            <h3>{{ editing()!.id ? 'Edit profile' : 'New global profile' }}</h3>
            <app-llm-profile-editor [p]="editing()!" (changed)="onEditorChanged()"></app-llm-profile-editor>
            <div class="row"><button class="btn ghost" (click)="closeEditor()">Close</button></div>
          </section>
        </main>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; min-height: 100vh; }
    * { box-sizing: border-box; }
    .shell { min-height: 100vh; display: flex; flex-direction: column; background: #0a0e14; color: #e6e8ee;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; --accent: #8b5cf6; --line: rgba(255,255,255,.08); --card: #121823; }
    .topbar { flex: none; height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 22px; border-bottom: 1px solid var(--line); }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; }
    .logo { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: rgba(139,92,246,.22); color: #a78bfa; font-size: 11px; font-weight: 700; }
    .topnav { display: flex; gap: 14px; font-size: 13.5px; }
    .topnav a { color: #c7ccd6; text-decoration: none; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); }
    .topnav a:hover { background: rgba(255,255,255,.05); color: #fff; }
    .body { flex: 1; display: flex; min-height: 0; }
    .denied { margin: auto; color: #ffb3b3; }
    .content { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 26px; max-width: 960px; margin: 0 auto; width: 100%; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
    .headbtns { display: flex; gap: 8px; }
    .vtitle { margin: 0 0 4px; font-size: 24px; font-weight: 700; }
    .vsub { margin: 0 0 8px; font-size: 13px; color: #8b93a3; line-height: 1.5; max-width: 640px; }
    .rows { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
    .prow { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
    .pname { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .pmeta { font-size: 12.5px; color: #8b93a3; margin-top: 3px; }
    .pill { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; background: rgba(52,211,153,.16); color: #6ee7b7; font-weight: 600; }
    .pactions { display: flex; gap: 7px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin-top: 18px; }
    .card h3 { margin: 0 0 12px; font-size: 16px; }
    .stagecard { margin-top: 0; margin-bottom: 18px; }
    .stagerow { display: flex; gap: 14px; flex-wrap: wrap; margin: 6px 0 12px; }
    .fld { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 220px; font-size: 12px; color: #aeb4c0; }
    .fld select { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; padding: 8px 10px; font-size: 13px; }
    .row { display: flex; gap: 10px; margin-top: 12px; }
    .btn { padding: 8px 13px; border-radius: 8px; cursor: pointer; font-size: 12.5px; background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); } .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: var(--line); color: #cdd2db; }
    .btn.xs { padding: 5px 10px; font-size: 11.5px; }
    .btn.danger { background: rgba(179,57,57,.2); border-color: rgba(179,57,57,.5); color: #ffb3b3; }
    .ok { color: #6ee7b7; font-size: 12.5px; } .err { color: #fca5a5; font-size: 12.5px; }
    .empty { color: #8b93a3; font-size: 13px; margin-top: 14px; }
    .state { display: flex; align-items: center; gap: 8px; color: #8b93a3; margin-top: 16px; }
    .spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.15); border-top-color: var(--accent); border-radius: 50%; display: inline-block; animation: las 1s linear infinite; }
    @keyframes las { to { transform: rotate(360deg); } }
    @media (max-width: 760px) { .topnav { flex-wrap: wrap; } }
  `],
})
export class LlmAdminComponent implements OnInit {
  private admin = inject(AdminService);
  private svc = inject(LlmProfileService);
  readonly labels = PROVIDER_LABELS;

  readonly profiles = signal<LlmConfigProfile[]>([]);
  readonly editing = signal<LlmConfigProfile | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly msg = signal('');
  readonly error = signal('');

  // GLOBAL per-stage default models (config/ragModels).
  readonly stageSummaryId = signal('');
  readonly stageDetailId = signal('');
  readonly stageSaving = signal(false);
  readonly stageMsg = signal('');

  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  activeKey = activeKeyOf;

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (this.allowed()) await this.refresh();
    else this.loading.set(false);
  }

  async refresh(): Promise<void> {
    this.loading.set(true); this.error.set('');
    try {
      const [profiles, stage] = await Promise.all([this.svc.listGlobal(), this.svc.getStageDefaults()]);
      this.profiles.set(profiles);
      this.stageSummaryId.set(stage.summaryProfileId);
      this.stageDetailId.set(stage.detailProfileId);
    }
    catch (e: any) { this.error.set(e?.message ?? String(e)); }
    finally { this.loading.set(false); }
  }

  async saveStageDefaults(): Promise<void> {
    this.stageSaving.set(true); this.stageMsg.set(''); this.error.set('');
    try {
      await this.svc.saveStageDefaults({ summaryProfileId: this.stageSummaryId(), detailProfileId: this.stageDetailId() });
      this.stageMsg.set('Saved.');
    } catch (e: any) { this.error.set(e?.message ?? String(e)); }
    finally { this.stageSaving.set(false); }
  }

  newProfile(): void { this.editing.set(newProfileDraft('global')); }
  edit(p: LlmConfigProfile): void { this.editing.set({ ...p, keys: [...p.keys] }); }
  closeEditor(): void { this.editing.set(null); void this.refresh(); }

  async onEditorChanged(): Promise<void> {
    await this.refresh();
    // keep the editor open on the (now-persisted) profile so keys can be added
    const id = this.editing()?.id;
    if (id) {
      const fresh = this.profiles().find((x) => x.id === id);
      if (fresh) this.editing.set({ ...fresh, keys: [...fresh.keys] });
    }
  }

  async setDefault(p: LlmConfigProfile): Promise<void> {
    this.busy.set(true); this.error.set(''); this.msg.set('');
    try { await this.svc.setSystemDefault(p.id); this.msg.set(`"${p.name}" is now the system default.`); await this.refresh(); }
    catch (e: any) { this.error.set(e?.message ?? String(e)); }
    finally { this.busy.set(false); }
  }

  async remove(p: LlmConfigProfile): Promise<void> {
    if (!confirm(`Delete profile "${p.name}" and its keys?`)) return;
    this.busy.set(true); this.error.set('');
    try { await this.svc.deleteProfile(p.id); if (this.editing()?.id === p.id) this.editing.set(null); await this.refresh(); }
    catch (e: any) { this.error.set(e?.message ?? String(e)); }
    finally { this.busy.set(false); }
  }

  async migrate(): Promise<void> {
    this.busy.set(true); this.error.set(''); this.msg.set('');
    try { const r = await this.svc.migrateLegacy(); this.msg.set(r.message); await this.refresh(); }
    catch (e: any) { this.error.set(e?.message ?? String(e)); }
    finally { this.busy.set(false); }
  }
}
