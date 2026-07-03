import { Component, EventEmitter, Input, Output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ArContentService, ArUploadProgress } from '../../../services/ar-content.service';
import {
  AR_ASSET_LIMITS_MB,
  AR_IMAGE_OPTIMIZE_THRESHOLD_MB,
  ArAsset,
  ArElement,
  defaultAssetAnimation,
  inferAssetType,
} from '../../../lib/ar/ar.models';
import { GlbViewerComponent } from '../../avatar-manager/components/glb-viewer.component';

/**
 * Assets section of the AR element editor: upload (with progress) to
 * ar-content/{elementId}/, per-asset preview (GLB via the shared Three.js
 * glb-viewer, image/video native), and per-asset config (animation clip,
 * autoplay, trajectory, triggers, scale, position). MIME + size validation
 * happens in ArContentService/ar.models before any byte is uploaded.
 *
 * The component mutates element.assets in place and emits (changed) so the
 * parent persists the doc right away (keeps Firestore + Storage consistent).
 */
@Component({
  selector: 'app-ar-asset-editor',
  standalone: true,
  imports: [CommonModule, FormsModule, GlbViewerComponent],
  template: `
    <div class="assets">
      <div class="uphead">
        <label class="btn primary sm">
          + Subir asset
          <input type="file" hidden (change)="onFile($event)"
                 accept=".glb,model/gltf-binary,image/*,video/*" />
        </label>
        <span class="hint">GLB &le; {{ limits.model }} MB, video &le; {{ limits.video }} MB, imagen &le; {{ limits.image }} MB (imagenes &gt; {{ optimizeThreshold }} MB se comprimen automaticamente sin perder calidad)</span>
      </div>

      <div class="prog" *ngIf="uploading()">
        <div class="bar"><i [style.width.%]="progress()?.percent ?? 0"></i></div>
        <span>{{ progress()?.percent ?? 0 }}%</span>
      </div>
      <p class="err" *ngIf="upErr()">{{ upErr() }}</p>

      <p class="hint" *ngIf="!element.assets.length && !uploading()">Sin assets. Sube un modelo GLB, una imagen o un video.</p>

      <div class="asset" *ngFor="let a of element.assets">
        <div class="ahead">
          <span class="chip" [class.model]="a.type==='model'" [class.video]="a.type==='video'">{{ a.type }}</span>
          <span class="aname" [title]="a.storagePath">{{ a.fileName || a.id }}</span>
          <span class="asize" *ngIf="a.sizeBytes">{{ (a.sizeBytes / 1048576) | number:'1.0-2' }} MB</span>
          <button class="btn ghost sm" type="button" (click)="togglePreview(a)">{{ previewing === a.id ? 'Ocultar' : 'Preview' }}</button>
          <button class="btn danger sm" type="button" (click)="remove(a)">Quitar</button>
        </div>

        <div class="apreview" *ngIf="previewing === a.id">
          <ng-container *ngIf="url(a) as u; else loadingTpl">
            <app-glb-viewer *ngIf="a.type === 'model'" [url]="u"></app-glb-viewer>
            <img *ngIf="a.type === 'image'" [src]="u" crossorigin="anonymous" alt="asset" />
            <video *ngIf="a.type === 'video'" [src]="u" crossorigin="anonymous" controls playsinline></video>
          </ng-container>
          <ng-template #loadingTpl><p class="hint">Resolviendo URL...</p></ng-template>
        </div>

        <div class="acfg">
          <ng-container *ngIf="a.type === 'model'">
            <label class="fld"><span>Clip de animacion (nombre en el GLB; vacio = primero)</span>
              <input type="text" [(ngModel)]="anim(a).clip" (change)="emitChanged()" placeholder="walk" />
            </label>
          </ng-container>
          <label class="toggle"><input type="checkbox" [(ngModel)]="anim(a).autoplay" (change)="emitChanged()" /> <span>Autoplay</span></label>
          <label class="fld"><span>Trayectoria</span>
            <select [ngModel]="anim(a).path ?? ''" (ngModelChange)="setPath(a, $event)">
              <option value="">Estatico</option>
              <option value="orbit">Orbita</option>
              <option value="line">Linea</option>
            </select>
          </label>
          <label class="fld"><span>Triggers (separados por coma)</span>
            <input type="text" [ngModel]="triggersText(a)" (blur)="setTriggers(a, $event)" placeholder="play-anim, wave" />
          </label>
          <label class="fld"><span>Escala</span>
            <input type="number" step="0.05" min="0.01" [(ngModel)]="a.scale" (change)="emitChanged()" placeholder="1" />
          </label>
          <div class="posrow">
            <label class="fld"><span>Pos X</span><input type="number" step="0.1" [(ngModel)]="pos(a).x" (change)="emitChanged()" /></label>
            <label class="fld"><span>Pos Y</span><input type="number" step="0.1" [(ngModel)]="pos(a).y" (change)="emitChanged()" /></label>
            <label class="fld"><span>Pos Z</span><input type="number" step="0.1" [(ngModel)]="pos(a).z" (change)="emitChanged()" /></label>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .assets { display: flex; flex-direction: column; gap: 12px; }
    .uphead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .hint { font-size: 11px; color: #6b7384; margin: 0; }
    .err { color: #ff9c9c; font-size: 12px; margin: 0; }
    .prog { display: flex; align-items: center; gap: 10px; }
    .prog .bar { flex: 1; height: 7px; background: rgba(255,255,255,.08); border-radius: 999px; overflow: hidden; }
    .prog .bar i { display: block; height: 100%; background: #8b5cf6; }
    .prog span { font-size: 11.5px; color: #aeb4c0; }
    .asset { border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: rgba(255,255,255,.02); }
    .ahead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .chip { font-size: 10.5px; padding: 2px 9px; border-radius: 999px; background: rgba(110,231,183,.14); border: 1px solid rgba(110,231,183,.4); color: #6ee7b7; text-transform: uppercase; }
    .chip.model { background: rgba(139,92,246,.16); border-color: rgba(139,92,246,.4); color: #c4b0f7; }
    .chip.video { background: rgba(96,165,250,.14); border-color: rgba(96,165,250,.4); color: #93c5fd; }
    .aname { flex: 1; min-width: 120px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .asize { font-size: 11px; color: #8b93a3; }
    .apreview { border-radius: 10px; overflow: hidden; background: #0d1119; }
    .apreview img, .apreview video { max-width: 100%; max-height: 260px; display: block; margin: 0 auto; }
    .apreview app-glb-viewer { display: block; height: 280px; }
    .acfg { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
    .fld { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: #99a; }
    .fld input, .fld select { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 6px 9px; font-size: 12.5px; max-width: 190px; }
    .fld input[type=number] { width: 84px; }
    .posrow { display: flex; gap: 8px; }
    .toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #aeb4c0; cursor: pointer; }
    .btn { padding: 7px 12px; border-radius: 8px; cursor: pointer; font-size: 12px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: #cdd; }
    .btn.primary { background: #8b5cf6; border-color: #8b5cf6; color: #fff; }
    .btn.danger { background: rgba(179,57,57,.2); border-color: rgba(179,57,57,.5); color: #ffb3b3; }
    .btn.sm { padding: 5px 10px; font-size: 11.5px; }
    .btn:hover { filter: brightness(1.15); }
  `],
})
export class ArAssetEditorComponent {
  @Input({ required: true }) element!: ArElement;
  @Output() changed = new EventEmitter<void>();

