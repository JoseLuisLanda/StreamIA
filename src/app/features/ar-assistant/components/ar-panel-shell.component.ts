import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * UNUSED (layout v2): the viewer moved to the mockup layout (media chips on
 * top + centered avatar bar + mini-map popup, all simultaneous) and no longer
 * imports this carousel. Kept only because the sandbox cannot delete files --
 * safe to remove.
 *
 * 3-panel carousel over the AR camera (FASE 1 UX spec):
 *   media (left) <- avatar (center, DEFAULT) -> map (right)
 *
 * - Horizontal swipe switches panels (ONE visible at a time, slide animation).
 * - Downward swipe (or the chevron button) hides the active panel; a floating
 *   handle (chevron up / swipe up) restores it.
 * - The three panels are content-projected and mounted ONCE: hidden panels are
 *   translated off-screen with CSS, never destroyed (avatar canvas + Google Map
 *   must survive panel switches -- project rule).
 *
 * GESTURE ZONES (decision F1-1): swipes are captured on the panel surface, the
 * bottom strip and 28px lateral edge strips -- the camera CENTER stays free for
 * the FASE 4 asset gestures (rotate/scale on content).
 */
export type ArPanelId = 'media' | 'avatar' | 'map';

const PANEL_ORDER: ArPanelId[] = ['media', 'avatar', 'map'];

@Component({
  selector: 'app-ar-panel-shell',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- Edge gesture strips (always active) + bottom strip -->
    <div class="strip left" (touchstart)="ts($event)" (touchmove)="tm($event)" (touchend)="te()"></div>
    <div class="strip right" (touchstart)="ts($event)" (touchmove)="tm($event)" (touchend)="te()"></div>
    <div class="strip bottom" (touchstart)="ts($event)" (touchmove)="tm($event)" (touchend)="te()"></div>

    <!-- Panels track -->
    <div class="track" [class.hidden]="!visible()"
         (touchstart)="ts($event)" (touchmove)="tm($event)" (touchend)="te()">
      <div class="panel" [style.transform]="tf('media')" [class.off]="active() !== 'media'">
        <button class="chev" (click)="hide()" title="Ocultar">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <ng-content select="[panel-media]"></ng-content>
      </div>
      <div class="panel" [style.transform]="tf('avatar')" [class.off]="active() !== 'avatar'">
        <button class="chev" (click)="hide()" title="Ocultar">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <ng-content select="[panel-avatar]"></ng-content>
      </div>
      <div class="panel" [style.transform]="tf('map')" [class.off]="active() !== 'map'">
        <button class="chev" (click)="hide()" title="Ocultar">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <ng-content select="[panel-map]"></ng-content>
      </div>
    </div>

    <!-- Dots indicator -->
    <div class="dots" *ngIf="visible()">
      <span *ngFor="let p of order" [class.on]="p === active()" (click)="go(p)"></span>
    </div>

    <!-- Restore handle when hidden -->
    <button class="handle" *ngIf="!visible()" (click)="show()"
            (touchstart)="hts($event)" (touchend)="hte($event)" title="Mostrar panel">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>
    </button>
  `,
  styles: [`
    :host { position: absolute; inset: 0; pointer-events: none; z-index: 30; }
    .strip { position: absolute; pointer-events: auto; z-index: 31; }
    .strip.left { left: 0; top: 0; bottom: 0; width: 28px; }
    .strip.right { right: 0; top: 0; bottom: 0; width: 28px; }
    .strip.bottom { left: 0; right: 0; bottom: 0; height: 56px; }
    .track { position: absolute; inset: 0; pointer-events: none; }
    .track.hidden .panel { transform: translateY(110%) !important; }
    .panel { position: absolute; inset: 0; pointer-events: none; transition: transform .28s ease; }
    .panel > * { pointer-events: auto; }
    .panel.off { pointer-events: none; }
    .panel.off > * { pointer-events: none; }
    .chev { position: absolute; top: max(10px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
      width: 40px; height: 26px; border-radius: 999px; border: 1px solid rgba(255,255,255,.25);
      background: rgba(10,14,20,.45); backdrop-filter: blur(8px); color: #e6e8ee; cursor: pointer;
      display: grid; place-items: center; pointer-events: auto; z-index: 5; }
    .dots { position: absolute; bottom: max(64px, calc(env(safe-area-inset-bottom) + 58px)); left: 50%;
      transform: translateX(-50%); display: flex; gap: 8px; pointer-events: auto; z-index: 32; }
    .dots span { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,.35); cursor: pointer; }
    .dots span.on { background: #8b5cf6; }
    .handle { position: absolute; bottom: max(14px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%);
      width: 56px; height: 34px; border-radius: 999px; border: 1px solid rgba(255,255,255,.3);
      background: rgba(10,14,20,.55); backdrop-filter: blur(8px); color: #e6e8ee; cursor: pointer;
      display: grid; place-items: center; pointer-events: auto; z-index: 33; }
  `],
})
export class ArPanelShellComponent {
  readonly order = PANEL_ORDER;
  readonly active = signal<ArPanelId>('avatar');
  readonly visible = signal(true);
  readonly activeIndex = computed(() => PANEL_ORDER.indexOf(this.active()));

  private startX = 0;
  private startY = 0;
  private dx = 0;
  private dy = 0;
  private tracking = false;
  private handleY = 0;

  /** Slide transform for a panel relative to the active one. */
  tf(p: ArPanelId): string {
    const diff = PANEL_ORDER.indexOf(p) - this.activeIndex();
    return `translateX(${diff * 100}%)`;
  }

  go(p: ArPanelId): void { this.active.set(p); this.visible.set(true); }
  hide(): void { this.visible.set(false); }
  show(): void { this.visible.set(true); }

  // ------------------------------------------------------------ swipe gestures

  ts(ev: TouchEvent): void {
    const t = ev.touches[0];
    if (!t) return;
    this.tracking = true;
    this.startX = t.clientX;
    this.startY = t.clientY;
    this.dx = 0;
    this.dy = 0;
  }

  tm(ev: TouchEvent): void {
    if (!this.tracking) return;
    const t = ev.touches[0];
    if (!t) return;
    this.dx = t.clientX - this.startX;
    this.dy = t.clientY - this.startY;
  }

  te(): void {
    if (!this.tracking) return;
    this.tracking = false;
    const TH = 60;
    const horizontal = Math.abs(this.dx) > Math.abs(this.dy);
    if (horizontal && Math.abs(this.dx) > TH) {
      if (!this.visible()) { this.visible.set(true); return; }
      const i = this.activeIndex();
      // swipe left (dx<0) -> next panel to the right; swipe right -> previous.
      const next = this.dx < 0 ? Math.min(i + 1, PANEL_ORDER.length - 1) : Math.max(i - 1, 0);
      this.active.set(PANEL_ORDER[next]);
      return;
    }
    if (!horizontal && this.dy > TH && this.visible()) this.hide();
    if (!horizontal && this.dy < -TH && !this.visible()) this.show();
  }

  // Handle swipe-up on the restore handle.
  hts(ev: TouchEvent): void { this.handleY = ev.touches[0]?.clientY ?? 0; }
  hte(ev: TouchEvent): void {
    const y = ev.changedTouches[0]?.clientY ?? this.handleY;
    if (this.handleY - y > 30) this.show();
  }
}
