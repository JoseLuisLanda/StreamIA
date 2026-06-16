import { Component, Input, OnChanges, OnDestroy, SimpleChanges, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MediaItem } from '../../lib/rag/rag.models';
import { MediaUnauthorizedError, RagAvatarService } from '../../services/rag-avatar.service';

type LoadState = 'idle' | 'loading' | 'ready' | 'unauthorized' | 'error';

/**
 * RAG media gallery + popup.
 *
 * Renders a compact thumbnail/chip gallery for an answer's media. Thumbnails are
 * fetched lazily from Storage (via the SDK) on render; the full asset (image or
 * video) is fetched only when the user opens the popup. Multiple items are
 * browsable. Unauthorized fetches degrade to a clear "locked" state.
 */
@Component({
  selector: 'app-media-gallery',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="mg" *ngIf="media.length">
      <div class="mg-strip">
        <button *ngFor="let m of media; let i = index" class="mg-chip" type="button"
                (click)="open(i)" [title]="m.title || m.caption || m.id">
          <span class="mg-thumb">
            <img *ngIf="thumbs()[m.id]?.url as u" [src]="u" [alt]="m.title" />
            <span *ngIf="!thumbs()[m.id]?.url" class="mg-thumb-ph" [class.err]="thumbs()[m.id]?.state === 'unauthorized' || thumbs()[m.id]?.state === 'error'">
              {{ m.type === 'video' ? '🎬' : (m.type === 'document' ? '📄' : (thumbs()[m.id]?.state === 'loading' ? '…' : '🖼️')) }}
            </span>
            <span class="mg-type" *ngIf="m.type === 'video'">▶</span>
            <span class="mg-type" *ngIf="m.type === 'document'">DOC</span>
          </span>
          <span class="mg-label">{{ m.title || m.id }}</span>
        </button>
      </div>
    </div>

    <!-- Popup / lightbox -->
    <div class="mg-backdrop" *ngIf="openIndex() !== null" (click)="close()">
      <div class="mg-modal" (click)="$event.stopPropagation()">
        <button class="mg-x" (click)="close()" title="Close">✕</button>

        <div class="mg-stage">
          <button class="mg-nav prev" *ngIf="media.length > 1" (click)="prev()" title="Previous">‹</button>

          <div class="mg-media">
            <div class="mg-status" *ngIf="fullState() === 'loading'"><span class="mg-spin"></span> Loading…</div>
            <div class="mg-status err" *ngIf="fullState() === 'unauthorized'">🔒 You don’t have access to this media.</div>
            <div class="mg-status err" *ngIf="fullState() === 'error'">⚠️ {{ fullError() }}</div>

            <ng-container *ngIf="fullState() === 'ready' && current() as m">
              <img *ngIf="m.type === 'image'" [src]="fullUrl()!" [alt]="m.title" class="mg-full" [class.zoomed]="zoomed()" (click)="zoomed.set(!zoomed())" title="Click para zoom" />
              <video *ngIf="m.type === 'video'" [src]="fullUrl()!" class="mg-full" controls autoplay></video>
              <div *ngIf="m.type === 'document'" class="mg-doc">
                <div class="mg-doc-ic">📄</div>
                <div class="mg-doc-name">{{ m.title }}</div>
                <a class="mg-doc-btn" [href]="fullUrl()!" [download]="m.title" target="_blank" rel="noopener">Abrir / Descargar</a>
              </div>
            </ng-container>
          </div>

          <button class="mg-nav next" *ngIf="media.length > 1" (click)="next()" title="Next">›</button>
        </div>

        <div class="mg-meta" *ngIf="current() as m">
          <div class="mg-title">{{ m.title }}</div>
          <div class="mg-caption" *ngIf="m.caption">{{ m.caption }}</div>
          <div class="mg-metafoot">
            <span class="mg-counter" *ngIf="media.length > 1">{{ (openIndex() ?? 0) + 1 }} / {{ media.length }}</span>
            <span class="mg-ctrls" *ngIf="fullUrl()">
              <button class="mg-cbtn" *ngIf="m.type === 'image'" (click)="zoomed.set(!zoomed())">{{ zoomed() ? 'Reducir' : 'Zoom' }}</button>
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
    /* Compact horizontal CAROUSEL preview (not stacked/wrapped). */
    .mg-strip { display: flex; gap: 8px; flex-wrap: nowrap; overflow-x: auto; scroll-snap-type: x mandatory;
      padding-bottom: 4px; scrollbar-width: thin; }
    .mg-strip > * { scroll-snap-align: start; flex: 0 0 auto; }
    .mg-chip {
      display: flex; flex-direction: column; align-items: center; gap: 4px; width: 84px;
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1);
      border-radius: 10px; padding: 6px; cursor: pointer; color: #cfd3dc;
    }
    .mg-chip:hover { border-color: rgba(139,92,246,.5); background: rgba(139,92,246,.1); }
    .mg-thumb { position: relative; width: 70px; height: 52px; border-radius: 7px; overflow: hidden;
      background: rgba(0,0,0,.3); display: grid; place-items: center; }
    .mg-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .mg-thumb-ph { font-size: 20px; opacity: .8; } .mg-thumb-ph.err { opacity: .9; }
    .mg-type { position: absolute; right: 3px; bottom: 2px; font-size: 9px; color: #fff;
      background: rgba(0,0,0,.55); border-radius: 4px; padding: 0 3px; }
    .mg-label { font-size: 10.5px; line-height: 1.1; text-align: center; max-width: 76px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .mg-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.78); z-index: 60;
      display: grid; place-items: center; padding: 24px; }
    .mg-modal { position: relative; background: #15161c; border: 1px solid rgba(255,255,255,.12);
      border-radius: 16px; max-width: min(92vw, 1000px); max-height: 90vh; display: flex; flex-direction: column;
      box-shadow: 0 20px 60px rgba(0,0,0,.6); overflow: hidden; }
    .mg-x { position: absolute; top: 8px; right: 8px; z-index: 2; width: 32px; height: 32px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,.15); background: rgba(0,0,0,.4); color: #fff; cursor: pointer; font-size: 14px; }
    .mg-x:hover { background: rgba(0,0,0,.7); }
    .mg-stage { display: flex; align-items: center; gap: 6px; min-height: 240px; padding: 12px; }
    .mg-media { flex: 1; display: grid; place-items: center; min-height: 240px; max-height: 76vh; }
    .mg-full { max-width: 100%; max-height: 76vh; border-radius: 10px; display: block; cursor: zoom-in; transition: transform .2s ease; }
    .mg-full.zoomed { transform: scale(1.8); cursor: zoom-out; }
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
    .mg-counter { font-size: 11px; color: #778; margin-top: 4px; }
  `]
})
export class MediaGalleryComponent implements OnChanges, OnDestroy {
  @Input() media: MediaItem[] = [];

  private rag = inject(RagAvatarService);

  readonly thumbs = signal<Record<string, { url: string | null; state: LoadState }>>({});
  readonly openIndex = signal<number | null>(null);
  readonly fullUrl = signal<string | null>(null);
  readonly fullState = signal<LoadState>('idle');
  readonly fullError = signal<string>('');
  readonly zoomed = signal(false);

  /** blob: object URLs we created and must revoke */
  private blobUrls = new Set<string>();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['media']) {
      this.close();
      this.thumbs.set({});
      this.loadThumbnails();
    }
  }

  ngOnDestroy(): void {
    this.revokeAll();
  }

  current(): MediaItem | null {
    const i = this.openIndex();
    return i === null ? null : this.media[i] ?? null;
  }

  private async loadThumbnails(): Promise<void> {
    for (const m of this.media) {
      const path = m.thumbnailPath || (m.type === 'image' ? m.storagePath : '');
      if (!path) {
        this.patchThumb(m.id, { url: null, state: 'idle' });
        continue;
      }
      this.patchThumb(m.id, { url: null, state: 'loading' });
      try {
        const url = await this.rag.resolveMediaUrl(path, 8 * 1024 * 1024);
        if (url.startsWith('blob:')) this.blobUrls.add(url);
        this.patchThumb(m.id, { url, state: 'ready' });
      } catch (e) {
        const state: LoadState = e instanceof MediaUnauthorizedError ? 'unauthorized' : 'error';
        this.patchThumb(m.id, { url: null, state });
      }
    }
  }

  private patchThumb(id: string, v: { url: string | null; state: LoadState }): void {
    this.thumbs.update(t => ({ ...t, [id]: v }));
  }

  async open(i: number): Promise<void> {
    this.openIndex.set(i);
    this.zoomed.set(false); // reset zoom on each item
    await this.loadFull();
  }

  close(): void {
    this.openIndex.set(null);
    this.zoomed.set(false);
    this.revokeFull();
    this.fullUrl.set(null);
    this.fullState.set('idle');
    this.fullError.set('');
  }

  next(): void { this.step(1); }
  prev(): void { this.step(-1); }

  private step(d: number): void {
    const i = this.openIndex();
    if (i === null || !this.media.length) return;
    const ni = (i + d + this.media.length) % this.media.length;
    void this.open(ni);
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
      if (e instanceof MediaUnauthorizedError) {
        this.fullState.set('unauthorized');
      } else {
        this.fullError.set(e?.message ?? String(e));
        this.fullState.set('error');
      }
    }
  }

  private revokeFull(): void {
    const u = this.fullUrl();
    if (u && u.startsWith('blob:')) {
      URL.revokeObjectURL(u);
      this.blobUrls.delete(u);
    }
  }

  private revokeAll(): void {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls.clear();
  }
}
