import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { RagAdminService } from '../../services/rag-admin.service';
import { AdminService } from '../../services/admin.service';
import { RagChunkListComponent } from './components/rag-chunk-list.component';
import { RagMediaManagerComponent } from './components/rag-media-manager.component';
import { RagDocument, RagNamespace } from '../../lib/rag/rag-admin.models';
import { environment } from '../../../environments/environment';

type Tab = 'documents' | 'chunks' | 'media';

/**
 * Admin-only RAG management panel (visual rebuild to match the new design).
 *
 * LAYOUT FIX: full-viewport flex shell -- a fixed top bar, then a flex row
 * (height-constrained via min-height:0) holding a full-height scrolling sidebar
 * and a flex-1 scrolling content area. This replaces the previous layout that
 * collapsed (sidebar flowing to the bottom).
 *
 * All data flows are unchanged -- every action calls the same RagAdminService /
 * ingestDocument / Firestore methods as before. Cosmetic-only / stubbed elements
 * are marked "PLACEHOLDER" in the template.
 */
@Component({
  selector: 'app-rag-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, RagChunkListComponent, RagMediaManagerComponent],
  template: `
    <div class="shell">
      <!-- ===================== TOP BAR ===================== -->
      <header class="topbar">
        <div class="brand"><span class="logo">DB</span> RAG Admin</div>
        <div class="topnav">
          <a class="tlink" routerLink="/text-avatar">Text-Avatar</a>
          <!-- PLACEHOLDER: decorative profile (no profile page) -->
          <span class="tprofile">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/>
            </svg>
            Admin Profile
          </span>
        </div>
      </header>

      <!-- ===================== BODY ===================== -->
      <div class="body">
        <div class="denied" *ngIf="!allowed()">You do not have admin access to this panel.</div>

        <ng-container *ngIf="allowed()">
          <!-- ---------- SIDEBAR ---------- -->
          <aside class="sidebar">
            <div class="side-label">Namespaces</div>

            <div class="ns-loading" *ngIf="loadingNs()"><span class="spin"></span> Loading...</div>

            <div class="ns-list" *ngIf="!loadingNs()">
              <button class="ns-row" *ngFor="let n of namespaces()"
                      [class.sel]="n.id === selectedNs()" (click)="selectNs(n.id)">
                <svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                </svg>
                <span class="ns-name">{{ n.name || n.id }}</span>
                <span class="ns-badge" *ngIf="n.chunkCount != null">{{ n.chunkCount }}</span>
                <span class="ns-tab"></span>
              </button>

              <div class="ns-empty" *ngIf="!namespaces().length">No namespaces yet - create your first one below.</div>
            </div>

            <div class="ns-add">
              <input type="text" [(ngModel)]="newNs" placeholder="New namespace..."
                     (keydown.enter)="createNs()" />
              <button class="btn primary block" (click)="createNs()" [disabled]="!newNs.trim() || busyNs()">
                {{ busyNs() ? 'Adding...' : '+ Add Namespace' }}
              </button>
            </div>

            <div class="side-sep"></div>

            <nav class="sidenav">
              <button class="nav-row" [class.sel]="tab() === 'documents'" [disabled]="!selectedNs()" (click)="tab.set('documents')">
                <svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>
                </svg> Documents
              </button>
              <button class="nav-row" [class.sel]="tab() === 'chunks'" [disabled]="!selectedNs()" (click)="tab.set('chunks')">
                <svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
                  <path d="M4 6h16M4 12h16M4 18h10"/>
                </svg> Chunks
              </button>
              <button class="nav-row" [class.sel]="tab() === 'media'" [disabled]="!selectedNs()" (click)="tab.set('media')">
                <svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
                  <rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="1.6"/><path d="M21 17l-5-5L5 21"/>
                </svg> Media
              </button>
              <!-- PLACEHOLDER: Settings has no logic -->
              <button class="nav-row disabled" disabled title="Not implemented">
                <svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7">
                  <circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1l-.3-2.6h-4l-.3 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L4.1 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.3 2.6h4l.3-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z"/>
                </svg> Settings
              </button>
            </nav>
          </aside>

          <!-- ---------- CONTENT ---------- -->
          <main class="content">
            <!-- loading namespaces -->
            <div class="state" *ngIf="loadingNs()"><span class="spin big"></span><p>Loading namespaces...</p></div>

            <!-- no namespace selected (covers fresh/empty DB) -->
            <div class="hero-empty" *ngIf="!loadingNs() && !selectedNs()">
              <div class="he-icon">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                </svg>
              </div>
              <h2>{{ namespaces().length ? 'Select a namespace' : 'No namespaces yet' }}</h2>
              <p *ngIf="!namespaces().length">Create your first namespace to start uploading and ingesting PDFs.</p>
              <p *ngIf="namespaces().length">Choose a namespace from the left to manage its documents, chunks and media.</p>
              <div class="he-create" *ngIf="!namespaces().length">
                <input type="text" [(ngModel)]="newNs" placeholder="namespace-id (e.g. terapia)" (keydown.enter)="createNs()" />
                <button class="btn primary" (click)="createNs()" [disabled]="!newNs.trim() || busyNs()">
                  {{ busyNs() ? 'Creating...' : 'Create namespace' }}
                </button>
              </div>
              <p class="err" *ngIf="error()">{{ error() }}</p>
            </div>

            <!-- ===== a namespace is selected ===== -->
            <ng-container *ngIf="selectedNs() as ns">
              <!-- ====== DOCUMENTS ====== -->
              <section *ngIf="tab() === 'documents'" class="view">
                <div class="crumb">Knowledge Base <i>&gt;</i> <b>{{ ns }}</b> <i>&gt;</i> Documents</div>
                <h1 class="vtitle">Namespace: {{ ns }}</h1>
                <p class="vsub">Manage and ingest documents into your vector database.</p>

                <!-- Dropzone (PDF only; TXT/DOCX not supported in phase one) -->
                <label class="dropzone" (dragover)="onDragOver($event)" (drop)="onDrop($event)">
                  <input type="file" accept="application/pdf,.pdf" (change)="onPdf($event)" hidden />
                  <span class="dz-icon">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>
                      <path d="M12 18v-6M9.5 14.5 12 12l2.5 2.5"/>
                    </svg>
                  </span>
                  <span class="dz-title">{{ pendingFile?.name || 'Upload PDF' }}</span>
                  <span class="dz-sub">Drag and drop your file here, or click to browse</span>
                  <span class="dz-hints"><span class="hint">Max size: depends on Storage</span><span class="hint">Format: PDF</span></span>
                </label>

                <div class="up-actions" *ngIf="pendingFile">
                  <button class="btn primary" (click)="uploadPdf()" [disabled]="uploading()">
                    {{ uploading() ? 'Uploading ' + uploadPct() + '%' : 'Upload ' + pendingFile.name }}
                  </button>
                  <button class="btn ghost" (click)="pendingFile = null" [disabled]="uploading()">Clear</button>
                  <div class="bar" *ngIf="uploading()"><i [style.width.%]="uploadPct()"></i></div>
                </div>
                <p class="err" *ngIf="error()">{{ error() }}</p>

                <!-- Inventory -->
                <div class="card">
                  <div class="card-head">
                    <h3>Document Inventory</h3>
                    <div class="search">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>
                      <input type="text" [(ngModel)]="docSearch" placeholder="Search files..." />
                    </div>
                  </div>

                  <div class="state sm" *ngIf="loadingDocs()"><span class="spin"></span><p>Loading documents...</p></div>

                  <div class="docs-empty" *ngIf="!loadingDocs() && !documents().length">
                    <div class="de-icon">
                      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>
                    </div>
                    <div class="de-title">No documents yet</div>
                    <div class="de-text">Upload a PDF above to start indexing chunks for this namespace.</div>
                  </div>

                  <table class="docs" *ngIf="!loadingDocs() && documents().length">
                    <thead>
                      <tr><th>File name</th><th>Size</th><th>Created</th><th>Status</th><th>Chunks</th><th class="ar">Actions</th></tr>
                    </thead>
                    <tbody>
                      <tr *ngFor="let d of filteredDocs()">
                        <td class="fn">
                          <svg class="fic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>
                          <span [title]="d.storagePath">{{ d.filename }}</span>
                        </td>
                        <td>{{ fmtSize(d.size) }}</td>
                        <td>{{ fmtDate(d.uploadedAt) }}</td>
                        <td>
                          <span class="st" [ngClass]="'st-' + d.status">{{ statusLabel(d) }}</span>
                          <div class="st-err" *ngIf="d.status === 'error' && d.error" [title]="d.error">{{ d.error }}</div>
                        </td>
                        <td>{{ d.chunks ?? 0 }}</td>
                        <td class="act">
                          <button class="btn sm" (click)="ingest(d)" [disabled]="d.status === 'processing'">
                            {{ d.status === 'processing' ? '...' : (d.status === 'done' || d.status === 'error' ? 'Re-ingest' : 'Ingest') }}
                          </button>
                          <button class="iconbtn" title="View chunks" (click)="inspect(d)">
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
                          </button>
                          <button class="iconbtn danger" title="Delete" (click)="remove(d)" [disabled]="d.status === 'processing'">
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <div class="card-foot" *ngIf="!loadingDocs() && documents().length">
                    <span>Showing {{ filteredDocs().length }} of {{ documents().length }} documents</span>
                  </div>
                </div>
              </section>

              <!-- ====== CHUNKS ====== -->
              <section *ngIf="tab() === 'chunks'" class="view">
                <div class="crumb">Knowledge Base <i>&gt;</i> <b>{{ ns }}</b> <i>&gt;</i> Chunks</div>
                <h1 class="vtitle">Data Chunks</h1>
                <p class="vsub">Read-only inspection of ingested chunks and their vectors.</p>

                <div class="chunkfilter" *ngIf="chunkDocId()">
                  Showing chunks for one document.
                  <button class="btn ghost sm" (click)="chunkDocId.set(undefined)">Show all</button>
                </div>

                <div class="card pad">
                  <app-rag-chunk-list [namespace]="ns" [docId]="chunkDocId()"
                                      (navigateToDocuments)="tab.set('documents')"></app-rag-chunk-list>
                </div>
              </section>

              <!-- ====== MEDIA ====== -->
              <section *ngIf="tab() === 'media'" class="view">
                <div class="crumb">Knowledge Base <i>&gt;</i> <b>{{ ns }}</b> <i>&gt;</i> Media</div>
                <h1 class="vtitle">Media Library</h1>
                <p class="vsub">Manage media assets shown in the Text-Avatar popups for this namespace.</p>

                <div class="card pad">
                  <app-rag-media-manager [namespace]="ns" [documents]="documents()"></app-rag-media-manager>
                </div>
              </section>
            </ng-container>
          </main>
        </ng-container>
      </div>

      <!-- ===================== FOOTER ===================== -->
      <footer class="footbar" *ngIf="allowed()">
        <span>RAG Admin Orchestrator</span>
        <span class="flinks">Documentation &middot; API Reference &middot; Support</span>
      </footer>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    * { box-sizing: border-box; }

    .shell { height: 100%; display: flex; flex-direction: column;
      background: #0a0e14; color: #e6e8ee;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      --accent: #8b5cf6; --accent2: #a78bfa; --card: #121823; --line: rgba(255,255,255,.08); }

    /* top bar */
    .topbar { flex: none; height: 60px; display: flex; align-items: center; justify-content: space-between;
      padding: 0 22px; border-bottom: 1px solid var(--line); }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; letter-spacing: .3px; }
    .logo { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px;
      background: rgba(139,92,246,.22); color: var(--accent2); font-size: 11px; font-weight: 700; }
    .topnav { display: flex; align-items: center; gap: 18px; font-size: 13.5px; }
    .tlink { color: #c7ccd6; text-decoration: none; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); }
    .tlink:hover { background: rgba(255,255,255,.05); color: #fff; }
    .tprofile { display: flex; align-items: center; gap: 7px; color: #aeb4c0; }

    /* body: full-height flex row (THE layout fix) */
    .body { flex: 1; display: flex; min-height: 0; }
    .denied { margin: auto; color: #ffb3b3; font-size: 15px; }

    /* sidebar */
    .sidebar { width: 260px; flex: none; height: 100%; overflow-y: auto;
      border-right: 1px solid var(--line); padding: 16px 14px; display: flex; flex-direction: column; gap: 8px; }
    .side-label { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #6b7384;
      font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; margin-bottom: 2px; }
    .ns-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8b93a3; padding: 6px 2px; }
    .ns-list { display: flex; flex-direction: column; gap: 6px; }
    .ns-row { position: relative; display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
      padding: 9px 11px; border-radius: 10px; cursor: pointer; font-size: 13.5px;
      background: transparent; border: 1px solid transparent; color: #c7ccd6; }
    .ns-row:hover { background: rgba(255,255,255,.04); }
    .ns-row.sel { background: rgba(139,92,246,.16); border-color: rgba(139,92,246,.4); color: #fff; }
    .ns-row .ic { flex: none; color: #9aa2b1; }
    .ns-row.sel .ic { color: var(--accent2); }
    .ns-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ns-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: rgba(255,255,255,.08); color: #aeb4c0; }
    .ns-tab { position: absolute; right: -14px; top: 50%; transform: translateY(-50%); width: 3px; height: 22px;
      border-radius: 3px; background: transparent; }
    .ns-row.sel .ns-tab { background: var(--accent); }
    .ns-empty { font-size: 12px; color: #6b7384; padding: 8px 2px; line-height: 1.5; }

    .ns-add { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .ns-add input { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid var(--line);
      border-radius: 9px; padding: 9px 11px; font-size: 12.5px; }

    .side-sep { height: 1px; background: var(--line); margin: 12px 0; }
    .sidenav { display: flex; flex-direction: column; gap: 4px; }
    .nav-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 9px 11px;
      border-radius: 10px; cursor: pointer; font-size: 13.5px; background: transparent; border: 1px solid transparent; color: #c7ccd6; }
    .nav-row:hover:not(:disabled) { background: rgba(255,255,255,.04); }
    .nav-row.sel { background: rgba(139,92,246,.16); border-color: rgba(139,92,246,.4); color: #fff; }
    .nav-row .ic { color: #9aa2b1; flex: none; }
    .nav-row.sel .ic { color: var(--accent2); }
    .nav-row:disabled { opacity: .4; cursor: not-allowed; }

    /* content */
    .content { flex: 1; min-width: 0; height: 100%; overflow-y: auto; padding: 22px 26px; }
    .state { display: flex; flex-direction: column; align-items: center; gap: 12px; color: #8b93a3; font-size: 14px; margin-top: 70px; }
    .state.sm { margin: 24px 0; }
    .spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.15); border-top-color: var(--accent);
      border-radius: 50%; display: inline-block; animation: raspin 1s linear infinite; }
    .spin.big { width: 30px; height: 30px; border-width: 3px; }
    @keyframes raspin { to { transform: rotate(360deg); } }

    .hero-empty { max-width: 480px; margin: 70px auto 0; text-align: center; background: var(--card);
      border: 1px solid var(--line); border-radius: 16px; padding: 32px 26px; }
    .he-icon { width: 54px; height: 54px; margin: 0 auto 14px; display: grid; place-items: center; border-radius: 14px;
      background: rgba(139,92,246,.16); color: var(--accent2); }
    .hero-empty h2 { margin: 0 0 6px; font-size: 19px; }
    .hero-empty p { margin: 0 0 16px; font-size: 13px; color: #8b93a3; line-height: 1.5; }
    .he-create { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
    .he-create input { flex: 1; min-width: 200px; max-width: 280px; background: rgba(255,255,255,.05); color: #e6e8ee;
      border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; font-size: 13px; }

    .crumb { font-size: 12px; color: #6b7384; font-family: ui-monospace, Menlo, monospace; margin-bottom: 8px; }
    .crumb i { color: #495063; font-style: normal; padding: 0 4px; }
    .crumb b { color: #aeb4c0; font-weight: 600; }
    .vtitle { margin: 0 0 4px; font-size: 26px; font-weight: 700; }
    .vsub { margin: 0 0 18px; font-size: 13.5px; color: #8b93a3; }

    /* dropzone */
    .dropzone { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; cursor: pointer;
      border: 1.5px dashed rgba(139,92,246,.4); border-radius: 14px; padding: 30px 20px; background: rgba(139,92,246,.04); }
    .dropzone:hover { background: rgba(139,92,246,.08); border-color: rgba(139,92,246,.6); }
    .dz-icon { width: 56px; height: 56px; display: grid; place-items: center; border-radius: 50%;
      background: rgba(139,92,246,.16); color: var(--accent2); margin-bottom: 4px; }
    .dz-title { font-size: 17px; font-weight: 700; }
    .dz-sub { font-size: 13px; color: #8b93a3; }
    .dz-hints { display: flex; gap: 8px; margin-top: 6px; }
    .hint { font-size: 11px; color: #8b93a3; background: rgba(255,255,255,.05); border: 1px solid var(--line);
      border-radius: 7px; padding: 4px 9px; font-family: ui-monospace, Menlo, monospace; }
    .up-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .bar { height: 6px; flex-basis: 100%; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; }
    .bar i { display: block; height: 100%; background: var(--accent); transition: width .15s; }

    /* cards */
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; margin-top: 20px; overflow: hidden; }
    .card.pad { padding: 16px; }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; }
    .card-head h3 { margin: 0; font-size: 16px; font-weight: 700; }
    .search { display: flex; align-items: center; gap: 7px; background: rgba(255,255,255,.04); border: 1px solid var(--line);
      border-radius: 9px; padding: 7px 11px; color: #8b93a3; min-width: 240px; }
    .search input { background: transparent; border: none; outline: none; color: #e6e8ee; font-size: 12.5px; width: 100%; }

    table.docs { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.docs th { text-align: left; color: #6b7384; font-weight: 600; font-size: 11px; letter-spacing: .5px;
      text-transform: uppercase; padding: 10px 16px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
      font-family: ui-monospace, Menlo, monospace; }
    table.docs th.ar { text-align: right; }
    table.docs td { padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.05); vertical-align: middle; }
    .fn { display: flex; align-items: center; gap: 9px; max-width: 320px; }
    .fn span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fic { color: var(--accent2); flex: none; }
    .act { display: flex; gap: 7px; justify-content: flex-end; align-items: center; }
    .st { font-size: 11px; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
    .st-not-ingested { background: rgba(255,255,255,.08); color: #aeb4c0; }
    .st-processing { background: rgba(217,164,64,.18); color: #f0c674; }
    .st-done { background: rgba(52,211,153,.16); color: #6ee7b7; }
    .st-error { background: rgba(248,113,113,.16); color: #fca5a5; }
    .st-err { font-size: 10.5px; color: #fca5a5; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-foot { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; font-size: 12px; color: #6b7384; }

    .docs-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 240px; text-align: center; padding: 20px; }
    .de-icon { width: 52px; height: 52px; display: grid; place-items: center; border-radius: 14px; background: rgba(255,255,255,.04); color: #6b7384; margin-bottom: 12px; }
    .de-title { font-size: 15px; font-weight: 600; color: #d7dae2; margin-bottom: 6px; }
    .de-text { font-size: 13px; color: #8b93a3; }
    .chunkfilter { font-size: 12.5px; color: #8b93a3; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
    .err { color: #ff9c9c; font-size: 12.5px; margin: 8px 0 0; }

    /* buttons */
    .btn { padding: 8px 14px; border-radius: 9px; cursor: pointer; font-size: 12.5px; white-space: nowrap;
      background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover:not(:disabled) { background: #7c4ff0; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: var(--line); color: #cdd2db; }
    .btn.block { width: 100%; text-align: center; }
    .btn.sm { padding: 5px 11px; font-size: 11.5px; }
    .iconbtn { display: grid; place-items: center; width: 30px; height: 28px; border-radius: 8px; cursor: pointer;
      background: rgba(255,255,255,.05); border: 1px solid var(--line); color: #aeb4c0; }
    .iconbtn:hover:not(:disabled) { background: rgba(255,255,255,.1); color: #fff; }
    .iconbtn.danger:hover:not(:disabled) { background: rgba(179,57,57,.25); color: #ffb3b3; }
    .iconbtn:disabled { opacity: .4; cursor: default; }

    /* footer */
    .footbar { flex: none; height: 40px; display: flex; align-items: center; justify-content: space-between;
      padding: 0 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: #6b7384; }

    @media (max-width: 860px) {
      .body { flex-direction: column; }
      .sidebar { width: auto; height: auto; border-right: none; border-bottom: 1px solid var(--line); }
      .content { height: auto; }
    }
  `]
})
export class RagAdminComponent implements OnInit {
  admin = inject(AdminService);
  private svc = inject(RagAdminService);

