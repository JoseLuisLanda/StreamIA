import { Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AvatarCatalogService } from '../../services/avatar-catalog.service';
import { AvatarCatalogEntry, getCatalogEntry } from '../../lib/avatars/avatar-catalog';
import { Conformance, RigReport, conformanceLabel } from '../../lib/avatars/rig-spec';

export interface AvatarPick {
  id: string;
  /** resolved, loadable GLB URL (Firebase download URL or dev fallback) */
  url: string;
}

/**
 * Reusable avatar catalog picker. Self-contained via AvatarCatalogService.
 *
 * Two layouts:
 *  - [inline]="true"  → renders the thumbnail grid directly (e.g. Settings panel).
 *  - [inline]="false" → renders a compact trigger button + popover grid (toolbars).
 *
 * On selection it resolves the avatar's Storage URL and emits (pick); the host
 * sets its own [avatarUrl] + persistence. Conformance badges read the per-avatar
 * RigReport that the renderer stores back into the catalog service.
 */
@Component({
  selector: 'app-avatar-picker',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- Popover trigger (toolbar mode) -->
    <button *ngIf="!inline" type="button" class="ap-trigger" (click)="open = !open" [title]="triggerTitle()">
      🧑 {{ selectedName() }} <span class="ap-caret">▾</span>
    </button>

    <div class="ap-root" [class.ap-popover]="!inline" [class.ap-open]="inline || open">
      <div class="ap-grid">
        <div *ngFor="let a of catalog.catalog()"
             class="ap-card" [class.selected]="catalog.selectedId() === a.id"
             (click)="choose(a.id)" [title]="cardTitle(a.id)">
          <div class="ap-thumb-wrap">
            <img *ngIf="thumbUrl(a.id)" [src]="thumbUrl(a.id)" [alt]="a.name" class="ap-thumb" />
            <span *ngIf="!thumbUrl(a.id)" class="ap-thumb ap-placeholder" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6">
                <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
              </svg>
            </span>
          </div>
          <span class="ap-name">{{ a.name }}</span>
          <span class="ap-badge" *ngIf="confOf(a.id) as c" [ngClass]="'ap-' + c">{{ confDot(c) }}</span>
        </div>
      </div>

      <p class="ap-err" *ngIf="error">⚠️ {{ error }}</p>
      <div class="ap-detail" *ngIf="selectedReport() as r">
        <b>{{ confLabel(r.conformance) }}</b> — {{ r.matchedArkit.length }}/52 ARKit · head bone {{ r.hasHeadBone ? '✓' : '✕' }}
        <div *ngFor="let w of r.warnings" class="ap-warn">⚠️ {{ w }}</div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; position: relative; }
    .ap-trigger {
      display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
      border-radius: 999px; color: #E8E9EE; font-size: 12.5px; cursor: pointer; white-space: nowrap;
    }
    .ap-trigger:hover { background: rgba(139,92,246,.18); border-color: rgba(139,92,246,.4); }
    .ap-caret { opacity: .6; }
    .ap-popover {
      position: absolute; top: calc(100% + 8px); right: 0; z-index: 50; width: 280px;
      display: none; padding: 12px; background: #15161c; border: 1px solid rgba(255,255,255,.12);
      border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
    }
    .ap-popover.ap-open { display: block; }
    .ap-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .ap-card {
      position: relative; display: flex; flex-direction: column; align-items: center; gap: 5px;
      padding: 9px 6px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1);
      border-radius: 12px; cursor: pointer; transition: border-color .15s, background .15s;
    }
    .ap-card:hover { background: rgba(139,92,246,.1); border-color: rgba(139,92,246,.4); }
    .ap-card.selected { border-color: #8B5CF6; background: rgba(139,92,246,.16); box-shadow: 0 0 0 1px #8B5CF6; }
    .ap-thumb-wrap {
      width: 52px; height: 52px; border-radius: 50%; overflow: hidden; background: rgba(0,0,0,.25);
      border: 1px solid rgba(255,255,255,.1); display: grid; place-items: center;
    }
    .ap-thumb { width: 100%; height: 100%; object-fit: cover; }
    .ap-thumb.ap-placeholder { color: #8a7fb0; display: grid; place-items: center; }
    .ap-name { font-size: 11.5px; color: #E8E9EE; text-align: center; line-height: 1.1; }
    .ap-badge { font-size: 9px; line-height: 1; }
    .ap-full { color: #34d399; } .ap-remapped { color: #8ab4f8; }
    .ap-partial { color: #d9a440; } .ap-incompatible { color: #f87171; }
    .ap-err { color: #ff9c9c; font-size: 11px; margin: 6px 0 0; }
    .ap-detail {
      font-size: 11px; color: #98a; background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 8px 10px; margin-top: 8px;
    }
    .ap-detail b { color: #c4b0f7; }
    .ap-warn { color: #d9a440; margin-top: 3px; font-size: 10.5px; }
  `]
})
export class AvatarPickerComponent implements OnInit {
  public catalog = inject(AvatarCatalogService);

  /** Render the grid directly (true) or behind a trigger button + popover (false). */
  @Input() inline = false;

  /** Emits the resolved {id,url} when an avatar is chosen. */
  @Output() pick = new EventEmitter<AvatarPick>();
  /** Emits a human-readable message when resolution fails. */
  @Output() pickError = new EventEmitter<string>();

  open = false;
  error = '';
  private thumbs: Record<string, string | null> = {};

  ngOnInit(): void {
    for (const a of this.catalog.catalog()) {
      this.catalog.resolveThumbnailUrl(a)
        .then(url => { this.thumbs[a.id] = url; })
        .catch(() => { this.thumbs[a.id] = null; });
    }
  }

  async choose(id: string): Promise<void> {
    const entry = getCatalogEntry(id);
    if (!entry) return;
    this.catalog.select(id);
    this.error = '';
    try {
      const url = await this.catalog.resolveGlbUrl(entry);
      this.open = false;
      this.pick.emit({ id, url });
    } catch (e: any) {
      const msg = `No se pudo cargar "${entry.name}" desde Storage: ${e?.message ?? e}`;
      this.error = msg;
      this.pickError.emit(msg);
    }
  }

  thumbUrl(id: string): string { return this.thumbs[id] ?? ''; }
  confOf(id: string): Conformance | undefined { return this.catalog.conformanceOf(id); }
  confLabel(c: Conformance): string { return conformanceLabel(c); }
  confDot(c: Conformance): string {
    return c === 'full' ? '● full' : c === 'remapped' ? '● remap' : c === 'partial' ? '● partial' : '● n/a';
  }
  selectedName(): string {
    const id = this.catalog.selectedId();
    return id ? (getCatalogEntry(id)?.name ?? 'Avatar') : 'Avatar';
  }
  triggerTitle(): string { return `Avatar: ${this.selectedName()}`; }
  cardTitle(id: string): string {
    const c = this.confOf(id);
    const name = getCatalogEntry(id)?.name ?? id;
    return c ? `${name} — ${conformanceLabel(c)}` : name;
  }
  selectedReport(): RigReport | undefined {
    const id = this.catalog.selectedId();
    return id ? this.catalog.getReport(id) : undefined;
  }
  entryOf(id: string): AvatarCatalogEntry | undefined { return getCatalogEntry(id); }
}
