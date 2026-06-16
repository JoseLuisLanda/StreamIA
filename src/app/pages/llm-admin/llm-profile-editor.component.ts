import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LlmProfileService } from '../../services/llm-profile.service';
import { LlmConfigProfile, TestProfileResult } from '../../lib/llm-admin/llm-profile.models';
import { LlmProviderId, MODEL_SUGGESTIONS, PROVIDERS, PROVIDER_LABELS } from '../../lib/llm-admin/llm-admin.models';

/**
 * Reusable editor for ONE LlmConfigProfile: provider/model/params + N labeled
 * keys (add/replace/delete, one active) + Test. Used by /llm-admin (global) and
 * the Assistant Manager (private). Key values are write-only (never echoed).
 * Emits (changed) after any persisted mutation so the parent can refresh.
 */
@Component({
  selector: 'app-llm-profile-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="pe">
      <div class="grid2">
        <label class="fld"><span>Name</span>
          <input type="text" [(ngModel)]="p.name" placeholder="OpenAI Produccion" />
        </label>
        <label class="fld"><span>Provider</span>
          <select [(ngModel)]="p.provider" (ngModelChange)="onProvider()">
            <option *ngFor="let pr of providers" [value]="pr">{{ labels[pr] }}</option>
          </select>
        </label>
      </div>
      <div class="grid2">
        <label class="fld"><span>Model</span>
          <input type="text" [(ngModel)]="p.model" [attr.list]="'pm-' + p.provider" />
          <datalist [id]="'pm-' + p.provider">
            <option *ngFor="let m of suggestions()" [value]="m"></option>
          </datalist>
        </label>
        <label class="fld"><span>Base URL (optional)</span>
          <input type="text" [(ngModel)]="p.baseUrl" placeholder="leave blank for default" />
        </label>
      </div>
      <div class="grid3">
        <label class="fld"><span>Temperature</span><input type="number" min="0" max="2" step="0.05" [(ngModel)]="p.temperature" /></label>
        <label class="fld"><span>Max output tokens</span><input type="number" min="1" max="8192" [(ngModel)]="p.maxOutputTokens" /></label>
        <label class="fld"><span>top_p</span><input type="number" min="0" max="1" step="0.05" [(ngModel)]="p.topP" /></label>
      </div>
      <div class="row">
        <button class="btn primary" (click)="saveProfile()" [disabled]="busy()">{{ p.id ? 'Save profile' : 'Create profile' }}</button>
        <span class="ok" *ngIf="savedMsg()">{{ savedMsg() }}</span>
        <span class="err" *ngIf="err()">{{ err() }}</span>
      </div>

      <!-- Keys (only after the profile exists) -->
      <div class="keys" *ngIf="p.id">
        <h4>Labeled keys <small>(one active; values are write-only)</small></h4>
        <div class="empty" *ngIf="!p.keys.length">No keys yet — add one below.</div>
        <div class="krow" *ngFor="let k of p.keys">
          <label class="kactive">
            <input type="radio" name="active-{{ p.id }}" [checked]="k.active" (change)="setActive(k.id)" />
            <span>active</span>
          </label>
          <span class="klabel">{{ k.label }}</span>
          <span class="kmeta">{{ k.secretName }}</span>
          <button class="btn xs" (click)="replaceTarget.set(k.id); newLabel = k.label" title="Replace value">Replace</button>
          <button class="btn xs danger" (click)="deleteKey(k.id)">Delete</button>
        </div>

        <div class="addkey">
          <input type="text" [(ngModel)]="newLabel" placeholder="Label (e.g. Cuenta principal)" />
          <input type="password" [(ngModel)]="newKey" placeholder="paste API key" autocomplete="off" />
          <button class="btn" (click)="saveKey()" [disabled]="!newLabel.trim() || !newKey.trim() || busy()">
            {{ replaceTarget() ? 'Replace value' : 'Add key' }}
          </button>
          <button class="btn ghost" *ngIf="replaceTarget()" (click)="replaceTarget.set(null); newLabel=''; newKey=''">Cancel</button>
        </div>
        <p class="err" *ngIf="keyErr()">{{ keyErr() }}</p>

        <div class="row">
          <button class="btn" (click)="test()" [disabled]="testing()">{{ testing() ? 'Testing...' : 'Test profile' }}</button>
          <span class="ok" *ngIf="testResult()?.ok">OK — {{ testResult()?.provider }}/{{ testResult()?.model }} (key: {{ testResult()?.key }})</span>
          <span class="err" *ngIf="testResult() && !testResult()?.ok">Failed: {{ testResult()?.error }}</span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .pe { display: flex; flex-direction: column; gap: 12px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .fld { display: flex; flex-direction: column; gap: 5px; }
    .fld > span { font-size: 12px; color: #aeb4c0; }
    input, select { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.1);
      border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    input:focus, select:focus { outline: none; border-color: rgba(139,92,246,.6); }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .keys { border-top: 1px solid rgba(255,255,255,.08); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
    .keys h4 { margin: 0; font-size: 13.5px; } .keys small { color: #8b93a3; font-weight: 400; }
    .empty { font-size: 12.5px; color: #8b93a3; }
    .krow { display: flex; align-items: center; gap: 10px; font-size: 12.5px; background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07); border-radius: 8px; padding: 7px 10px; }
    .kactive { display: flex; align-items: center; gap: 5px; color: #8b93a3; }
    .klabel { font-weight: 600; }
    .kmeta { color: #6b7384; font-family: ui-monospace, Menlo, monospace; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .addkey { display: flex; gap: 8px; flex-wrap: wrap; }
    .addkey input { flex: 1; min-width: 160px; }
    .btn { padding: 7px 12px; border-radius: 8px; cursor: pointer; font-size: 12.5px;
      background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); } .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: #8b5cf6; border-color: #8b5cf6; color: #fff; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.1); color: #cdd2db; }
    .btn.xs { padding: 4px 9px; font-size: 11px; }
    .btn.danger { background: rgba(179,57,57,.2); border-color: rgba(179,57,57,.5); color: #ffb3b3; }
    .ok { color: #6ee7b7; font-size: 12.5px; } .err { color: #fca5a5; font-size: 12.5px; }
  `],
})
export class LlmProfileEditorComponent {
  @Input({ required: true }) p!: LlmConfigProfile;
  @Output() changed = new EventEmitter<string>(); // emits profile id after persistence

  private svc = inject(LlmProfileService);
  readonly providers: LlmProviderId[] = PROVIDERS;
  readonly labels = PROVIDER_LABELS;

  newLabel = '';
  newKey = '';
  readonly replaceTarget = signal<string | null>(null);
  readonly busy = signal(false);
  readonly testing = signal(false);
  readonly savedMsg = signal('');
  readonly err = signal('');
  readonly keyErr = signal('');
  readonly testResult = signal<TestProfileResult | null>(null);

  suggestions(): string[] {
    return MODEL_SUGGESTIONS[this.p.provider] ?? [];
  }
  onProvider(): void {
    const s = this.suggestions();
    if (s.length && !s.includes(this.p.model)) this.p.model = s[0];
  }

  async saveProfile(): Promise<void> {
    this.busy.set(true); this.err.set(''); this.savedMsg.set('');
    try {
      const id = await this.svc.saveProfile(this.p);
      this.p.id = id;
      this.savedMsg.set('Saved');
      this.changed.emit(id);
    } catch (e: any) {
      this.err.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async saveKey(): Promise<void> {
    const label = this.newLabel.trim(); const key = this.newKey.trim();
    if (!label || !key) return;
    this.busy.set(true); this.keyErr.set('');
    try {
      await this.svc.setKey(this.p.id, label, key, this.replaceTarget() ?? undefined);
      this.newLabel = ''; this.newKey = ''; this.replaceTarget.set(null);
      this.changed.emit(this.p.id);
    } catch (e: any) {
      this.keyErr.set(e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async setActive(keyId: string): Promise<void> {
    this.busy.set(true); this.keyErr.set('');
    try { await this.svc.setActiveKey(this.p.id, keyId); this.changed.emit(this.p.id); }
    catch (e: any) { this.keyErr.set(e?.message ?? String(e)); }
    finally { this.busy.set(false); }
  }

  async deleteKey(keyId: string): Promise<void> {
    if (!confirm('Delete this key (and its secret)?')) return;
    this.busy.set(true); this.keyErr.set('');
    try { await this.svc.deleteKey(this.p.id, keyId); this.changed.emit(this.p.id); }
    catch (e: any) { this.keyErr.set(e?.message ?? String(e)); }
    finally { this.busy.set(false); }
  }

  async test(): Promise<void> {
    this.testing.set(true); this.testResult.set(null);
    try { this.testResult.set(await this.svc.test(this.p.id)); }
    finally { this.testing.set(false); }
  }
}
