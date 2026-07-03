import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ArContentService, ArUploadProgress } from '../../services/ar-content.service';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { RagAdminService } from '../../services/rag-admin.service';
import { AdminService } from '../../services/admin.service';
import { AuthService } from '../../services/auth.service';
import { ArElement, ArGeoPoint, ArMarkerType, publishBlockers } from '../../lib/ar/ar.models';
import { AssistantConfig } from '../../lib/rag/rag.models';
import { RagNamespace } from '../../lib/rag/rag-admin.models';
import { ArLocationPickerComponent } from './components/location-picker.component';
import { ArAssetEditorComponent } from './components/asset-editor.component';

/**
 * AR Content Manager (/ar-content-manager) -- FASE 0 of the /ar-assistant
 * feature. Follows the Assistant Manager list+editor pattern.
 *
 * Access: authGuard only (NOT adminGuard) -- a "gestor" is any authenticated
 * user and sees/edits ONLY their own elements (ownerUid). An admin (claim or
 * admins/{uid} allowlist, resolved in-component via AdminService) sees ALL
 * elements and may reassign ownership. Real enforcement lives in
 * firestore.rules / storage.rules; this component is UX.
 *
 * DRAFT-FIRST: "+ Nuevo" creates the doc immediately (enabled=false) so asset
 * uploads pass the cross-service Storage ownership rule. Drafts show a
 * "Borrador" badge in the list so abandoned ones stay visible and purgable.
 */
