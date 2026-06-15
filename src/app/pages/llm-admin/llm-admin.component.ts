import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AdminService } from '../../services/admin.service';
import { LlmAdminService } from '../../services/llm-admin.service';
import { getFirebaseAuth } from '../../services/firebase-client';
import {
  DEFAULT_LLM_CONFIG,
  KeyStatus,
  LlmConfig,
  LlmProviderId,
  MODEL_SUGGESTIONS,
  PROVIDER_LABELS,
  PROVIDERS,
  TestConnectionResult,
} from '../../lib/llm-admin/llm-admin.models';
import { environment } from '../../../environments/environment';

/**
 * Admin-only LLM provider configuration (/llm-admin).
 *
 * Configures the SERVER-SIDE chatRag generation provider: provider, model, params
 * (non-secret, Firestore config/llm) + the API key (write-only, Secret Manager
 * via callable). The key is never echoed back -- only a masked "configured" state.
 * Dark/purple theme, top-nav alongside the other admin panels, respects
 * enforceAdminRole.
 */
@Component({
  selector: 'app-llm-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="logo">AI</span> LLM Admin</div>
        <nav class="topnav">
          <a routerLink="/admin">&larr; Admin</a>
          <a routerLink="/avatar-manager">Avatar Manager</a>
          <a routerLink="/assistant-manager">Assistant Manager</a>
          <a routerLink="/rag-admin">RAG Admin</a>
          <a routerLink="/role-admin">Roles</a>
        </nav>
      </header>

      <div class="body">
        <div class="denied" *ngIf="!allowed()">You do not have admin access to this panel.</div>

        <main class="content" *ngIf="allowed()">
          <div class="state" *ngIf="loading()"><span class="spin big"></span><p>Loading config...</p></div>

          <ng-container *ngIf="!loading()">
            <h1 class="vtitle">Text generation provider</h1>
            <p class="vsub">
              Configure the provider chatRag uses to generate answers. Params are stored in
              <code>config/llm</code>; the API key is stored server-side in Secret Manager and never read back.
              RAG retrieval and embeddings are unchanged.
            </p>

            <!-- ===== provider + model ===== -->
            <section class="card">
              <h3>Provider &amp; model</h3>
              <div class="grid2">
                <label class="fld">
                  <span>Provider</span>
                  <select [(ngModel)]="cfg.provider" (ngModelChange)="onProviderChange()">
                    <option *ngFor="let p of providers" [value]="p">{{ labels[p] }}</option>
                  </select>
                </label>
                <label class="fld">
                  <span>Model</span>
                  <input type="text" [(ngModel)]="cfg.model" [attr.list]="'models-' + cfg.provider"
                         placeholder="model id" />
                  <datalist [id]="'models-' + cfg.provider">
                    <option *ngFor="let m of modelSuggestions()" [value]="m"></option>
                  </datalist>
                </label>
              </div>

              <div class="grid3">
                <label class="fld">
                  <span>Temperature</span>
                  <input type="number" min="0" max="2" step="0.05" [(ngModel)]="cfg.temperature" />
                </label>
                <label class="fld">
                  <span>Max output tokens</span>
                  <input type="number" min="1" max="8192" step="1" [(ngModel)]="cfg.maxOutputTokens" />
                </label>
                <label class="fld">
                  <span>top_p</span>
                  <input type="number" min="0" max="1" step="0.05" [(ngModel)]="cfg.topP" />
                </label>
              </div>

              <div class="grid2">
                <label class="fld">
                  <span>Base URL <em>(optional)</em></span>
                  <input type="text" [(ngModel)]="cfg.baseUrl" placeholder="leave blank for provider default" />
                </label>
              </div>

              <div class="row">
                <button class="btn primary" (click)="saveConfig()" [disabled]="savingCfg()">
                  {{ savingCfg() ? 'Saving...' : 'Save configuration' }}
                </button>
                <span class="ok" *ngIf="cfgSaved()">Saved ✓</span>
                <span class="meta" *ngIf="cfg.updatedAt">last updated {{ fmtDate(cfg.updatedAt) }}</span>
              </div>
            </section>

            <!-- ===== API key (all providers are key-based) ===== -->
            <section class="card">
              <h3>API key — {{ labels[cfg.provider] }}</h3>
              <p class="hint">
                Stored server-side in Secret Manager via a callable. Write-only: it is never displayed again.
              </p>
              <div class="keyrow">
                <span class="badge" [class.on]="keyConfigured()">
                  {{ keyConfigured() ? 'Key configured ✓' : 'No key configured' }}
                </span>
                <span class="meta" *ngIf="keyUpdatedAt()">updated {{ fmtDate(keyUpdatedAt()!) }}</span>
              </div>
              <div class="grid2">
                <label class="fld wide">
                  <span>{{ keyConfigured() ? 'Replace key' : 'Set key' }}</span>
                  <input type="password" [(ngModel)]="apiKeyInput" placeholder="paste API key" autocomplete="off" />
                </label>
              </div>
              <div class="row">
                <button class="btn" (click)="saveKey()" [disabled]="!apiKeyInput.trim() || savingKey()">
                  {{ savingKey() ? 'Saving...' : 'Save key' }}
                </button>
                <span class="ok" *ngIf="keySaved()">Key saved ✓</span>
                <span class="err" *ngIf="keyError()">{{ keyError() }}</span>
              </div>
            </section>

            <!-- ===== test connection ===== -->
            <section class="card">
              <h3>Test connection</h3>
              <p class="hint">Runs a tiny server-side generation against the current settings and reports the real provider error.</p>
              <div class="row">
                <button class="btn" (click)="test()" [disabled]="testing()">
                  {{ testing() ? 'Testing...' : 'Test connection' }}
                </button>
              </div>
              <div class="testresult" *ngIf="testResult() as r">
                <div class="tr-ok" *ngIf="r.ok">
                  Success — {{ r.provider }} / {{ r.model }}<span *ngIf="r.sample"> · sample: "{{ r.sample }}"</span>
                </div>
                <div class="tr-err" *ngIf="!r.ok">
                  Failed — {{ r.provider }} / {{ r.model }}<br /><code>{{ r.error }}</code>
                </div>
              </div>
            </section>

            <p class="err big" *ngIf="error()">{{ error() }}</p>
          </ng-container>
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
    .vsub code, code { background: rgba(255,255,255,.06); padding: 1px 6px; border-radius: 6px;
      font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; margin-bottom: 18px; }
    .card h3 { margin: 0 0 12px; font-size: 16px; font-weight: 700; }
    .hint { margin: 0 0 12px; font-size: 12.5px; color: #8b93a3; line-height: 1.5; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 12px; }
    .fld { display: flex; flex-direction: column; gap: 6px; }
    .fld.wide { grid-column: 1 / -1; }
    .fld > span { font-size: 12px; color: #aeb4c0; }
    .fld em { color: #6b7384; font-style: normal; }
    .fld input, .fld select { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid var(--line);
      border-radius: 9px; padding: 9px 11px; font-size: 13px; }
    .fld input:focus, .fld select:focus { outline: none; border-color: rgba(139,92,246,.6); }
    .row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
    .keyrow { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .badge { font-size: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,.08); color: #aeb4c0; }
    .badge.on { background: rgba(52,211,153,.16); color: #6ee7b7; }
    .btn { padding: 9px 16px; border-radius: 9px; cursor: pointer; font-size: 13px;
      background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover:not(:disabled) { background: #7c4ff0; }
    .ok { color: #6ee7b7; font-size: 12.5px; }
    .meta { color: #6b7384; font-size: 12px; }
    .err { color: #fca5a5; font-size: 12.5px; }
    .err.big { margin-top: 10px; }
    .testresult { margin-top: 12px; font-size: 13px; }
    .tr-ok { color: #6ee7b7; }
    .tr-err { color: #fca5a5; }
    .tr-err code { display: inline-block; margin-top: 6px; color: #fca5a5; background: rgba(248,113,113,.1);
      padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
    .spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.15); border-top-color: var(--accent);
      border-radius: 50%; display: inline-block; animation: laspin 1s linear infinite; }
    .spin.big { width: 30px; height: 30px; border-width: 3px; }
    .state { display: flex; flex-direction: column; align-items: center; gap: 12px; color: #8b93a3; margin-top: 60px; }
    @keyframes laspin { to { transform: rotate(360deg); } }
    @media (max-width: 760px) { .grid2, .grid3 { grid-template-columns: 1fr; } .topnav { flex-wrap: wrap; } }
  `],
})
export class LlmAdminComponent implements OnInit {
  private admin = inject(AdminService);
  private svc = inject(LlmAdminService);

  readonly providers: LlmProviderId[] = PROVIDERS;
  readonly labels = PROVIDER_LABELS;

  cfg: LlmConfig = { ...DEFAULT_LLM_CONFIG };
  apiKeyInput = '';

  readonly loading = signal(true);
  readonly savingCfg = signal(false);
  readonly cfgSaved = signal(false);
  readonly savingKey = signal(false);
  readonly keySaved = signal(false);
  readonly keyError = signal('');
  readonly testing = signal(false);
  readonly testResult = signal<TestConnectionResult | null>(null);
  readonly error = signal('');
  private keyStatus = signal<KeyStatus>({});

  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  // NOTE: these read cfg.provider (a plain field, not a signal), so they must be
  // METHODS -- a computed() would cache the initial provider and never react to
  // the dropdown. Method bindings re-evaluate on the (ngModelChange) CD cycle.
  keyConfigured(): boolean {
    return !!this.keyStatus()[this.cfg.provider]?.updatedAt;
  }
  keyUpdatedAt(): number | undefined {
    return this.keyStatus()[this.cfg.provider]?.updatedAt;
  }

  modelSuggestions(): string[] {
    return MODEL_SUGGESTIONS[this.cfg.provider] ?? [];
  }

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (!this.allowed()) { this.loading.set(false); return; }
    try {
      const { config, keyStatus } = await this.svc.load();
      this.cfg = config;
      this.keyStatus.set(keyStatus);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  onProviderChange(): void {
    // Suggest a default model when switching to a provider with an empty/foreign model.
    const sugg = this.modelSuggestions();
    if (sugg.length && !sugg.includes(this.cfg.model)) this.cfg.model = sugg[0];
    this.testResult.set(null);
    this.keySaved.set(false);
    this.keyError.set('');
  }

  async saveConfig(): Promise<void> {
    this.savingCfg.set(true);
    this.cfgSaved.set(false);
    this.error.set('');
    try {
      const uid = getFirebaseAuth().currentUser?.uid ?? undefined;
      await this.svc.saveConfig(this.cfg, uid);
      this.cfg.updatedAt = Date.now();
      this.cfgSaved.set(true);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.savingCfg.set(false);
    }
  }

  async saveKey(): Promise<void> {
    const key = this.apiKeyInput.trim();
    if (!key) return;
    this.savingKey.set(true);
    this.keySaved.set(false);
    this.keyError.set('');
    try {
      await this.svc.setApiKey(this.cfg.provider, key);
      this.apiKeyInput = '';
      this.keySaved.set(true);
      // Reflect "configured" immediately without re-reading the key.
      this.keyStatus.update((s) => ({ ...s, [this.cfg.provider]: { updatedAt: Date.now() } }));
    } catch (e: any) {
      this.keyError.set(e?.message ?? String(e));
    } finally {
      this.savingKey.set(false);
    }
  }

  async test(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    try {
      // Test the current (possibly unsaved) settings via override.
      const res = await this.svc.testConnection({
        provider: this.cfg.provider,
        model: this.cfg.model,
        temperature: this.cfg.temperature,
        maxOutputTokens: this.cfg.maxOutputTokens,
        topP: this.cfg.topP,
        baseUrl: this.cfg.baseUrl,
      });
      this.testResult.set(res);
    } finally {
      this.testing.set(false);
    }
  }

  fmtDate(ms?: number): string {
    return ms ? new Date(ms).toLocaleString() : '';
  }
}
