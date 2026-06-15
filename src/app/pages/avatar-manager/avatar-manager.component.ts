import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AvatarManagerService } from '../../services/avatar-manager.service';
import { AdminService } from '../../services/admin.service';
import { GlbViewerComponent } from './components/glb-viewer.component';
import { Avatar, AvatarMeshStats } from '../../lib/avatars/avatar.models';
import { RigReport, conformanceLabel } from '../../lib/avatars/rig-spec';
import { PIPER_VOICES, TtsLang } from '../../services/tts-lipsync.service';
import { environment } from '../../../environments/environment';

interface VoiceOpt { id: string; label: string; }

/**
 * Avatar Manager (admin) -- CRUD for the reusable visual `avatars/{id}` catalog.
 *
 * Route: /avatar-manager (admin-gated, consistent with /rag-admin). VISUAL ONLY:
 * model + thumbnail + default voice + rig info. Persona/RAG/"Live in production"
 * belong to ASSISTANTS (assistants/{id}), NOT here -- the assistant editor would
 * pick an avatarId from this catalog and add persona/voice/RAG.
 *
 * Decorative mockup elements intentionally OMITTED: Pipelines/Team/Billing/
 * Marketplace nav, the optimization/CDN "pipeline sequence", and the fake
 * Total-Storage/Active-Context/Avg-Latency stat tiles.
 */