@Component({
  selector: 'app-ar-content-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ArLocationPickerComponent, ArAssetEditorComponent],
  template: `
    <div class="wrap">
      <header class="bar">
        <div class="brand"><span class="logo">RA</span> Contenido RA</div>
        <nav class="topnav">
          <a routerLink="/home">Home</a>
          <a routerLink="/assistants">Asistentes</a>
          <a *ngIf="isAdmin()" routerLink="/admin">Admin</a>
        </nav>
      </header>

      <main class="main" [class.editing]="view() === 'edit'">
        <!-- ============ LIST ============ -->
        <ng-container *ngIf="view() === 'list'">
          <div class="head">
            <div>
              <h1>Elementos de Realidad Aumentada</h1>
              <p class="sub">
                Publica imagenes, videos y modelos 3D anclados al mundo real. El visor solo muestra
                elementos PUBLICADOS; los borradores quedan aqui hasta que los publiques.
                <span *ngIf="isAdmin()">(Vista de administrador: ves TODOS los elementos.)</span>
              </p>
            </div>
            <button class="btn primary" (click)="newElement()" [disabled]="creating()">{{ creating() ? 'Creando...' : '+ Nuevo elemento' }}</button>
          </div>

          <div class="state" *ngIf="loading()"><span class="spin"></span><p>Cargando...</p></div>

          <div class="empty" *ngIf="!loading() && !elements().length">
            <h2>Aun no tienes elementos RA</h2>
            <p>Crea uno: fija su posicion (o marcador), sube sus assets y publicalo.</p>
            <button class="btn primary" (click)="newElement()">+ Nuevo elemento</button>
          </div>

          <div class="rows" *ngIf="!loading() && elements().length">
            <div class="arow" *ngFor="let el of elements()">
              <span class="mk" [title]="el.markerType">{{ markerLabel(el.markerType) }}</span>
              <div class="ainfo">
                <div class="aname">
                  {{ el.name || '(sin nombre)' }}
                  <span class="pill draft" *ngIf="!el.enabled">Borrador</span>
                  <span class="pill live" *ngIf="el.enabled">Publicado</span>
                </div>
                <div class="ameta">
                  <span>assistant: {{ el.assistantId || '-' }}</span>
                  <span>assets: {{ el.assets.length }}</span>
                  <span *ngIf="el.geo">{{ el.geo.lat | number:'1.5-5' }}, {{ el.geo.lng | number:'1.5-5' }}</span>
                  <span *ngIf="isAdmin()" class="owner">owner: {{ el.ownerEmail || el.ownerUid }}</span>
                </div>
              </div>
              <label class="toggle" [title]="el.enabled ? 'Publicado' : 'Borrador'">
                <input type="checkbox" [checked]="el.enabled" (change)="toggleEnabled(el, $event)" />
                <span>{{ el.enabled ? 'Publicado' : 'Borrador' }}</span>
              </label>
              <div class="actions">
                <button class="btn ghost sm" (click)="editElement(el)">Editar</button>
                <button class="btn danger sm" (click)="remove(el)">Eliminar</button>
              </div>
            </div>
          </div>
          <p class="err" *ngIf="error()">{{ error() }}</p>
        </ng-container>

        <!-- ============ EDIT ============ -->
        <ng-container *ngIf="view() === 'edit' && form">
          <div class="head">
            <h1>{{ form!.name ? 'Editar: ' + form!.name : 'Nuevo elemento RA' }}</h1>
            <button class="btn ghost" (click)="cancel()">Volver</button>
          </div>

          <div class="editor">
            <section class="col">
              <label class="fld"><span>Nombre *</span><input type="text" [(ngModel)]="form!.name" placeholder="Residencial Los Pinos" /></label>
              <label class="fld"><span>Descripcion</span><textarea rows="2" [(ngModel)]="form!.description" placeholder="Que vera y escuchara el usuario"></textarea></label>

              <label class="fld"><span>Asistente narrador *</span>
                <select [(ngModel)]="form!.assistantId">
                  <option value="">- selecciona asistente -</option>
                  <option *ngFor="let a of assistants()" [value]="a.id">{{ a.name }} ({{ a.id }})<ng-container *ngIf="a.arMode"> [RA]</ng-container></option>
                </select>
              </label>
              <p class="hint">Los asistentes marcados [RA] tienen el modo RA activo en el Assistant Manager.</p>

              <div class="box">
                <div class="bhead">Fuente de conocimiento para narrar *</div>
                <label class="radio"><input type="radio" name="nsrc" value="namespace" [(ngModel)]="narrationSource" /> <span>Namespace RAG (base de conocimiento)</span></label>
                <label class="fld" *ngIf="narrationSource === 'namespace'">
                  <select [(ngModel)]="form!.ragNamespace">
                    <option value="">- selecciona namespace -</option>
                    <option *ngFor="let n of namespaces()" [value]="n.id">{{ n.name || n.id }}</option>
                  </select>
                </label>
                <label class="radio"><input type="radio" name="nsrc" value="context" [(ngModel)]="narrationSource" /> <span>Contexto de narracion (texto plano)</span></label>
                <label class="fld" *ngIf="narrationSource === 'context'">
                  <textarea rows="4" [(ngModel)]="form!.narrationContext" placeholder="Este es el Residencial Los Pinos, un desarrollo premium con entrega en 2027..."></textarea>
                </label>
              </div>

              <div class="box">
                <div class="bhead">Anclaje en el mundo real *</div>
                <label class="fld"><span>Tipo de marcador</span>
                  <select [(ngModel)]="form!.markerType">
                    <option value="gps">GPS (posicion geografica)</option>
                    <option value="pattern">Pattern (.patt)</option>
                    <option value="nft">NFT (imagen natural)</option>
                  </select>
                </label>

                <ng-container *ngIf="form!.markerType === 'gps'">
                  <app-ar-location-picker
                    [lat]="form!.geo?.lat ?? 0" [lng]="form!.geo?.lng ?? 0"
                    (geoChange)="onGeo($event)"></app-ar-location-picker>
                </ng-container>

                <ng-container *ngIf="form!.markerType === 'pattern'">
                  <div class="patrow">
                    <label class="btn ghost sm">
                      {{ form!.patternUrl ? 'Reemplazar .patt' : 'Subir .patt' }}
                      <input type="file" hidden accept=".patt" (change)="onPatternFile($event)" />
                    </label>
                    <span class="hint" *ngIf="form!.patternUrl">{{ form!.patternUrl }}</span>
                    <span class="hint" *ngIf="patUploading()">Subiendo... {{ patProgress()?.percent ?? 0 }}%</span>
                  </div>
                </ng-container>

                <ng-container *ngIf="form!.markerType === 'nft'">
                  <label class="fld"><span>URL / base del descriptor NFT</span>
                    <input type="text" [(ngModel)]="form!.nftUrl" placeholder="ar-content/{{ form!.id }}/nft/base" />
                  </label>
                </ng-container>
              </div>

              <div class="box">
                <div class="bhead">Assets (imagen / video / modelo GLB)</div>
                <app-ar-asset-editor [element]="form!" (changed)="persistAssets()"></app-ar-asset-editor>
              </div>
            </section>

            <aside class="col side">
              <label class="toggle big">
                <input type="checkbox" [(ngModel)]="form!.enabled" />
                <span>Publicado (visible en el visor)</span>
              </label>
              <div class="blockers" *ngIf="form!.enabled && blockers().length">
                <p class="err">Para publicar, corrige:</p>
                <p class="err" *ngFor="let b of blockers()">- {{ b }}</p>
              </div>

              <div class="actions">
                <button class="btn primary" (click)="save()" [disabled]="saving() || (form!.enabled && blockers().length > 0)">{{ saving() ? 'Guardando...' : 'Guardar' }}</button>
                <button class="btn ghost" (click)="cancel()">Cancelar</button>
              </div>
              <p class="hint">Los assets se guardan al subirlos; el resto de campos, al presionar Guardar.</p>

              <div class="box" *ngIf="isAdmin()">
                <div class="bhead">Propietario (admin)</div>
                <p class="hint">Actual: {{ form!.ownerEmail || form!.ownerUid }}</p>
                <label class="fld"><span>Nuevo ownerUid</span><input type="text" [(ngModel)]="reassignUid" placeholder="uid de Firebase Auth" /></label>
                <label class="fld"><span>Email (solo display)</span><input type="text" [(ngModel)]="reassignEmail" placeholder="gestor@ejemplo.com" /></label>
                <button class="btn ghost sm" (click)="reassign()" [disabled]="!reassignUid.trim() || saving()">Reasignar propietario</button>
              </div>

              <p class="err" *ngIf="error()">{{ error() }}</p>
            </aside>
          </div>
        </ng-container>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    * { box-sizing: border-box; }
    .wrap { height: 100%; display: flex; flex-direction: column; background: #0a0e14; color: #e6e8ee; font-family: 'Segoe UI', system-ui, sans-serif; --accent: #8b5cf6; }
    .bar { flex: none; height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 22px; border-bottom: 1px solid rgba(255,255,255,.07); }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; }
    .logo { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: rgba(139,92,246,.22); color: #c4b0f7; font-size: 11px; font-weight: 700; }
    .topnav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .topnav a { color: #c7ccd6; text-decoration: none; font-size: 13px; padding: 7px 12px; border-radius: 8px; border: 1px solid transparent; }
    .topnav a:hover { background: rgba(255,255,255,.06); color: #fff; border-color: rgba(255,255,255,.1); }
    .main { flex: 1; min-height: 0; overflow-y: auto; width: 100%; max-width: 1100px; margin: 0 auto; padding: 26px 24px 64px; }
    .main.editing { max-width: 1320px; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
    h1 { font-size: 26px; font-weight: 800; margin: 0 0 6px; }
    .sub { color: #8b93a3; font-size: 13.5px; max-width: 760px; line-height: 1.5; margin: 0; }
    .state { display: flex; flex-direction: column; align-items: center; gap: 10px; color: #8b93a3; margin-top: 50px; }
    .spin { width: 24px; height: 24px; border: 3px solid rgba(255,255,255,.15); border-top-color: var(--accent); border-radius: 50%; animation: sp 1s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .empty { text-align: center; margin: 60px auto; max-width: 420px; }
    .empty h2 { margin: 0 0 6px; } .empty p { color: #8b93a3; margin: 0 0 14px; }
    .rows { display: flex; flex-direction: column; gap: 10px; }
    .arow { display: flex; align-items: center; gap: 14px; background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 12px 14px; }
    .mk { flex: none; width: 74px; text-align: center; font-size: 10.5px; padding: 4px 6px; border-radius: 8px; background: rgba(96,165,250,.12); border: 1px solid rgba(96,165,250,.35); color: #93c5fd; text-transform: uppercase; }
    .ainfo { flex: 1; min-width: 0; }
    .aname { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .pill { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; }
    .pill.draft { background: rgba(240,198,116,.14); border: 1px solid rgba(240,198,116,.45); color: #f0c674; }
    .pill.live { background: rgba(110,231,183,.12); border: 1px solid rgba(110,231,183,.4); color: #6ee7b7; }
    .ameta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: #8b93a3; margin-top: 3px; font-family: ui-monospace, Menlo, monospace; }
    .ameta .owner { color: #c4b0f7; }
    .toggle { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #aeb4c0; cursor: pointer; }
    .toggle.big { margin: 8px 0; font-size: 13px; }
    .actions { display: flex; gap: 7px; }
    .editor { display: grid; grid-template-columns: 1.5fr 1fr; gap: 20px; align-items: start; }
    .col { background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .col.side { position: sticky; top: 16px; }
    .fld { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #99a; }
    .fld input, .fld textarea, .fld select { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; padding: 9px 11px; font-size: 13px; }
    .box { border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
    .bhead { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #8b93a3; font-weight: 700; }
    .radio { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: #cbd0da; cursor: pointer; }
    .patrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .hint { font-size: 11px; color: #6b7384; line-height: 1.45; margin: 2px 0; overflow-wrap: anywhere; }
    .err { color: #ff9c9c; font-size: 12.5px; margin: 2px 0; }
    .blockers { border: 1px solid rgba(179,57,57,.4); border-radius: 10px; padding: 8px 10px; }
    .btn { padding: 9px 15px; border-radius: 9px; cursor: pointer; font-size: 13px; background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; text-decoration: none; display: inline-block; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); color: #cdd; }
    .btn.danger { background: rgba(179,57,57,.2); border-color: rgba(179,57,57,.5); color: #ffb3b3; }
    .btn.sm { padding: 5px 11px; font-size: 11.5px; }
    @media (max-width: 900px) { .editor { grid-template-columns: 1fr; } .col.side { position: static; } }
  `],
})
export class ArContentManagerComponent implements OnInit {
  private svc = inject(ArContentService);
  private assistantSvc = inject(AssistantConfigService);
  private ragSvc = inject(RagAdminService);
  private admin = inject(AdminService);
  private auth = inject(AuthService);

