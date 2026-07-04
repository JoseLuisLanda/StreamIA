import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ArAsset } from '../../../lib/ar/ar.models';

export interface MediaPanelItem {
  asset: ArAsset;
  url: string;
  selected: boolean;
}

/**
 * LEFT panel: media available at the active anchor/point. An anchor may carry
 * one or several AR contents (image / video / 3D object); this panel is the
 * ACTIVE SELECTOR of which asset is projected (marker mode) or the listing of
 * the focused element's media (gps mode). Occupies the left third, glass style.
 */
@Component({
  selector: 'app-ar-media-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="glass">
      <div class="head">
        <h3>{{ title || 'Contenido del punto' }}</h3>
        <p class="sub" *ngIf="items.length">{{ items.length }} elemento(s) disponibles</p>
      </div>

      <p class="empty" *ngIf="!items.length">Sin contenido en este punto. Acercate a un ancla o apunta a un marcador.</p>

      <div class="items">
        <button class="item" *ngFor="let it of items" [class.sel]="it.selected" (click)="tap(it)">
          <span class="thumb">
            <img *ngIf="it.asset.type === 'image'" [src]="it.url" crossorigin="anonymous" alt="" />
            <video *ngIf="it.asset.type === 'video'" [src]="it.url" crossorigin="anonymous" muted playsinline></video>
            <svg *ngIf="it.asset.type === 'model'" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M12 12l8-4.5 M12 12v9 M12 12L4 7.5"/></svg>
          </span>
          <span class="meta">
            <b>{{ it.asset.fileName || it.asset.id }}</b>
            <i>{{ typeLabel(it.asset.type) }}</i>
          </span>
          <span class="check" *ngIf="it.selected">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 13l4 4 10-10"/></svg>
          </span>
        </button>
      </div>
    </div>
  `,
  styles: [`
    /* pointer-events AUTO here on purpose: the shell's ".panel > *" rule can
       NOT reach projected content (Angular emulated encapsulation scopes it to
       the shell's own template), so without this the whole panel is
       click-dead (inherits none from .panel). */
    :host { display: block; position: absolute; left: 0; top: 0; bottom: 0; width: min(34vw, 340px); min-width: 250px; pointer-events: auto; }
    .glass { position: absolute; inset: 10px 8px calc(env(safe-area-inset-bottom) + 70px) 8px;
      background: rgba(10,14,20,.55); backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,.14);
      border-radius: 16px; padding: 46px 12px 12px; display: flex; flex-direction: column; gap: 10px; color: #e6e8ee;
      overflow: hidden; }
    .head h3 { margin: 0; font-size: 15px; font-weight: 700; }
    .sub { margin: 2px 0 0; font-size: 11px; color: #aab; }
    .empty { font-size: 12.5px; color: #9aa; line-height: 1.5; }
    .items { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .item { display: flex; align-items: center; gap: 10px; text-align: left; padding: 8px; border-radius: 12px;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: inherit; cursor: pointer; }
    .item.sel { border-color: #8b5cf6; background: rgba(139,92,246,.18); }
    .thumb { width: 52px; height: 52px; flex: none; border-radius: 10px; overflow: hidden; display: grid;
      place-items: center; background: rgba(255,255,255,.08); color: #c4b0f7; }
    .thumb img, .thumb video { width: 100%; height: 100%; object-fit: cover; }
    .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .meta b { font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta i { font-size: 10.5px; font-style: normal; color: #9aa; text-transform: uppercase; letter-spacing: .5px; }
    .check { color: #8b5cf6; }
  `],
})
export class ArMediaPanelComponent {
  @Input() title = '';
  @Input() items: MediaPanelItem[] = [];
  @Output() pick = new EventEmitter<string>();

  typeLabel(t: string): string {
    return t === 'model' ? 'Objeto 3D' : t === 'video' ? 'Video' : 'Imagen';
  }

  tap(it: MediaPanelItem): void {
    console.info('[media-panel] tap', it.asset.id, it.asset.type);
    this.pick.emit(it.asset.id);
  }
}
