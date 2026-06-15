import { Component, Input, OnChanges, SimpleChanges, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RagAdminService } from '../../../services/rag-admin.service';
import { MediaType, RagDocument, RagMediaRecord } from '../../../lib/rag/rag-admin.models';

/**
 * Media association manager for rag/{namespace}/media (card-grid design).
 *
 * Upload images/videos + create metadata records matching the Text-Avatar popup
 * gallery shape (MediaItem: id, type, title, caption?, storagePath,
 * thumbnailPath?). The public client fetches bytes from Storage on open; here we
 * only manage metadata.
 *
 * PLACEHOLDERS (data not in the RagMediaRecord model, so not shown / not faked):
 *  - per-asset file SIZE and a real THUMBNAIL preview are not stored, so cards
 *    show a type-badge placeholder tile instead of a rendered thumbnail, and no
 *    size. Date shows only when createdAt exists.
 *  - Filter/Sort are not implemented here (the parent renders cosmetic ones).
 */
@Component({
  selector: 'app-rag-media-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="mm">
      <div class="mm-bar">
        <span class="mm-count" *ngIf="media().length">{{ media().length }} item(s)</span>
        <button class="btn primary" (click)="showForm.set(!showForm())">
          {{ showForm() ? 'Close' : '+ Upload media' }}
        </button>
      </div>

      <!-- Upload form (collapsible) -->
      <div class="mm-form" *ngIf="showForm()">
        <div class="mm-row">
          <label class="fld">
            <span>Type</span>
            <select [(ngModel)]="form.type">
              <option value="image">image</option>
              <option value="video">video</option>
            </select>
          </label>
          <label class="fld grow">
            <span>Title</span>
            <input type="text" [(ngModel)]="form.title" placeholder="Shown in the popup" />
          </label>
        </div>
        <label class="fld">
          <span>Caption (optional)</span>
          <input type="text" [(ngModel)]="form.caption" placeholder="Short description" />
        </label>
        <label class="fld">
          <span>Link to document (optional)</span>
          <select [(ngModel)]="form.linkedDocId">
            <option [ngValue]="undefined">- none -</option>
            <option *ngFor="let d of documents" [ngValue]="d.id">{{ d.filename }}</option>
          </select>
        </label>
        <div class="mm-row">
          <label class="filebtn">
            {{ file?.name || 'Choose asset (image/video)' }}
            <input type="file" accept="image/*,video/*" (change)="onFile($event)" hidden />
          </label>
          <label class="filebtn ghost">
            {{ thumb?.name || 'Thumbnail (optional)' }}
            <input type="file" accept="image/*" (change)="onThumb($event)" hidden />
          </label>
        </div>
        <div class="mm-actions">
          <button class="btn primary" (click)="upload()" [disabled]="!canUpload()">
            {{ uploading() ? 'Uploading ' + progress() + '%' : 'Upload + create record' }}
          </button>
          <div class="bar" *ngIf="uploading()"><i [style.width.%]="progress()"></i></div>
        </div>
        <div class="mm-err" *ngIf="error()">{{ error() }}</div>
      </div>

      <!-- loading -->
      <div class="state sm" *ngIf="loading()"><span class="spin"></span><p>Loading media...</p></div>

      <!-- empty -->
      <div class="mm-empty" *ngIf="!loading() && !media().length">
        <div class="me-icon">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.6"/><path d="M21 17l-5-5L5 21"/>
          </svg>
        </div>
        <div class="me-title">No media yet</div>
        <div class="me-text">Upload images or videos to show in the Text-Avatar popups for this namespace.</div>
        <button class="btn primary" (click)="showForm.set(true)">+ Upload media</button>
      </div>

      <!-- grid -->
      <div class="mm-grid" *ngIf="!loading() && media().length">
        <div class="mcard" *ngFor="let m of media()">
          <div class="thumb" [class.vid]="m.type === 'video'">
            <span class="kind">{{ m.type }}</span>
            <span class="play" *ngIf="m.type === 'video'">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </span>
          </div>

          <ng-container *ngIf="editingId() !== m.id">
            <div class="m-tt" [title]="m.title">{{ m.title }}</div>
            <div class="m-cap" *ngIf="m.caption">{{ m.caption }}</div>
            <div class="m-meta">
              <span *ngIf="m.createdAt">{{ fmtDate(m.createdAt) }}</span>
              <span class="m-link" *ngIf="m.linkedDocId" [title]="m.linkedDocId">linked</span>
            </div>
            <div class="m-ctl">
              <button class="btn ghost sm" (click)="startEdit(m)">Edit</button>
              <button class="btn danger sm" (click)="remove(m)">Delete</button>
            </div>
          </ng-container>

          <ng-container *ngIf="editingId() === m.id">
            <input class="ed" type="text" [(ngModel)]="edit.title" placeholder="Title" />
            <input class="ed" type="text" [(ngModel)]="edit.caption" placeholder="Caption" />
            <select class="ed" [(ngModel)]="edit.type">
              <option value="image">image</option>
              <option value="video">video</option>
            </select>
            <div class="m-ctl">
              <button class="btn primary sm" (click)="saveEdit(m)">Save</button>
              <button class="btn ghost sm" (click)="cancelEdit()">Cancel</button>
            </div>
          </ng-container>
        </div>

        <!-- trailing drop tile -->
        <label class="mcard drop">
          <input type="file" accept="image/*,video/*" (change)="onFile($event); showForm.set(true)" hidden />
          <span class="drop-plus">+</span>
          <span class="drop-text">Drop more assets here</span>
        </label>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mm { display: flex; flex-direction: column; gap: 14px; }
    .mm-bar { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
    .mm-count { margin-right: auto; font-size: 12px; color: #8b93a3; }

    .mm-form { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
      border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .mm-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .fld { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: #8b93a3; }
    .fld.grow { flex: 1; min-width: 160px; }
    .fld input, .fld select { background: rgba(255,255,255,.05); color: #e6e8ee;
      border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; }
    .filebtn { flex: 1; min-width: 180px; text-align: center; cursor: pointer; font-size: 12px;
      background: rgba(139,92,246,.14); border: 1px dashed rgba(139,92,246,.4); color: #c4b0f7;
      border-radius: 8px; padding: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .filebtn.ghost { background: rgba(255,255,255,.04); border-color: rgba(255,255,255,.15); color: #aab; }
    .mm-actions { display: flex; align-items: center; gap: 12px; }
    .bar { flex: 1; height: 6px; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; }
    .bar i { display: block; height: 100%; background: #8b5cf6; transition: width .15s; }
    .mm-err { color: #ff9c9c; font-size: 12px; }

    .state { display: flex; flex-direction: column; align-items: center; gap: 10px; color: #8b93a3; font-size: 13px; }
    .state.sm { margin: 18px 0; }
    .spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.15); border-top-color: #8b5cf6;
      border-radius: 50%; display: inline-block; animation: mmspin 1s linear infinite; }
    @keyframes mmspin { to { transform: rotate(360deg); } }

    .mm-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
      min-height: 240px; text-align: center; }
    .me-icon { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 14px;
      background: rgba(255,255,255,.04); color: #6b7384; margin-bottom: 8px; }
    .me-title { font-size: 15px; font-weight: 600; color: #d7dae2; }
    .me-text { font-size: 13px; color: #8b93a3; margin-bottom: 12px; max-width: 360px; }

    .mm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    .mcard { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 12px;
      padding: 10px; display: flex; flex-direction: column; gap: 6px; }
    .thumb { position: relative; height: 120px; border-radius: 9px; display: grid; place-items: center;
      background: linear-gradient(135deg, rgba(139,92,246,.18), rgba(139,92,246,.04)); overflow: hidden; }
    .thumb.vid { background: linear-gradient(135deg, rgba(80,90,120,.35), rgba(20,24,35,.6)); }
    .kind { position: absolute; left: 8px; bottom: 8px; font-size: 10.5px; padding: 2px 8px; border-radius: 6px;
      background: rgba(139,92,246,.3); color: #e6defc; }
    .play { color: #fff; opacity: .9; display: grid; place-items: center; width: 40px; height: 40px;
      border-radius: 50%; background: rgba(0,0,0,.4); border: 1px solid rgba(255,255,255,.5); }
    .m-tt { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-cap { font-size: 11.5px; color: #9aa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-meta { display: flex; gap: 8px; font-size: 10.5px; color: #6b7384; }
    .m-link { color: #8ab4f8; }
    .ed { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12);
      border-radius: 7px; padding: 6px 8px; font-size: 12px; }
    .m-ctl { display: flex; gap: 6px; margin-top: 2px; }

    .mcard.drop { align-items: center; justify-content: center; cursor: pointer; min-height: 180px;
      border: 1.5px dashed rgba(255,255,255,.18); background: transparent; gap: 8px; }
    .mcard.drop:hover { border-color: rgba(139,92,246,.5); background: rgba(139,92,246,.05); }
    .drop-plus { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 50%;
      background: rgba(255,255,255,.06); font-size: 20px; color: #aeb4c0; }
    .drop-text { font-size: 12px; color: #8b93a3; }

    .btn { padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px;
      background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: #8b5cf6; border-color: #8b5cf6; color: #fff; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); color: #cdd; }
    .btn.danger { background: rgba(179,57,57,.2); border-color: rgba(179,57,57,.5); color: #ffb3b3; }
    .btn.sm { padding: 4px 9px; font-size: 11.5px; }
  `]
})
export class RagMediaManagerComponent implements OnChanges {
  @Input({ required: true }) namespace!: string;
  /** documents for the optional link dropdown */
  @Input() documents: RagDocument[] = [];

  private admin = inject(RagAdminService);

  readonly media = signal<RagMediaRecord[]>([]);
  readonly loading = signal(false);
  readonly uploading = signal(false);
  readonly progress = signal(0);
  readonly error = signal('');
  readonly editingId = signal<string | null>(null);
  /** UI-only: collapse/expand the upload form. */
  readonly showForm = signal(false);

  form: { type: MediaType; title: string; caption: string; linkedDocId?: string } = {
    type: 'image', title: '', caption: '', linkedDocId: undefined,
  };
  edit: { title: string; caption: string; type: MediaType } = { title: '', caption: '', type: 'image' };
  file: File | null = null;
  thumb: File | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['namespace']) this.reload();
  }

  async reload(): Promise<void> {
    if (!this.namespace) return;
    this.loading.set(true);
    try {
      this.media.set(await this.admin.listMedia(this.namespace));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  onFile(e: Event): void {
    this.file = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (this.file && !this.form.title) this.form.title = this.file.name;
    if (this.file) this.form.type = this.file.type.startsWith('video') ? 'video' : 'image';
  }
  onThumb(e: Event): void {
    this.thumb = (e.target as HTMLInputElement).files?.[0] ?? null;
  }

  canUpload(): boolean {
    return !!this.file && !!this.form.title.trim() && !this.uploading();
  }

  async upload(): Promise<void> {
    if (!this.canUpload() || !this.file) return;
    this.uploading.set(true);
    this.progress.set(0);
    this.error.set('');
    try {
      const rec = await this.admin.uploadMedia(
        this.namespace,
        this.file,
        { type: this.form.type, title: this.form.title, caption: this.form.caption, linkedDocId: this.form.linkedDocId },
        this.thumb ?? undefined,
        (p) => this.progress.set(p.percent),
      );
      this.media.update((cur) => [rec, ...cur]);
      this.file = null;
      this.thumb = null;
      this.form = { type: 'image', title: '', caption: '', linkedDocId: undefined };
      this.showForm.set(false);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.uploading.set(false);
    }
  }

  startEdit(m: RagMediaRecord): void {
    this.editingId.set(m.id);
    this.edit = { title: m.title, caption: m.caption ?? '', type: m.type };
  }
  cancelEdit(): void { this.editingId.set(null); }

  async saveEdit(m: RagMediaRecord): Promise<void> {
    try {
      await this.admin.updateMedia(this.namespace, m.id, {
        title: this.edit.title.trim() || m.title,
        caption: this.edit.caption.trim(),
        type: this.edit.type,
      });
      this.media.update((cur) =>
        cur.map((x) => (x.id === m.id ? { ...x, title: this.edit.title, caption: this.edit.caption, type: this.edit.type } : x)),
      );
      this.editingId.set(null);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    }
  }

  async remove(m: RagMediaRecord): Promise<void> {
    if (!confirm(`Delete media "${m.title}"? This removes the Storage asset and its record.`)) return;
    try {
      await this.admin.deleteMedia(m);
      this.media.update((cur) => cur.filter((x) => x.id !== m.id));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    }
  }

  fmtDate(ms?: number): string {
    return ms ? new Date(ms).toLocaleDateString() : '';
  }
}
