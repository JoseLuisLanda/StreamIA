import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ArAsset } from '../../../lib/ar/ar.models';

export interface MediaPanelItem {
  asset: ArAsset;
  url: string;
  selected: boolean;
}

/**
 * Marker content strip -- TOP of the screen, hint-style (mockup layout v2):
 * a centered horizontal row of chips (thumb + name), one per asset of the
 * active anchor. Tapping a chip projects that asset (marker mode selector).
 * Hidden entirely when there is nothing to show.
 */
@Component({
  selector: 'app-ar-media-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="strip" *ngIf="items.length">
      <span class="titlechip" *ngIf="title">{{ title }}</span>
      <button class="chip" *ngFor="let it of items" [class.sel]="it.selected" (click)="tap(it)">
        <span class="thumb">
          <img *ngIf="it.asset.type === 'image'" [src]="it.url" crossorigin="anonymous" alt="" />
          <video *ngIf="it.asset.type === 'video'" [src]="it.url" crossorigin="anonymous" muted playsinline></video>
          <svg *ngIf="it.asset.type === 'model'" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M12 12l8-4.5 M12 12v9 M12 12L4 7.5"/></svg>
        </span>
        <span class="lbl">{{ shortName(it) }}</span>
        <span class="check" *ngIf="it.selected">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M5 13l4 4 10-10"/></svg>
        </span>
      </button>
    </div>
  `,
  styles: [`
    /* pointer-events AUTO on purpose: shell/container rules cannot style
       projected content (Angular view encapsulation). */
    :host { position: absolute; top: calc(env(safe-area-inset-top) + 62px); left: 50%; transform: translateX(-50%);
      max-width: min(94vw, 920px); pointer-events: auto; z-index: 6; display: block; }
    .strip { display: flex; align-items: center; gap: 8px; overflow-x: auto; padding: 7px 10px;
      background: rgba(10,14,20,.55); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,.14);
      border-radius: 999px; scrollbar-width: none; }
    .strip::-webkit-scrollbar { display: none; }
    .titlechip { flex: none; font-size: 11.5px; font-weight: 700; color: #c4b0f7; padding: 0 6px 0 4px;
      max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: 'Segoe UI', system-ui, sans-serif; }
    .chip { flex: none; display: flex; align-items: center; gap: 7px; padding: 4px 12px 4px 5px;
      border-radius: 999px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14);
      color: #e6e8ee; cursor: pointer; font-family: 'Segoe UI', system-ui, sans-serif; }
    .chip.sel { border-color: #8b5cf6; background: rgba(139,92,246,.24); }
    .thumb { width: 30px; height: 30px; flex: none; border-radius: 50%; overflow: hidden; display: grid;
      place-items: center; background: rgba(255,255,255,.1); color: #c4b0f7; }
    .thumb img, .thumb video { width: 100%; height: 100%; object-fit: cover; }
    .lbl { font-size: 12px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .check { color: #b6e84a; display: grid; place-items: center; }
  `],
})
export class ArMediaPanelComponent {
  @Input() title = '';
  @Input() items: MediaPanelItem[] = [];
  @Output() pick = new EventEmitter<string>();

  shortName(it: MediaPanelItem): string {
    const n = it.asset.fileName || it.asset.id;
    return n.length > 22 ? n.slice(0, 20) + '...' : n;
  }

  tap(it: MediaPanelItem): void {
    console.info('[media-panel] tap', it.asset.id, it.asset.type);
    this.pick.emit(it.asset.id);
  }
}
