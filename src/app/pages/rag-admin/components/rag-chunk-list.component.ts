import { Component, Input, OnChanges, SimpleChanges, Output, EventEmitter, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RagAdminService } from '../../../services/rag-admin.service';
import { RagChunk } from '../../../lib/rag/rag-admin.models';

/**
 * Read-only, paginated chunk inspector for rag/{namespace}/chunks.
 * Lets an admin verify ingestion: text preview, ordinal, source docId, vector
 * presence, metadata. Pagination is cursor-based (stable by document id).
 */
@Component({
  selector: 'app-rag-chunk-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ck">
      <div class="ck-head">
        <span class="ck-title">Chunks</span>
        <span class="ck-count" *ngIf="total() !== null">{{ total() }} total</span>
        <span class="ck-filter" *ngIf="docId">filtered by doc: <code>{{ docId }}</code></span>
        <button class="btn ghost sm" (click)="reload()" [disabled]="loading()">Refresh</button>
      </div>

      <div class="ck-empty-container" *ngIf="!loading() && !chunks().length">
        <div class="ck-empty">
          <div class="ck-empty-icon">∅</div>
          <div class="ck-empty-title">{{ docId ? 'No chunks for this document' : 'No chunks yet' }}</div>
          <div class="ck-empty-text">
            {{ docId 
              ? 'This document has not been ingested. Go to Documents tab and run ingest.'
              : 'No documents have been ingested. Upload and ingest a PDF in the Documents tab to get started.'
            }}
          </div>
          <button class="btn" (click)="goToDocuments()">Go to Documents</button>
        </div>
      </div>

      <div class="ck-row" *ngFor="let c of chunks()">
        <div class="ck-meta">
          <span class="tag" *ngIf="c.index !== undefined">#{{ c.index }}</span>
          <span class="tag vec" [class.no]="!c.hasVector">{{ c.hasVector ? 'vector' : 'no vector' }}</span>
          <span class="tag doc" *ngIf="c.docId" [title]="c.docId">doc: {{ shortId(c.docId) }}</span>
          <span class="tag id" [title]="c.id">id: {{ shortId(c.id) }}</span>
        </div>
        <div class="ck-text">{{ preview(c) }}</div>
        <div class="ck-mkeys" *ngIf="metaKeys(c).length">meta: {{ metaKeys(c).join(', ') }}</div>
      </div>

      <div class="ck-foot">
        <button class="btn" (click)="loadMore()" [disabled]="loading() || !hasMore()">
          {{ loading() ? 'Loading...' : (hasMore() ? 'Load more' : 'No more') }}
        </button>
        <span class="ck-shown">{{ chunks().length }} shown</span>
      </div>

      <div class="ck-err" *ngIf="error()">{{ error() }}</div>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .ck { display: flex; flex-direction: column; gap: 8px; }
    .ck-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .ck-title { font-weight: 600; font-size: 14px; }
    .ck-count { font-size: 12px; color: #8ab4f8; }
    .ck-filter { font-size: 12px; color: #99a; }
    
    .ck-empty-container { display: flex; align-items: center; justify-content: center; min-height: 280px; padding: 20px; }
    .ck-empty { text-align: center; max-width: 320px; }
    .ck-empty-icon { font-size: 48px; margin-bottom: 12px; opacity: .6; }
    .ck-empty-title { font-size: 15px; font-weight: 600; color: #d7dae2; margin-bottom: 8px; }
    .ck-empty-text { font-size: 13px; color: #99a; line-height: 1.5; margin-bottom: 14px; }
    
    .ck-row { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
    .ck-meta { display: flex; gap: 6px; flex-wrap: wrap; }
    .tag { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: rgba(139,92,246,.15);
      border: 1px solid rgba(139,92,246,.3); color: #c4b0f7; white-space: nowrap; }
    .tag.vec { background: rgba(52,211,153,.14); border-color: rgba(52,211,153,.3); color: #6ee7b7; }
    .tag.vec.no { background: rgba(248,113,113,.12); border-color: rgba(248,113,113,.3); color: #fca5a5; }
    .tag.doc, .tag.id { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); color: #aab; }
    .ck-text { font-size: 12.5px; line-height: 1.5; color: #d7dae2; white-space: pre-wrap; }
    .ck-mkeys { font-size: 11px; color: #778; }
    .ck-foot { display: flex; align-items: center; gap: 12px; padding-top: 4px; }
    .ck-shown { font-size: 11px; color: #667; }
    .ck-err { color: #ff9c9c; font-size: 12.5px; }
    code { background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
    .btn { padding: 7px 14px; border-radius: 9px; cursor: pointer; font-size: 12.5px;
      background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #c4b0f7; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); color: #cdd; }
    .btn.sm { padding: 4px 10px; font-size: 11.5px; }
  `]
})
export class RagChunkListComponent implements OnChanges {
  /** namespace to inspect */
  @Input({ required: true }) namespace!: string;
  /** optional doc filter */
  @Input() docId?: string;
  /** chunks per page */
  @Input() pageSize = 25;

  @Output() navigateToDocuments = new EventEmitter<void>();

  private admin = inject(RagAdminService);

  readonly chunks = signal<RagChunk[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly total = signal<number | null>(null);
  private cursor: unknown | null = null;
  private done = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['namespace'] || changes['docId']) this.reload();
  }

  hasMore(): boolean { return !this.done; }

  goToDocuments(): void {
    this.navigateToDocuments.emit();
  }

  reload(): void {
    this.chunks.set([]);
    this.cursor = null;
    this.done = false;
    this.total.set(null);
    if (!this.namespace) return;
    void this.loadMore();
    void this.refreshCount();
  }

  async loadMore(): Promise<void> {
    if (this.loading() || this.done || !this.namespace) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const page = await this.admin.listChunks(this.namespace, {
        pageSize: this.pageSize,
        cursor: this.cursor,
        docId: this.docId,
      });
      this.chunks.update((cur) => [...cur, ...page.chunks]);
      this.cursor = page.nextCursor;
      this.done = page.nextCursor === null;
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
      this.done = true;
    } finally {
      this.loading.set(false);
    }
  }

  private async refreshCount(): Promise<void> {
    try {
      this.total.set(await this.admin.countChunks(this.namespace, this.docId));
    } catch {
      this.total.set(null);
    }
  }

  preview(c: RagChunk): string {
    const t = c.text || '';
    return t.length > 320 ? t.slice(0, 320) + '...' : t;
  }
  metaKeys(c: RagChunk): string[] {
    return c.metadata ? Object.keys(c.metadata) : [];
  }
  shortId(id: string): string {
    return id.length > 10 ? id.slice(0, 8) + '...' : id;
  }
}