@Component({
  selector: 'app-avatar-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, GlbViewerComponent],
  template: `
    <div class="wrap">
      <header class="bar">
        <div class="brand"><span class="logo">AV</span> Avatar Manager</div>
        <nav class="topnav">
          <a routerLink="/home">Home</a>
          <a routerLink="/assistants">Assistants</a>
          <a routerLink="/assistant-manager">Assistant Mgr</a>
          <a routerLink="/text-avatar">Text-Avatar</a>
          <a routerLink="/rag-admin">RAG Admin</a>
        </nav>
      </header>

      <div class="denied" *ngIf="!allowed()">You do not have admin access to this panel.</div>

      <main class="main" *ngIf="allowed()">
        <!-- ================= INVENTORY ================= -->
        <ng-container *ngIf="view() === 'list'">
          <div class="head">
            <div>
              <h1>Inventory View</h1>
              <p class="sub">Manage your reusable avatar models. Each avatar is a 3D model + thumbnail + default voice; assistants reference one and add their RAG + persona.</p>
            </div>
            <button class="btn primary" (click)="newAvatar()">+ New Avatar</button>
          </div>

          <div class="grid" *ngIf="loading()">
            <div class="card skel" *ngFor="let s of [1,2,3,4]"><div class="sk-thumb"></div><div class="sk-l w60"></div><div class="sk-l"></div></div>
          </div>

          <div class="empty" *ngIf="!loading() && !avatars().length">
            <div class="empty-icon">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/></svg>
            </div>
            <h2>No avatars yet</h2>
            <p>Upload your first model to build the catalog.</p>
            <button class="btn primary" (click)="newAvatar()">+ New Avatar</button>
          </div>

          <div class="grid" *ngIf="!loading() && avatars().length">
            <div class="card" *ngFor="let a of avatars()">
              <div class="portrait">
                <img *ngIf="thumb(a.id)" [src]="thumb(a.id)!" [alt]="a.name" />
                <span *ngIf="!thumb(a.id)" class="ph">
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>
                </span>
              </div>
              <div class="c-name">{{ a.name }}</div>
              <div class="c-desc">{{ a.description }}</div>
              <div class="chips">
                <span class="chip" [title]="a.defaultVoice">{{ a.defaultVoice || 'Default Voice' }}</span>
                <span class="chip" *ngIf="a.sizeBytes">{{ fmtSize(a.sizeBytes) }}</span>
                <span class="chip rig" *ngIf="a.rigVersion">{{ a.rigVersion }}</span>
              </div>
              <div class="c-actions">
                <button class="link" (click)="editAvatar(a)">Edit</button>
                <button class="link danger" (click)="remove(a)">Delete</button>
              </div>
            </div>
          </div>
          <p class="err" *ngIf="svc.error()">{{ svc.error() }}</p>
        </ng-container>

        <!-- ================= CREATE / EDIT ================= -->
        <ng-container *ngIf="view() === 'edit'">
          <div class="head">
            <h1>{{ form.id ? 'Edit Avatar' : 'New Avatar' }}</h1>
            <button class="btn ghost" (click)="cancel()">Back to inventory</button>
          </div>

          <div class="editor">
            <!-- LEFT: viewer + metadata -->
            <section class="col-main">
              <div class="viewport">
                <app-glb-viewer [url]="glbUrl()"
                                (meshStats)="onMeshStats($event)"
                                (rigReport)="onRigReport($event)"></app-glb-viewer>
              </div>

              <div class="panels">
                <div class="panel">
                  <h3>Mesh Metadata</h3>
                  <div class="row"><span>Vertices</span><b>{{ form.meshStats?.vertices != null ? (form.meshStats!.vertices | number) : '-' }}</b></div>
                  <div class="row"><span>Polygons</span><b>{{ form.meshStats?.polygons != null ? (form.meshStats!.polygons | number) : '-' }}</b></div>
                  <div class="row"><span>Skeleton</span><b>{{ form.meshStats?.skeletonType || '-' }}</b></div>
                </div>

                <div class="panel">
                  <h3>Rig Compatibility</h3>
                  <div class="rig-badge" [ngClass]="rigClass()">{{ rigLabel() }}</div>
                  <div class="rig-detail" *ngIf="rig() as r">
                    {{ r.matchedArkit.length }}/52 ARKit blendshapes, head bone: {{ r.hasHeadBone ? 'yes' : 'no' }}
                  </div>
                  <div class="rig-warn" *ngFor="let w of (rig()?.warnings || [])">! {{ w }}</div>
                  <p class="hint">Compatibility is informational -- partial avatars still save (lipsync/gestures degrade).</p>
                </div>

                <div class="panel">
                  <h3>GLB Model</h3>
                  <p class="hint">PBR textures, 2k resolution recommended for web.</p>
                  <label class="filebtn">
                    {{ uploading() ? 'Uploading ' + uploadPct() + '%' : (form.glbPath ? 'Replace model' : 'Upload GLB') }}
                    <input type="file" accept=".glb,model/gltf-binary" (change)="onGlb($event)" hidden />
                  </label>
                  <div class="pbar" *ngIf="uploading()"><i [style.width.%]="uploadPct()"></i></div>
                  <div class="fname" *ngIf="form.glbPath">{{ form.glbPath }} <span *ngIf="form.sizeBytes">({{ fmtSize(form.sizeBytes) }})</span></div>
                </div>
              </div>
            </section>

            <!-- RIGHT: profile form -->
            <aside class="col-side">
              <h3>Edit Avatar Profile</h3>

              <div class="visual">
                <span class="vlabel">Visual Identity</span>
                <div class="vthumb">
                  <img *ngIf="thumbUrl()" [src]="thumbUrl()!" alt="thumbnail" />
                  <span *ngIf="!thumbUrl()" class="ph">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.6"/><path d="M21 17l-5-5L5 21"/></svg>
                  </span>
                </div>
                <label class="filebtn sm">
                  {{ thumbUploading() ? 'Uploading...' : 'Upload thumbnail' }}
                  <input type="file" accept="image/*" (change)="onThumb($event)" hidden />
                </label>
              </div>

              <label class="fld"><span>Avatar Name</span>
                <input type="text" [(ngModel)]="form.name" placeholder="e.g. Aurora-01" [disabled]="!!form.id" />
              </label>
              <p class="hint" *ngIf="!form.id">The name becomes the model id/filename. Choose it before uploading the GLB.</p>

              <label class="fld"><span>Description</span>
                <textarea rows="3" [(ngModel)]="form.description" placeholder="One-line description"></textarea>
              </label>

              <label class="fld"><span>Default Voice</span>
                <select [(ngModel)]="form.defaultVoice">
                  <option value="">- none -</option>
                  <option *ngFor="let v of voices" [value]="v.id">{{ v.label }}</option>
                </select>
              </label>

              <p class="note">Personality / RAG / "Live in production" are configured on the <b>assistant</b> that uses this avatar, not here.</p>

              <div class="actions">
                <button class="btn primary" (click)="save()" [disabled]="!canSave()">{{ saving() ? 'Saving...' : 'Save' }}</button>
                <button class="btn ghost" (click)="cancel()">Cancel</button>
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
    .who { display: flex; gap: 8px; }
    .topnav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .topnav a { color: #c7ccd6; text-decoration: none; font-size: 13px; padding: 7px 12px; border-radius: 8px; border: 1px solid transparent; }
    .topnav a:hover { background: rgba(255,255,255,.06); color: #fff; border-color: rgba(255,255,255,.1); }
    .denied { margin: 80px auto; color: #ffb3b3; text-align: center; }

    .main { flex: 1; min-height: 0; overflow-y: auto; width: 100%; max-width: 1240px; margin: 0 auto; padding: 28px 24px 64px; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    h1 { font-size: 30px; font-weight: 800; margin: 0 0 6px; }
    .sub { color: #8b93a3; font-size: 14px; max-width: 720px; line-height: 1.5; margin: 0; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 18px; }
    .card { background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 22px 18px; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .portrait { width: 92px; height: 92px; border-radius: 50%; overflow: hidden; display: grid; place-items: center; margin-bottom: 6px;
      border: 2px solid rgba(139,92,246,.5); background: radial-gradient(circle at 50% 30%, rgba(139,92,246,.4), rgba(139,92,246,.05)); }
    .portrait img { width: 100%; height: 100%; object-fit: cover; }
    .ph { color: #c4b0f7; opacity: .85; }
    .c-name { font-size: 17px; font-weight: 700; }
    .c-desc { font-size: 12.5px; color: #9aa2b1; line-height: 1.45; min-height: 36px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin: 4px 0; }
    .chip { font-size: 10.5px; color: #aab; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); border-radius: 999px; padding: 2px 9px; }
    .chip.rig { color: #6ee7b7; background: rgba(52,211,153,.12); border-color: rgba(52,211,153,.3); }
    .c-actions { display: flex; gap: 14px; margin-top: 8px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.07); width: 100%; justify-content: center; }
    .link { background: none; border: none; color: #c4b0f7; cursor: pointer; font-size: 13px; }
    .link.danger { color: #ffb3b3; }
    .link:hover { text-decoration: underline; }

    .skel { pointer-events: none; }
    .sk-thumb { width: 92px; height: 92px; border-radius: 50%; }
    .sk-thumb, .sk-l { background: linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.1), rgba(255,255,255,.05)); background-size: 200% 100%; animation: sh 1.3s infinite; border-radius: 8px; }
    .sk-l { height: 12px; width: 80%; margin-top: 8px; } .sk-l.w60 { width: 60%; }
    @keyframes sh { to { background-position: -200% 0; } }

    .empty { text-align: center; margin: 70px auto; max-width: 420px; }
    .empty-icon { width: 60px; height: 60px; margin: 0 auto 14px; display: grid; place-items: center; border-radius: 16px; background: rgba(255,255,255,.04); color: #6b7384; }
    .empty h2 { margin: 0 0 6px; }
    .empty p { color: #8b93a3; margin: 0 0 16px; }

    /* editor */
    .editor { display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; align-items: start; }
    .col-main { display: flex; flex-direction: column; gap: 16px; }
    .viewport { height: 420px; }
    .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .panel { background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 16px; }
    .panel h3 { margin: 0 0 10px; font-size: 14px; }
    .row { display: flex; justify-content: space-between; font-size: 12.5px; padding: 5px 0; color: #9aa2b1; border-bottom: 1px solid rgba(255,255,255,.05); }
    .row b { color: #e6e8ee; font-family: ui-monospace, Menlo, monospace; }
    .rig-badge { display: inline-block; font-size: 12px; padding: 4px 11px; border-radius: 999px; margin-bottom: 8px; }
    .rig-badge.ok { background: rgba(52,211,153,.16); color: #6ee7b7; }
    .rig-badge.remap { background: rgba(138,180,248,.16); color: #8ab4f8; }
    .rig-badge.partial { background: rgba(217,164,64,.18); color: #f0c674; }
    .rig-badge.bad { background: rgba(248,113,113,.16); color: #fca5a5; }
    .rig-badge.none { background: rgba(255,255,255,.08); color: #aab; }
    .rig-detail { font-size: 12px; color: #9aa2b1; }
    .rig-warn { font-size: 11px; color: #f0c674; margin-top: 6px; line-height: 1.4; }

    .col-side { background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 18px; position: sticky; top: 16px; }
    .col-side h3 { margin: 0 0 14px; color: #c4b0f7; }
    .visual { margin-bottom: 14px; }
    .vlabel { font-size: 10.5px; letter-spacing: .6px; text-transform: uppercase; color: #6b7384; }
    .vthumb { width: 100%; height: 160px; border-radius: 12px; overflow: hidden; margin: 8px 0; display: grid; place-items: center;
      background: radial-gradient(circle at 50% 30%, rgba(139,92,246,.3), rgba(139,92,246,.05)); border: 1px solid rgba(255,255,255,.1); }
    .vthumb img { width: 100%; height: 100%; object-fit: cover; }
    .fld { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #99a; margin-bottom: 12px; }
    .fld input, .fld textarea, .fld select { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; padding: 9px 11px; font-size: 13px; }
    .fld input:disabled { opacity: .6; }
    .note { font-size: 11.5px; color: #8b93a3; line-height: 1.5; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07); border-radius: 9px; padding: 9px 11px; }
    .note b { color: #c4b0f7; }
    .actions { display: flex; gap: 10px; margin-top: 14px; }

    .filebtn { display: inline-block; cursor: pointer; font-size: 12.5px; text-align: center; background: rgba(139,92,246,.14); border: 1px dashed rgba(139,92,246,.4); color: #c4b0f7; border-radius: 9px; padding: 9px 12px; }
    .filebtn.sm { width: 100%; padding: 7px; font-size: 12px; }
    .pbar { height: 6px; margin-top: 8px; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; }
    .pbar i { display: block; height: 100%; background: var(--accent); transition: width .15s; }
    .fname { font-size: 10.5px; color: #6b7384; margin-top: 6px; overflow-wrap: anywhere; }
    .hint { font-size: 11px; color: #6b7384; line-height: 1.45; margin: 6px 0; }
    .err { color: #ff9c9c; font-size: 12.5px; margin-top: 10px; }

    .btn { padding: 9px 16px; border-radius: 9px; cursor: pointer; font-size: 13px; background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; text-decoration: none; display: inline-block; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); color: #cdd; }
    .btn.sm { padding: 6px 12px; font-size: 12px; }
    @media (max-width: 900px) { .editor { grid-template-columns: 1fr; } .panels { grid-template-columns: 1fr; } .col-side { position: static; } }
  `]
})
export class AvatarManagerComponent implements OnInit {
  svc = inject(AvatarManagerService);
  admin = inject(AdminService);