  readonly namespaces = signal<RagNamespace[]>([]);
  readonly selectedNs = signal<string>('');
  readonly documents = signal<RagDocument[]>([]);
  readonly tab = signal<Tab>('documents');
  readonly chunkDocId = signal<string | undefined>(undefined);

  readonly loadingNs = signal(false);
  readonly loadingDocs = signal(false);
  readonly busyNs = signal(false);
  readonly uploading = signal(false);
  readonly uploadPct = signal(0);
  readonly error = signal('');

  /** Client-side document search over the already-loaded list (no extra query). */
  readonly docSearch = signal('');
  readonly filteredDocs = computed(() => {
    const q = this.docSearch().trim().toLowerCase();
    const docs = this.documents();
    return q ? docs.filter((d) => (d.filename || '').toLowerCase().includes(q)) : docs;
  });

  newNs = '';
  pendingFile: File | null = null;

  /**
   * Access allowed when role enforcement is off (dev) or the user is admin.
   * Computed signal so the template re-evaluates reliably under zoneless CD.
   */
  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (this.allowed()) await this.loadNamespaces();
  }

  async loadNamespaces(): Promise<void> {
    this.loadingNs.set(true);
    try {
      this.namespaces.set(await this.svc.listNamespaces());
      if (!this.selectedNs() && this.namespaces().length) this.selectNs(this.namespaces()[0].id);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loadingNs.set(false);
    }
  }

  async createNs(): Promise<void> {
    const id = this.newNs.trim();
    if (!id) return;
    this.busyNs.set(true);
    this.error.set('');
    try {
      const ns = await this.svc.createNamespace(id);
      if (!this.namespaces().some((n) => n.id === ns.id)) {
        this.namespaces.update((cur) => [...cur, ns].sort((a, b) => a.id.localeCompare(b.id)));
      }
      this.newNs = '';
      this.selectNs(ns.id);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.busyNs.set(false);
    }
  }

  selectNs(id: string): void {
    this.selectedNs.set(id);
    this.chunkDocId.set(undefined);
    this.docSearch.set('');
    this.tab.set('documents');
    void this.loadDocuments();
  }

  async loadDocuments(): Promise<void> {
    const ns = this.selectedNs();
    if (!ns) return;
    this.loadingDocs.set(true);
    try {
      this.documents.set(await this.svc.listDocuments(ns));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loadingDocs.set(false);
    }
  }

  onPdf(e: Event): void {
    this.pendingFile = (e.target as HTMLInputElement).files?.[0] ?? null;
  }

  /** Drag-and-drop into the dropzone -> reuse the same upload flow. */
  onDragOver(e: DragEvent): void {
    e.preventDefault();
  }
  onDrop(e: DragEvent): void {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      this.pendingFile = f;
      void this.uploadPdf();
    }
  }

  async uploadPdf(): Promise<void> {
    const ns = this.selectedNs();
    if (!ns || !this.pendingFile) return;
    this.uploading.set(true);
    this.uploadPct.set(0);
    this.error.set('');
    try {
      const d = await this.svc.uploadPdf(ns, this.pendingFile, (p) => this.uploadPct.set(p.percent));
      this.documents.update((cur) => [d, ...cur]);
      this.pendingFile = null;
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.uploading.set(false);
    }
  }

  /** Non-blocking ingest: flip local status to processing, then reflect result. */
  async ingest(d: RagDocument): Promise<void> {
    this.patchDoc(d.id, { status: 'processing', error: undefined });
    this.error.set('');
    try {
      const res = await this.svc.ingest(d);
      this.patchDoc(d.id, {
        status: res.status === 'done' ? 'done' : 'error',
        chunks: res.chunks,
        error: res.status === 'error' ? res.message : undefined,
      });
    } catch (e: any) {
      this.patchDoc(d.id, { status: 'error', error: e?.message ?? String(e) });
    }
  }

  inspect(d: RagDocument): void {
    this.chunkDocId.set(d.id);
    this.tab.set('chunks');
  }

  async remove(d: RagDocument): Promise<void> {
    if (!confirm(`Delete "${d.filename}"? Removes the PDF and (best-effort) its chunks.`)) return;
    try {
      await this.svc.deleteDocument(d, true);
      this.documents.update((cur) => cur.filter((x) => x.id !== d.id));
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    }
  }

  private patchDoc(id: string, patch: Partial<RagDocument>): void {
    this.documents.update((cur) => cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  statusLabel(d: RagDocument): string {
    switch (d.status) {
      case 'not-ingested': return 'not ingested';
      case 'processing': return 'processing';
      case 'done': return 'done';
      case 'error': return 'error';
    }
  }

  fmtSize(bytes: number): string {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  fmtDate(ms?: number): string {
    return ms ? new Date(ms).toLocaleDateString() : '-';
  }
}