  private svc = inject(ArContentService);

  readonly limits = AR_ASSET_LIMITS_MB;
  readonly optimizeThreshold = AR_IMAGE_OPTIMIZE_THRESHOLD_MB;
  readonly uploading = signal(false);
  readonly progress = signal<ArUploadProgress | null>(null);
  readonly upErr = signal('');

  previewing: string | null = null;
  private urls = signal<Record<string, string | null>>({});

  url(a: ArAsset): string | null {
    return this.urls()[a.id] ?? null;
  }

  togglePreview(a: ArAsset): void {
    if (this.previewing === a.id) {
      this.previewing = null;
      return;
    }
    this.previewing = a.id;
    if (this.urls()[a.id] === undefined) {
      void this.svc.resolveUrl(a.storagePath).then((u) => {
        this.urls.update((m) => ({ ...m, [a.id]: u }));
      });
    }
  }

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.upErr.set('');
    const type = inferAssetType(file);
    if (!type) {
      this.upErr.set('Tipo de archivo no soportado (usa GLB, imagen o video).');
      return;
    }
    const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.uploading.set(true);
    this.progress.set(null);
    try {
      const meta = await this.svc.uploadAsset(this.element.id, id, type, file, (p) => this.progress.set(p));
      const asset: ArAsset = {
        id,
        type,
        ...meta,
        animation: defaultAssetAnimation(),
        scale: 1,
        position: { x: 0, y: 0, z: 0 },
      };
      this.element.assets = [...this.element.assets, asset];
      this.emitChanged();
    } catch (e: any) {
      this.upErr.set(e?.message ?? String(e));
    } finally {
      this.uploading.set(false);
      this.progress.set(null);
    }
  }

  async remove(a: ArAsset): Promise<void> {
    if (!confirm(`Quitar el asset "${a.fileName || a.id}"?`)) return;
    await this.svc.deleteAssetObject(a.storagePath);
    this.element.assets = this.element.assets.filter((x) => x.id !== a.id);
    if (this.previewing === a.id) this.previewing = null;
    this.emitChanged();
  }

  /** Ensure + return the animation config so the template can bind into it. */
  anim(a: ArAsset) {
    if (!a.animation) a.animation = defaultAssetAnimation();
    return a.animation;
  }

  /** Ensure + return the position vector for binding. */
  pos(a: ArAsset) {
    if (!a.position) a.position = { x: 0, y: 0, z: 0 };
    return a.position;
  }

  setPath(a: ArAsset, v: string): void {
    this.anim(a).path = v === 'orbit' || v === 'line' ? v : null;
    this.emitChanged();
  }

  triggersText(a: ArAsset): string {
    return (this.anim(a).triggers ?? []).join(', ');
  }

  setTriggers(a: ArAsset, ev: Event): void {
    const raw = (ev.target as HTMLInputElement).value;
    this.anim(a).triggers = raw.split(',').map((x) => x.trim()).filter(Boolean);
    this.emitChanged();
  }

  emitChanged(): void {
    this.changed.emit();
  }
}