  readonly avatars = signal<Avatar[]>([]);
  readonly loading = signal(true);
  readonly view = signal<'list' | 'edit'>('list');
  readonly glbUrl = signal<string | null>(null);
  readonly thumbUrl = signal<string | null>(null);
  readonly uploading = signal(false);
  readonly uploadPct = signal(0);
  readonly thumbUploading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly rig = signal<RigReport | null>(null);
  private thumbs = signal<Record<string, string | null>>({});

  voices: VoiceOpt[] = this.buildVoices();

  form: Avatar = this.blank();

  /** Files chosen in the form, uploaded to Storage on Save (preview is local). */
  private pendingGlb: File | null = null;
  private pendingThumb: File | null = null;
  /** object: URLs created for local preview; revoked when replaced/left. */
  private objectUrls: string[] = [];

  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (this.allowed()) await this.reload();
  }

  private blank(): Avatar {
    return { id: '', name: '', description: '', glbPath: '', defaultVoice: '' };
  }

  private buildVoices(): VoiceOpt[] {
    const out: VoiceOpt[] = [];
    for (const lang of ['es', 'en'] as TtsLang[]) {
      for (const v of PIPER_VOICES[lang]) out.push({ id: v.id, label: `${v.label} (${lang.toUpperCase()})` });
    }
    return out;
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const list = await this.svc.listAvatars();
      this.avatars.set(list);
      for (const a of list) {
        this.svc.resolveUrl(a.thumbnailPath)
          .then((u) => this.thumbs.update((m) => ({ ...m, [a.id]: u })))
          .catch(() => {});
      }
    } finally {
      this.loading.set(false);
    }
  }

  thumb(id: string): string | null { return this.thumbs()[id] ?? null; }

  newAvatar(): void {
    this.revokeUrls();
    this.pendingGlb = null;
    this.pendingThumb = null;
    this.form = this.blank();
    this.glbUrl.set(null);
    this.thumbUrl.set(null);
    this.rig.set(null);
    this.error.set('');
    this.view.set('edit');
  }

  async editAvatar(a: Avatar): Promise<void> {
    this.revokeUrls();
    this.pendingGlb = null;
    this.pendingThumb = null;
    this.form = { ...a };
    this.rig.set(null);
    this.error.set('');
    this.view.set('edit');
    this.glbUrl.set(await this.svc.resolveUrl(a.glbPath));
    this.thumbUrl.set(await this.svc.resolveUrl(a.thumbnailPath));
  }

  cancel(): void {
    this.revokeUrls();
    this.pendingGlb = null;
    this.pendingThumb = null;
    this.view.set('list');
  }

  private revokeUrls(): void {
    for (const u of this.objectUrls) {
      try { URL.revokeObjectURL(u); } catch { /* ignore */ }
    }
    this.objectUrls = [];
  }

  /**
   * Choose a GLB: preview it IMMEDIATELY from a local object URL (no name/upload
   * needed) so the viewport renders + emits mesh stats/rig report right away. The
   * file is uploaded to Storage on Save. GLB load errors surface in the viewport.
   */
  onGlb(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!/\.glb$/i.test(file.name) && file.type !== 'model/gltf-binary') {
      this.error.set('Please choose a .glb model file.');
      return;
    }
    this.error.set('');
    this.pendingGlb = file;
    this.form.sizeBytes = file.size;
    const url = URL.createObjectURL(file);
    this.objectUrls.push(url);
    this.glbUrl.set(url); // viewer loads the local file -> emits stats + rig report
  }

  /** Choose a thumbnail: preview locally; uploaded on Save. */
  onThumb(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    this.pendingThumb = file;
    const url = URL.createObjectURL(file);
    this.objectUrls.push(url);
    this.thumbUrl.set(url);
  }

  onMeshStats(s: AvatarMeshStats): void {
    this.form.meshStats = s;
  }

  onRigReport(r: RigReport): void {
    this.rig.set(r);
    this.form.rigVersion = this.deriveRigVersion(r);
  }

  private deriveRigVersion(r: RigReport): string {
    switch (r.conformance) {
      case 'full': return 'arkit-52';
      case 'remapped': return 'arkit-52 (remapped)';
      case 'partial': return 'partial';
      default: return 'incompatible';
    }
  }

  rigClass(): string {
    const c = this.rig()?.conformance;
    return c === 'full' ? 'ok' : c === 'remapped' ? 'remap' : c === 'partial' ? 'partial' : c === 'incompatible' ? 'bad' : 'none';
  }
  rigLabel(): string {
    const r = this.rig();
    if (!r) return 'Load a model to check compatibility';
    if (r.conformance === 'full') return 'Fully compatible';
    if (r.conformance === 'remapped') return 'Compatible (remapped)';
    if (r.conformance === 'partial') return `Partial -- ${r.missingMouth.length} mouth morph(s) missing`;
    return 'Needs remapping / incompatible';
  }

  canSave(): boolean {
    const hasModel = !!this.pendingGlb || !!this.form.glbPath;
    return !!this.form.name.trim() && hasModel && !this.uploading() && !this.saving();
  }

  /** Save: derive id from name, upload pending GLB + thumbnail (with progress), then write the doc. */
  async save(): Promise<void> {
    if (!this.canSave()) return;
    const id = this.form.id || this.svc.slugId(this.form.name);
    if (!id) { this.error.set('Enter a valid avatar name.'); return; }
    this.form.id = id;
    this.saving.set(true);
    this.error.set('');
    try {
      if (this.pendingGlb) {
        this.uploading.set(true);
        this.uploadPct.set(0);
        const { glbPath, sizeBytes } = await this.svc.uploadGlb(id, this.pendingGlb, (p) => this.uploadPct.set(p.percent));
        this.form.glbPath = glbPath;
        this.form.sizeBytes = sizeBytes;
        this.uploading.set(false);
        this.pendingGlb = null;
      }
      if (this.pendingThumb) {
        this.thumbUploading.set(true);
        this.form.thumbnailPath = await this.svc.uploadThumbnail(id, this.pendingThumb);
        this.thumbUploading.set(false);
        this.pendingThumb = null;
      }
      await this.svc.save(this.form);
      await this.reload();
      this.revokeUrls();
      this.view.set('list');
    } catch (err: any) {
      this.error.set(err?.message ?? String(err));
    } finally {
      this.uploading.set(false);
      this.thumbUploading.set(false);
      this.saving.set(false);
    }
  }

  async remove(a: Avatar): Promise<void> {
    if (!confirm(`Delete avatar "${a.name}"? This removes its model + thumbnail. Assistants referencing it will need a new avatar.`)) return;
    try {
      await this.svc.deleteAvatar(a);
      this.avatars.update((cur) => cur.filter((x) => x.id !== a.id));
    } catch (err: any) {
      this.error.set(err?.message ?? String(err));
    }
  }

  fmtSize(bytes?: number): string {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // conformanceLabel re-export available if a fuller label is wanted in future.
  protected readonly conformanceLabel = conformanceLabel;
}