  readonly elements = signal<ArElement[]>([]);
  readonly assistants = signal<AssistantConfig[]>([]);
  readonly namespaces = signal<RagNamespace[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly creating = signal(false);
  readonly error = signal('');
  readonly view = signal<'list' | 'edit'>('list');
  readonly isAdmin = computed(() => this.admin.isAdmin() === true);

  readonly patUploading = signal(false);
  readonly patProgress = signal<ArUploadProgress | null>(null);

  form: ArElement | null = null;
  narrationSource: 'namespace' | 'context' = 'namespace';
  reassignUid = '';
  reassignEmail = '';
  /** True while editing a just-created draft the user never filled in. */
  private freshDraft = false;

  async ngOnInit(): Promise<void> {
    await this.auth.waitUntilReady?.();
    await this.admin.check();
    await this.reload();
  }

  markerLabel(t: ArMarkerType): string {
    return t === 'gps' ? 'GPS' : t === 'pattern' ? 'PATTERN' : 'NFT';
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const uid = this.auth.user()?.uid ?? '';
      const [els, assistants, namespaces] = await Promise.all([
        this.isAdmin() ? this.svc.listAllElements() : this.svc.listMine(uid),
        this.assistantSvc.listAssistants(),
        this.ragSvc.listNamespaces().catch(() => [] as RagNamespace[]),
      ]);
      this.elements.set(els);
      this.assistants.set(assistants);
      this.namespaces.set(namespaces);
      if (this.svc.error()) this.error.set(this.svc.error());
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Publish blockers for the current form (validation surface + save guard). */
  blockers(): string[] {
    return this.form ? publishBlockers(this.form) : [];
  }

  // ------------------------------------------------------------------- list

  async toggleEnabled(el: ArElement, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const enabled = input.checked;
    if (enabled) {
      const blockers = publishBlockers(el);
      if (blockers.length) {
        input.checked = false;
        this.error.set(`No se puede publicar "${el.name || el.id}": ` + blockers.join('; '));
        return;
      }
    }
    try {
      await this.svc.save({ ...el, enabled });
      this.elements.update((cur) => cur.map((x) => (x.id === el.id ? { ...x, enabled } : x)));
      this.error.set('');
    } catch (e: any) {
      input.checked = !enabled;
      this.error.set(e?.message ?? String(e));
    }
  }

  async remove(el: ArElement): Promise<void> {
    if (!confirm(`Eliminar "${el.name || '(sin nombre)'}"? Se intentara borrar tambien sus archivos.`)) return;
    try {
      await this.svc.deleteElement(el);
      this.elements.update((cur) => cur.filter((x) => x.id !== el.id));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    }
  }

  // ----------------------------------------------------------------- editor

  async newElement(): Promise<void> {
    this.creating.set(true);
    this.error.set('');
    try {
      // DRAFT-FIRST: the doc must exist before any Storage upload (rules).
      this.form = await this.svc.createDraft();
      this.freshDraft = true;
      this.narrationSource = 'namespace';
      this.reassignUid = '';
      this.reassignEmail = '';
      this.view.set('edit');
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.creating.set(false);
    }
  }

  editElement(el: ArElement): void {
    this.form = { ...el, assets: el.assets.map((a) => ({ ...a })), geo: el.geo ? { ...el.geo } : undefined };
    this.freshDraft = false;
    this.narrationSource = el.narrationContext && !el.ragNamespace ? 'context' : 'namespace';
    this.reassignUid = '';
    this.reassignEmail = '';
    this.error.set('');
    this.view.set('edit');
  }

  onGeo(geo: ArGeoPoint): void {
    if (this.form) this.form.geo = geo;
  }

  async onPatternFile(ev: Event): Promise<void> {
    if (!this.form) return;
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.patUploading.set(true);
    this.patProgress.set(null);
    this.error.set('');
    try {
      this.form.patternUrl = await this.svc.uploadPattern(this.form.id, file, (p) => this.patProgress.set(p));
      await this.persistAssets(); // persists the patternUrl too
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.patUploading.set(false);
    }
  }

  /** Persist the current form quietly (asset uploads/removals + pattern). Keeps
   *  Firestore in sync with Storage without waiting for the Save button. */
  async persistAssets(): Promise<void> {
    if (!this.form) return;
    this.freshDraft = false;
    try {
      await this.svc.save(this.applyNarrationXor({ ...this.form }));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    }
  }

  async save(): Promise<void> {
    if (!this.form) return;
    if (!(this.form.name || '').trim()) {
      this.error.set('El nombre es obligatorio.');
      return;
    }
    if (this.form.enabled) {
      const blockers = this.blockers();
      if (blockers.length) {
        this.error.set('No se puede publicar: ' + blockers.join('; '));
        return;
      }
    }
    this.saving.set(true);
    this.error.set('');
    try {
      await this.svc.save(this.applyNarrationXor({ ...this.form }));
      this.freshDraft = false;
      await this.reload();
      this.view.set('list');
      this.form = null;
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.saving.set(false);
    }
  }

  async cancel(): Promise<void> {
    // Best-effort cleanup of a pristine draft. Abandoned drafts remain visible
    // in the list with the "Borrador" badge (no background cleanup job in POC).
    if (this.form && this.freshDraft && !(this.form.name || '').trim() && !this.form.assets.length) {
      try {
        await this.svc.deleteElement(this.form);
      } catch {
        /* leave the draft; it stays listed as Borrador */
      }
    }
    this.form = null;
    this.error.set('');
    this.view.set('list');
    await this.reload();
  }

  async reassign(): Promise<void> {
    if (!this.form || !this.isAdmin()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.svc.reassignOwner(this.form.id, this.reassignUid.trim(), this.reassignEmail.trim());
      this.form.ownerUid = this.reassignUid.trim();
      this.form.ownerEmail = this.reassignEmail.trim();
      this.reassignUid = '';
      this.reassignEmail = '';
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.saving.set(false);
    }
  }

  /** Enforce the ragNamespace XOR narrationContext rule based on the selected
   *  narration source before persisting. */
  private applyNarrationXor(el: ArElement): ArElement {
    if (this.narrationSource === 'namespace') el.narrationContext = undefined;
    else el.ragNamespace = undefined;
    return el;
  }
}
