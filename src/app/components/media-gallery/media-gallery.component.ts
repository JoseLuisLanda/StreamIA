import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MediaItem } from '../../lib/rag/rag.models';
import { MediaUnauthorizedError, RagAvatarService } from '../../services/rag-avatar.service';

type LoadState = 'idle' | 'loading' | 'ready' | 'unauthorized' | 'error';

/**
 * RAG media gallery — two modes:
 *
 *  - mode='preview' (default): a compact ONE-AT-A-TIME carousel (prev/next/swipe)
 *    for an answer's media inside the chat card. Clicking the current image emits
 *    `openViewer` with the index (the host opens the full-screen viewer at root).
 *  - mode='viewer': renders ONLY the full-screen lightbox (one image at a time,
 *    prev/next/swipe, caption, zoom, download), opening at `startIndex`. Hosted at
 *    the app/page root so it covers the whole window (not clipped to a column).
 *
 * Thumbnails + full assets are fetched lazily from Storage; unauthorized -> locked.
 */
@Component({
  selector: 'app-media-gallery',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- ===== PREVIEW: one image at a time ===== -->
    <div class="mg" *ngIf="mode === 'preview' && media.length">
      <div class="mg-carousel">
        <button class="mg-carnav" *ngIf="media.length > 1" (click)="prevPreview()" title="Anterior" type="button">‹</button>
        <button class="mg-one" type="button" (click)="openViewer.emit(cur())"
                (touchstart)="onTouchStart($event)" (touchend)="onTouchEnd($event, 'preview')"
                [title]="curItem()?.title || curItem()?.caption || ''">
          <span class="mg-onethumb">
            <img *ngIf="curItem() && thumbs()[curItem()!.id]?.url as u" [src]="u" [alt]="curItem()?.title || ''" />
            <span *ngIf="curItem() && !thumbs()[curItem()!.id]?.url" class="mg-thumb-ph"
                  [class.err]="thumbs()[curItem()!.id]?.state === 'unauthorized' || thumbs()[curItem()!.id]?.state === 'error'">
              {{ icon(curItem()!) }}
            </span>
            <span class="mg-type" *ngIf="curItem()?.type === 'video'">▶</span>
            <span class="mg-type" *ngIf="curItem()?.type === 'document'">DOC</span>
          </span>
          <span class="mg-label">{{ curItem()?.title || curItem()?.id }}</span>
        </button>
        <button class="mg-carnav" *ngIf="media.length > 1" (click)="nextPreview()" title="Siguiente" type="button">›</button>
      </div>
      <div class="mg-dots" *ngIf="media.length > 1">{{ cur() + 1 }} / {{ media.length }}</div>
    </div>

    <!-- ===== VIEWER: SINGLE full-screen image (no carousel), pinch-to-zoom + pan ===== -->
    <div class="mg-backdrop" *ngIf="mode === 'viewer' && openIndex() !== null" (click)="requestClose()">
      <div class="mg-modal" (click)="$event.stopPropagation()">
        <button class="mg-x" (click)="requestClose()" title="Cerrar" aria-label="Cerrar">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>

        <!-- Single image, maximized. Pinch (2 fingers) zooms; 1-finger drag pans when zoomed.
             Desktop: wheel zoom + double-click toggle + Zoom button. -->
        <div class="mg-media single" [class.zoomable]="current()?.type === 'image'"
             (wheel)="onWheel($event)" (dblclick)="toggleZoom()"
             (touchstart)="onViewerTouchStart($event)" (touchmove)="onViewerTouchMove($event)"
             (touchend)="onViewerTouchEnd($event)">
          <div class="mg-status" *ngIf="fullState() === 'loading'"><span class="mg-spin"></span> Cargando...</div>
          <div class="mg-status err" *ngIf="fullState() === 'unauthorized'">No tienes acceso a este recurso.</div>
          <div class="mg-status err" *ngIf="fullState() === 'error'">{{ fullError() }}</div>

          <ng-container *ngIf="fullState() === 'ready' && current() as m">
            <img *ngIf="m.type === 'image'" [src]="fullUrl()!" [alt]="m.title" class="mg-full"
                 [class.zoomed]="scale() > 1" [style.transform]="imgTransform()" draggable="false" />
            <video *ngIf="m.type === 'video'" [src]="fullUrl()!" class="mg-full" controls autoplay></video>
            <div *ngIf="m.type === 'document'" class="mg-doc">
              <div class="mg-doc-name">{{ m.title }}</div>
              <a class="mg-doc-btn" [href]="fullUrl()!" [download]="m.title" target="_blank" rel="noopener">Abrir / Descargar</a>
            </div>
          </ng-container>
        </div>

        <div class="mg-meta" *ngIf="current() as m">
          <div class="mg-title">{{ m.title }}</div>
          <div class="mg-caption" *ngIf="m.caption">{{ m.caption }}</div>
          <div class="mg-metafoot">
            <span class="mg-ctrls" *ngIf="fullUrl()">
              <button class="mg-cbtn" *ngIf="m.type === 'image'" (click)="toggleZoom()">{{ scale() > 1 ? 'Reducir' : 'Zoom' }}</button>
              <a class="mg-cbtn" [href]="fullUrl()!" [download]="m.title || 'media'" target="_blank" rel="noopener">Descargar</a>
            </span>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .mg { margin-top: 8px; }
    /* one-at-a-time preview */
    .mg-carousel { display: flex; align-items: center; gap: 6px; }
    .mg-one { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px;
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1); border-radius: 12px;
      padding: 8px; cursor: zoom-in; color: #cfd3dc; }
    .mg-one:hover { border-color: rgba(139,92,246,.5); background: rgba(139,92,246,.1); }
    .mg-onethumb { position: relative; width: 100%; height: 130px; border-radius: 9px; overflow: hidden;
      background: rgba(0,0,0,.3); display: grid; place-items: center; }
    .mg-onethumb img { width: 100%; height: 100%; object-fit: cover; }
    .mg-thumb-ph { font-size: 34px; opacity: .8; } .mg-thumb-ph.err { opacity: .9; }
    .mg-type { position: absolute; right: 5px; bottom: 4px; font-size: 10px; color: #fff;
      background: rgba(0,0,0,.55); border-radius: 4px; padding: 1px 5px; }
    .mg-label { font-size: 11.5px; line-height: 1.2; text-align: center; max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mg-carnav { flex: none; width: 28px; height: 64px; border-radius: 8px; cursor: pointer;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); color: #cfd3dc; font-size: 18px; }
    .mg-carnav:hover { background: rgba(139,92,246,.25); color: #fff; }
    .mg-dots { text-align: center; font-size: 11px; color: #778; margin-top: 4px; }

    /* single-image full-screen viewer */
    /* z-index 80: ABOVE the PiP avatar (70) so the viewer + its controls are never
       overlapped by the minimized avatar; the avatar keeps animating behind the backdrop. */
    .mg-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.9); z-index: 80;
      display: grid; place-items: center; padding: 16px; }
    .mg-modal { position: relative; background: #15161c; border: 1px solid rgba(255,255,255,.12);
      border-radius: 16px; width: min(96vw, 1200px); max-height: 94vh; display: flex; flex-direction: column;
      box-shadow: 0 20px 60px rgba(0,0,0,.6); overflow: hidden; }
    .mg-x { position: absolute; top: 8px; right: 8px; z-index: 2; width: 36px; height: 36px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,.15); background: rgba(0,0,0,.45); color: #fff; cursor: pointer;
      display: grid; place-items: center; }
    .mg-x:hover { background: rgba(0,0,0,.75); }
    /* Image stage fills the modal; the image is maximized (no carousel chrome). */
    .mg-media.single { flex: 1; display: grid; place-items: center; min-height: 0; overflow: hidden;
      touch-action: none; padding: 8px; } /* touch-action:none -> our pinch/pan owns the gesture */
    .mg-media.single.zoomable { cursor: zoom-in; }
    .mg-full { max-width: 100%; max-height: 86vh; border-radius: 10px; display: block;
      transform-origin: center center; transition: transform .08s ease-out; will-change: transform;
      user-select: none; -webkit-user-drag: none; }
    .mg-full.zoomed { cursor: grab; }
    .mg-metafoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 6px; flex-wrap: wrap; }
    .mg-ctrls { display: flex; gap: 8px; }
    .mg-cbtn { font-size: 12px; padding: 5px 11px; border-radius: 8px; cursor: pointer; text-decoration: none;
      background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; }
    .mg-cbtn:hover { background: rgba(139,92,246,.3); }
    .mg-doc { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 30px 24px; }
    .mg-doc-ic { font-size: 48px; }
    .mg-doc-name { font-size: 14px; color: #e6e8ee; text-align: center; }
    .mg-doc-btn { background: #8b5cf6; color: #fff; text-decoration: none; padding: 9px 16px; border-radius: 9px; font-size: 13px; }
    .mg-doc-btn:hover { background: #7c4ff0; }
    .mg-nav { flex: none; width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(255,255,255,.15);
      background: rgba(255,255,255,.06); color: #fff; font-size: 22px; cursor: pointer; }
    .mg-nav:hover { background: rgba(139,92,246,.25); }
    .mg-status { color: #cdd; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .mg-status.err { color: #ff9c9c; }
    .mg-spin { width: 16px; height: 16px; border: 2px solid transparent; border-top-color: #8B5CF6;
      border-radius: 50%; display: inline-block; animation: mgspin 1s linear infinite; }
    @keyframes mgspin { to { transform: rotate(360deg); } }
    .mg-meta { padding: 10px 16px 14px; border-top: 1px solid rgba(255,255,255,.07); }
    .mg-title { font-size: 14px; font-weight: 600; color: #E8E9EE; }
    .mg-caption { font-size: 12.5px; color: #9aa; margin-top: 3px; line-height: 1.45; }
    .mg-counter { font-size: 11px; color: #778; }
  `]
})
export class MediaGalleryComponent implements OnChanges, OnInit, OnDestroy {
  @Input() media: MediaItem[] = [];
  @Input() mode: 'preview' | 'viewer' = 'preview';
  @Input() startIndex = 0;
  /** Preview emits the index to open in the (root-hosted) full-screen viewer. */
  @Output() openViewer = new EventEmitter<number>();
  /** Viewer emits when the user closes it. */
  @Output() closed = new EventEmitter<void>();

  private rag = inject(RagAvatarService);

  readonly thumbs = signal<Record<string, { url: string | null; state: LoadState }>>({});
  readonly cur = signal(0);                 // preview index (one-at-a-time)
  readonly openIndex = signal<number | null>(null); // viewer index
  readonly fullUrl = signal<string | null>(null);
  readonly fullState = signal<LoadState>('idle');
  readonly fullError = signal<string>('');

  // Single-image zoom/pan state (viewer). scale 1 = fit; >1 = zoomed in.
  readonly scale = signal(1);
  readonly panX = signal(0);
  readonly panY = signal(0);
  readonly imgTransform = computed(
    () => `translate(${this.panX()}px, ${this.panY()}px) scale(${this.scale()})`);

  private touchX: number | null = null;
  // pinch/pan gesture refs (non-reactive)
  private pinchBaseDist = 0;
  private pinchBaseScale = 1;
  private panStartX = 0;
  private panStartY = 0;
  private panBaseX = 0;
  private panBaseY = 0;
  private blobUrls = new Set<string>();

  @ViewChild('strip') stripEl?: ElementRef<HTMLDivElement>;

  ngOnInit(): void {
    if (this.mode === 'viewer') void this.open(Math.max(0, Math.min(this.startIndex, this.media.length - 1)));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['media']) {
      if (this.mode !== 'viewer') this.requestClose();
      this.cur.set(0);
      this.thumbs.set({});
      this.loadThumbnails();
    }
  }

  ngOnDestroy(): void { this.revokeAll(); }

  // ---- preview ----
  curItem(): MediaItem | null { return this.media[this.cur()] ?? null; }
  prevPreview(): void { if (this.media.length) this.cur.set((this.cur() - 1 + this.media.length) % this.media.length); }
  nextPreview(): void { if (this.media.length) this.cur.set((this.cur() + 1) % this.media.length); }
  icon(m: MediaItem): string {
    const st = this.thumbs()[m.id]?.state;
    return m.type === 'video' ? '🎬' : m.type === 'document' ? '📄' : (st === 'loading' ? '…' : '🖼️');
  }

  // ---- swipe (preview + viewer) ----
  onTouchStart(e: TouchEvent): void { this.touchX = e.changedTouches[0]?.clientX ?? null; }
  onTouchEnd(e: TouchEvent, where: 'preview' | 'viewer'): void {
    if (this.touchX === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? this.touchX) - this.touchX;
    this.touchX = null;
    if (Math.abs(dx) < 40) return;
    const fwd = dx < 0;
    if (where === 'preview') fwd ? this.nextPreview() : this.prevPreview();
    else fwd ? this.next() : this.prev();
  }

  // ---- viewer ----
  current(): MediaItem | null {
    const i = this.openIndex();
    return i === null ? null : this.media[i] ?? null;
  }

  async open(i: number): Promise<void> {
    this.openIndex.set(i);
    this.resetZoom();
    await this.loadFull();
  }

  requestClose(): void {
    this.openIndex.set(null);
    this.resetZoom();
    this.revokeFull();
    this.fullUrl.set(null);
    this.fullState.set('idle');
    this.fullError.set('');
    this.closed.emit(); // host clears mediaViewer -> returns to the carousel popup
  }

  // ---- single-image pinch-to-zoom + pan (viewer) ----
  private clampScale(s: number): number { return Math.max(1, Math.min(5, s)); }
  resetZoom(): void { this.scale.set(1); this.panX.set(0); this.panY.set(0); }

  /** Toggle 1x <-> 2x (double-click / Zoom button). */
  toggleZoom(): void {
    if (this.current()?.type !== 'image') return;
    this.scale.set(this.scale() > 1 ? 1 : 2);
    this.panX.set(0); this.panY.set(0);
  }

  /** Desktop fallback: wheel zooms toward/away. */
  onWheel(e: WheelEvent): void {
    if (this.current()?.type !== 'image') return;
    e.preventDefault();
    const s = this.clampScale(this.scale() * (e.deltaY < 0 ? 1.15 : 0.87));
    this.scale.set(s);
    if (s <= 1) { this.panX.set(0); this.panY.set(0); }
  }

  private touchDist(t: TouchList): number {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }

  /** Two fingers -> start pinch; one finger (while zoomed) -> start pan. */
  onViewerTouchStart(e: TouchEvent): void {
    if (this.current()?.type !== 'image') return;
    if (e.touches.length === 2) {
      this.pinchBaseDist = this.touchDist(e.touches);
      this.pinchBaseScale = this.scale();
    } else if (e.touches.length === 1 && this.scale() > 1) {
      this.panStartX = e.touches[0].clientX; this.panStartY = e.touches[0].clientY;
      this.panBaseX = this.panX(); this.panBaseY = this.panY();
    }
  }

  /** Pinch -> scale from finger distance ratio; drag -> pan when zoomed. */
  onViewerTouchMove(e: TouchEvent): void {
    if (this.current()?.type !== 'image') return;
    if (e.touches.length === 2 && this.pinchBaseDist > 0) {
      e.preventDefault();
      const s = this.clampScale(this.pinchBaseScale * (this.touchDist(e.touches) / this.pinchBaseDist));
      this.scale.set(s);
      if (s <= 1) { this.panX.set(0); this.panY.set(0); }
    } else if (e.touches.length === 1 && this.scale() > 1) {
      e.preventDefault();
      this.panX.set(this.panBaseX + (e.touches[0].clientX - this.panStartX));
      this.panY.set(this.panBaseY + (e.touches[0].clientY - this.panStartY));
    }
  }

  onViewerTouchEnd(_e: TouchEvent): void {
    this.pinchBaseDist = 0;
    if (this.scale() <= 1) this.resetZoom();
  }

  next(): void { this.step(1); }
  prev(): void { this.step(-1); }
  private step(d: number): void {
    const i = this.openIndex();
    if (i === null || !this.media.length) return;
    void this.open((i + d + this.media.length) % this.media.length);
  }

  // ---- loading ----
  private async loadThumbnails(): Promise<void> {
    for (const m of this.media) {
      const path = m.thumbnailPath || (m.type === 'image' ? m.storagePath : '');
      if (!path) { this.patchThumb(m.id, { url: null, state: 'idle' }); continue; }
      this.patchThumb(m.id, { url: null, state: 'loading' });
      try {
        const url = await this.rag.resolveMediaUrl(path, 8 * 1024 * 1024);
        if (url.startsWith('blob:')) this.blobUrls.add(url);
        this.patchThumb(m.id, { url, state: 'ready' });
      } catch (e) {
        this.patchThumb(m.id, { url: null, state: e instanceof MediaUnauthorizedError ? 'unauthorized' : 'error' });
      }
    }
  }

  private patchThumb(id: string, v: { url: string | null; state: LoadState }): void {
    this.thumbs.update(t => ({ ...t, [id]: v }));
  }

  private async loadFull(): Promise<void> {
    const m = this.current();
    if (!m) return;
    this.revokeFull();
    this.fullUrl.set(null);
    this.fullError.set('');
    this.fullState.set('loading');
    try {
      const url = await this.rag.resolveMediaUrl(m.storagePath);
      if (url.startsWith('blob:')) this.blobUrls.add(url);
      this.fullUrl.set(url);
      this.fullState.set('ready');
    } catch (e: any) {
      if (e instanceof MediaUnauthorizedError) this.fullState.set('unauthorized');
      else { this.fullError.set(e?.message ?? String(e)); this.fullState.set('error'); }
    }
  }

  private revokeFull(): void {
    const u = this.fullUrl();
    if (u && u.startsWith('blob:')) { URL.revokeObjectURL(u); this.blobUrls.delete(u); }
  }
  private revokeAll(): void {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.clear();
  }
}
