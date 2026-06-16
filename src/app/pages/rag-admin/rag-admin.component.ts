import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { RagAdminService } from '../../services/rag-admin.service';
import { AdminService } from '../../services/admin.service';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { ImageOptimizationService } from '../../services/image-optimization.service';
import { RagChunkListComponent } from './components/rag-chunk-list.component';
import { RagMediaManagerComponent } from './components/rag-media-manager.component';
import { MediaType, RagDocument, RagMediaRecord, RagNamespace } from '../../lib/rag/rag-admin.models';
import { AssistantConfig } from '../../lib/rag/rag.models';
import { environment } from '../../../environments/environment';

type Tab = 'documents' | 'chunks' | 'media';

/** One editable + independently-uploadable media row in the per-document editor. */
interface MediaRow {
  id: string;
  type: MediaType;
  title: string;
  description: string;
  file: File | null;
  keepOriginal: boolean;
  status: 'idle' | 'optimizing' | 'thumbnailing' | 'uploading' | 'done' | 'error';
  pct: number;
  sizeInfo?: string;
  error?: string;
}

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
          <a class="tlink" routerLink="/admin">&larr; Admin</a>
          <a class="tlink" routerLink="/text-avatar">Text-Avatar</a>
          <a class="tlink" routerLink="/llm-admin">LLM Admin</a>
          <a class="tlink" routerLink="/role-admin">Roles</a>
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
          <!-- ---------- SIDEBAR (assistant selector) ---------- -->
          <aside class="sidebar">
            <div class="side-label">Assistants</div>

            <div class="ns-loading" *ngIf="loadingNs()"><span class="spin"></span> Loading...</div>

            <!-- Each assistant owns a 1:1 RAG namespace (ragCollection). Selecting an
                 assistant drives uploads/ingestion into THAT assistant's namespace. -->
            <div class="ns-list" *ngIf="!loadingNs()">
              <button class="as-row" *ngFor="let a of assistants()"
                      [class.sel]="a.id === selectedAssistantId()" (click)="selectAssistant(a)">
                <span class="as-thumb">
                  <img *ngIf="thumbs()[a.id]; else asInitial" [src]="thumbs()[a.id]" alt="" />
                  <ng-template #asInitial>{{ (a.name || a.id).charAt(0).toUpperCase() }}</ng-template>
                </span>
                <span class="as-meta">
                  <span class="as-name">{{ a.name || a.id }}</span>
                  <span class="as-role">{{ a.role || a.ragCollection }}</span>
                </span>
                <span class="ns-tab"></span>
              </button>

              <div class="ns-empty" *ngIf="!assistants().length">
                No assistants yet - create one in the Assistant Manager.
              </div>
            </div>

            <a class="btn ghost block mgr-link" routerLink="/assistant-manager">Manage assistants</a>

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

            <!-- no assistant selected (covers fresh/empty DB) -->
            <div class="hero-empty" *ngIf="!loadingNs() && !selectedNs()">
              <div class="he-icon">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6">
                  <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/>
                </svg>
              </div>
              <h2>{{ assistants().length ? 'Select an assistant' : 'No assistants yet' }}</h2>
              <p *ngIf="!assistants().length">Create an assistant in the Assistant Manager; each one owns its own RAG namespace for uploading and ingesting PDFs.</p>
              <p *ngIf="assistants().length">Choose an assistant from the left to manage the documents, chunks and media in its namespace.</p>
              <div class="he-create" *ngIf="!assistants().length">
                <a class="btn primary" routerLink="/assistant-manager">Open Assistant Manager</a>
              </div>
              <p class="err" *ngIf="error()">{{ error() }}</p>
            </div>

            <!-- ===== a namespace is selected ===== -->
            <ng-container *ngIf="selectedNs() as ns">
              <!-- ====== DOCUMENTS ====== -->
              <section *ngIf="tab() === 'documents'" class="view">
                <div class="crumb">{{ selectedAssistantName() }} <i>&gt;</i> <b>{{ ns }}</b> <i>&gt;</i> Documents</div>
                <h1 class="vtitle">{{ selectedAssistantName() }}</h1>
                <p class="vsub">Uploading and ingesting into namespace <b>{{ ns }}</b> (this assistant's knowledge base).</p>

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
                      <ng-container *ngFor="let d of filteredDocs()">
                      <tr>
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
                          <button class="btn sm" [class.on]="openMediaDocId() === d.id" title="Attach media" (click)="toggleMedia(d)">Media ({{ (docMedia()[d.id] || []).length }})</button>
                          <button class="iconbtn danger" title="Delete" (click)="remove(d)" [disabled]="d.status === 'processing'">
                            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>
                          </button>
                        </td>
                      </tr>

                      <!-- ===== per-document attached media ===== -->
                      <tr class="mediarow" *ngIf="openMediaDocId() === d.id">
                        <td colspan="6">
                          <div class="mediapanel">
                            <div class="mp-head">Media adjunta a <b>{{ d.filename }}</b>
                              <span class="hint">se mostrara solo cuando este documento sea relevante y el LLM lo elija</span>
                            </div>
                            <div class="mp-list" *ngIf="(docMedia()[d.id] || []).length">
                              <div class="mp-item" *ngFor="let m of docMedia()[d.id]">
                                <span class="mp-type">{{ m.type }}</span>
                                <span class="mp-title">{{ m.title }}</span>
                                <span class="mp-desc" [title]="m.description || m.caption">{{ m.description || m.caption || '(sin descripcion)' }}</span>
                                <label class="mp-en"><input type="checkbox" [checked]="m.enabled !== false" (change)="toggleMediaEnabled(d, m, $event)" /> activo</label>
                                <button class="iconbtn danger" title="Eliminar" (click)="deleteDocMedia(d, m)">✕</button>
                              </div>
                            </div>
                            <!-- one editable row per file to attach -->
                            <div class="mp-editor">
                              <div class="mp-erow" *ngFor="let r of mediaRows(); trackBy: trackRow">
                                <select [(ngModel)]="r.type"><option value="image">Imagen</option><option value="video">Video</option><option value="document">Documento</option></select>
                                <input type="text" [(ngModel)]="r.title" placeholder="Titulo" />
                                <input type="text" [(ngModel)]="r.description" placeholder="Descripcion (la usa el LLM)" />
                                <input type="file" (change)="onRowFile(r, $event)" />
                                <label class="mp-en" *ngIf="r.type === 'image'" title="Subir sin comprimir"><input type="checkbox" [(ngModel)]="r.keepOriginal" /> Original</label>
                                <span class="mp-st" [class.ok]="r.status==='done'" [class.bad]="r.status==='error'">{{ rowStatus(r) }}</span>
                                <div class="mp-bar mini" *ngIf="r.status==='uploading'"><i [style.width.%]="r.pct"></i></div>
                                <button class="btn xs primary" (click)="uploadRow(d, r)" [disabled]="!r.file || rowBusy(r) || r.status==='done'">{{ r.status==='error' ? 'Reintentar' : 'Adjuntar' }}</button>
                                <button class="ix danger" title="Quitar fila" (click)="removeRow(r.id)">✕</button>
                              </div>
                              <div class="mp-erow empty" *ngIf="!mediaRows().length"><span class="hint">Agrega una fila o selecciona archivos.</span></div>
                            </div>
                            <div class="mp-rowbtns">
                              <button class="btn ghost xs" (click)="addRow()">+ Agregar fila</button>
                              <label class="btn ghost xs filepick">Seleccionar varios<input type="file" multiple hidden (change)="onMultiPick($event)" /></label>
                              <button class="btn sm primary" (click)="uploadAll(d)" [disabled]="!hasPendingRows() || anyRowBusy()">Cargar todos</button>
                            </div>
                            <p class="err" *ngIf="mediaErr()">{{ mediaErr() }}</p>
                          </div>
                        </td>
                      </tr>
                      </ng-container>
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

    /* assistant rows */
    .as-row { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      padding: 8px 10px; border-radius: 10px; cursor: pointer; background: transparent;
      border: 1px solid transparent; color: #c7ccd6; }
    .as-row:hover { background: rgba(255,255,255,.04); }
    .as-row.sel { background: rgba(139,92,246,.16); border-color: rgba(139,92,246,.4); color: #fff; }
    .as-thumb { flex: none; width: 34px; height: 34px; border-radius: 9px; overflow: hidden; display: grid;
      place-items: center; background: rgba(139,92,246,.18); color: var(--accent2); font-size: 14px; font-weight: 700; }
    .as-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .as-meta { display: flex; flex-direction: column; min-width: 0; }
    .as-name { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .as-role { font-size: 11px; color: #8b93a3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mgr-link { margin-top: 6px; text-decoration: none; }

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
    .btn.on { background: rgba(139,92,246,.35); color: #fff; }
    /* per-document media panel */
    .mediarow > td { background: rgba(255,255,255,.02); padding: 0 16px 14px; }
    .mediapanel { display: flex; flex-direction: column; gap: 10px; padding-top: 6px; }
    .mp-head { font-size: 12.5px; color: #c7ccd6; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .mp-head .hint { font-size: 11px; color: #6b7384; }
    .mp-list { display: flex; flex-direction: column; gap: 6px; }
    .mp-item { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 9px; padding: 7px 10px; font-size: 12px; }
    .mp-type { font-size: 10.5px; text-transform: uppercase; color: #a78bfa; background: rgba(139,92,246,.16); padding: 2px 7px; border-radius: 999px; }
    .mp-title { font-weight: 600; }
    .mp-desc { flex: 1; color: #8b93a3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mp-en { display: flex; align-items: center; gap: 4px; color: #8b93a3; font-size: 11px; }
    .mp-add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .mp-add select, .mp-add input[type=text] { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; font-size: 12px; }
    .mp-add input[type=text] { flex: 1; min-width: 160px; }
    .mp-editor { display: flex; flex-direction: column; gap: 6px; }
    .mp-erow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; background: rgba(255,255,255,.02);
      border: 1px solid rgba(255,255,255,.07); border-radius: 8px; padding: 6px 8px; }
    .mp-erow.empty { justify-content: center; padding: 10px; }
    .mp-erow select, .mp-erow input[type=text] { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid var(--line); border-radius: 7px; padding: 6px 8px; font-size: 12px; }
    .mp-erow input[type=text] { flex: 1; min-width: 120px; }
    .mp-st { font-size: 11px; color: #8b93a3; min-width: 110px; }
    .mp-st.ok { color: #6ee7b7; } .mp-st.bad { color: #fca5a5; }
    .mp-bar { height: 6px; background: rgba(255,255,255,.08); border-radius: 4px; overflow: hidden; }
    .mp-bar.mini { width: 90px; }
    .mp-bar i { display: block; height: 100%; background: var(--accent); transition: width .15s; }
    .mp-rowbtns { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
    .filepick { cursor: pointer; }
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
  private assistantSvc = inject(AssistantConfigService);
  private imgOpt = inject(ImageOptimizationService);

  /** Assistants drive the sidebar; each owns a 1:1 RAG namespace (ragCollection). */
  readonly assistants = signal<AssistantConfig[]>([]);
  readonly selectedAssistantId = signal<string>('');
  readonly thumbs = signal<Record<string, string>>({});
  readonly selectedAssistantName = computed(() => {
    const a = this.assistants().find((x) => x.id === this.selectedAssistantId());
    return a?.name || a?.id || this.selectedNs();
  });

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

  // ---- per-document attached media ----
  readonly openMediaDocId = signal<string>('');
  readonly docMedia = signal<Record<string, RagMediaRecord[]>>({});
  readonly mediaErr = signal('');
  /** One editable/uploadable row per file to attach to the open document. */
  readonly mediaRows = signal<MediaRow[]>([]);

  trackRow = (_: number, r: MediaRow) => r.id;

  private blobToFile(blob: Blob, name: string): File {
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
  }

  private newRow(file: File | null = null): MediaRow {
    const base = file ? file.name.replace(/\.[^.]+$/, '') : '';
    const t = file?.type ?? '';
    const type: MediaType = t.startsWith('video/') ? 'video' : t.startsWith('image/') ? 'image' : t ? 'document' : 'image';
    return { id: Math.random().toString(36).slice(2), type, title: base, description: '', file, keepOriginal: false, status: 'idle', pct: 0 };
  }

  addRow(): void { this.mediaRows.update((rows) => [...rows, this.newRow()]); }
  removeRow(id: string): void { this.mediaRows.update((rows) => rows.filter((r) => r.id !== id)); }

  /** Patch one row immutably (keeps trackBy identity -> preserves input focus). */
  private patchRow(id: string, patch: Partial<MediaRow>): void {
    this.mediaRows.update((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** Single-file picker on a row: set the file + auto type, prefill title if empty. */
  onRowFile(r: MediaRow, e: Event): void {
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (!f) return;
    const t = f.type;
    const type: MediaType = t.startsWith('video/') ? 'video' : t.startsWith('image/') ? 'image' : 'document';
    this.patchRow(r.id, { file: f, type, title: r.title?.trim() ? r.title : f.name.replace(/\.[^.]+$/, ''), status: 'idle', error: undefined, pct: 0, sizeInfo: undefined });
  }

  /** Multi-select picker: one new row per chosen file (each independently editable). */
  onMultiPick(e: Event): void {
    const files = Array.from((e.target as HTMLInputElement).files ?? []);
    if (!files.length) return;
    this.mediaRows.update((rows) => [...rows, ...files.map((f) => this.newRow(f))]);
    (e.target as HTMLInputElement).value = '';
  }

  rowBusy(r: MediaRow): boolean {
    return r.status === 'optimizing' || r.status === 'thumbnailing' || r.status === 'uploading';
  }
  anyRowBusy(): boolean { return this.mediaRows().some((r) => this.rowBusy(r)); }
  hasPendingRows(): boolean { return this.mediaRows().some((r) => r.file && r.status !== 'done'); }

  rowStatus(r: MediaRow): string {
    switch (r.status) {
      case 'optimizing': return 'Optimizando imagen...';
      case 'thumbnailing': return 'Generando miniatura...';
      case 'uploading': return `Subiendo ${r.pct}%`;
      case 'done': return r.sizeInfo ? `Adjuntado (${r.sizeInfo})` : 'Adjuntado';
      case 'error': return 'Error: ' + (r.error ?? '');
      default: return r.file ? 'Listo' : '';
    }
  }

  /**
   * Access allowed when role enforcement is off (dev) or the user is admin.
   * Computed signal so the template re-evaluates reliably under zoneless CD.
   */
  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (this.allowed()) await this.loadAssistants();
  }

  /** Load the assistant list for the sidebar and resolve their thumbnails. */
  async loadAssistants(): Promise<void> {
    this.loadingNs.set(true);
    try {
      const list = await this.assistantSvc.listAssistants();
      this.assistants.set(list);
      // Resolve avatar thumbnails best-effort (non-blocking for selection).
      void this.resolveThumbs(list);
      if (!this.selectedAssistantId() && list.length) this.selectAssistant(list[0]);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loadingNs.set(false);
    }
  }

  private async resolveThumbs(list: AssistantConfig[]): Promise<void> {
    const map: Record<string, string> = {};
    await Promise.all(list.map(async (a) => {
      try {
        const url = await this.assistantSvc.resolveCardThumbnail(a);
        if (url) map[a.id] = url;
      } catch { /* skip */ }
    }));
    this.thumbs.set(map);
  }

  /** Select an assistant -> drive the content area into its owned namespace. */
  selectAssistant(a: AssistantConfig): void {
    this.selectedAssistantId.set(a.id);
    const ns = (a.ragCollection || a.ragNamespace || a.id).trim();
    this.selectNs(ns);
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

  // -------------------------------------------------- per-document media

  async toggleMedia(d: RagDocument): Promise<void> {
    if (this.openMediaDocId() === d.id) { this.openMediaDocId.set(''); return; }
    this.openMediaDocId.set(d.id);
    this.mediaErr.set('');
    this.mediaRows.set([this.newRow()]); // start with one empty row
    await this.loadDocMedia(d);
  }

  private async loadDocMedia(d: RagDocument): Promise<void> {
    try {
      const list = await this.svc.listMediaByDoc(this.selectedNs(), d.id);
      this.docMedia.update((m) => ({ ...m, [d.id]: list }));
    } catch (e: any) {
      this.mediaErr.set(e?.message ?? String(e));
    }
  }

  /** Upload + save a SINGLE row independently (optimize -> thumbnail -> upload -> save). */
  async uploadRow(d: RagDocument, row: MediaRow): Promise<void> {
    const ns = this.selectedNs();
    if (!ns || !row.file) { this.patchRow(row.id, { status: 'error', error: 'Selecciona un archivo.' }); return; }
    const f = row.file;
    const base = f.name.replace(/\.[^.]+$/, '');
    this.patchRow(row.id, { status: 'uploading', pct: 0, error: undefined });

    let fullFile: File = f;
    let thumbFile: File | undefined;
    let sizeInfo: string | undefined;

    // Images: optimize (stage 1) + thumbnail (stage 2). Graceful fallback to original.
    if (row.type === 'image' && !row.keepOriginal && this.imgOpt.isOptimizableImage(f)) {
      try {
        this.patchRow(row.id, { status: 'optimizing' });
        const full = await this.imgOpt.optimizeImage(f);
        fullFile = this.blobToFile(full.blob, `${base}.webp`);
        this.patchRow(row.id, { status: 'thumbnailing' });
        const thumb = await this.imgOpt.generateThumbnail(f);
        thumbFile = this.blobToFile(thumb.blob, `${base}-thumb.webp`);
        sizeInfo = `${this.fmtSize(f.size)} -> ${this.fmtSize(full.bytes)}`;
      } catch (e: any) {
        console.warn('[rag-admin] optimization failed, uploading original:', e?.message ?? e);
        fullFile = f; thumbFile = undefined; sizeInfo = undefined;
      }
    }

    this.patchRow(row.id, { status: 'uploading', pct: 0, sizeInfo });
    const order = (this.docMedia()[d.id] || []).length;
    const meta = { type: row.type, title: row.title.trim() || base, description: row.description.trim() || undefined, linkedDocId: d.id, order };
    try {
      await this.svc.uploadMedia(ns, fullFile, meta, thumbFile, (p) => this.patchRow(row.id, { pct: p.percent }));
      this.patchRow(row.id, { status: 'done' });
      await this.loadDocMedia(d); // refreshes the Media (N) count + list
    } catch (e: any) {
      this.patchRow(row.id, { status: 'error', error: e?.message ?? String(e) });
    }
  }

  /** Process every pending row sequentially (failures isolated per row). */
  async uploadAll(d: RagDocument): Promise<void> {
    for (const r of this.mediaRows()) {
      if (r.file && r.status !== 'done' && !this.rowBusy(r)) {
        await this.uploadRow(d, r);
      }
    }
  }

  async deleteDocMedia(d: RagDocument, m: RagMediaRecord): Promise<void> {
    if (!confirm(`Eliminar "${m.title}"?`)) return;
    try {
      await this.svc.deleteMedia(m);
      await this.loadDocMedia(d);
    } catch (e: any) {
      this.mediaErr.set(e?.message ?? String(e));
    }
  }

  async toggleMediaEnabled(d: RagDocument, m: RagMediaRecord, e: Event): Promise<void> {
    const enabled = (e.target as HTMLInputElement).checked;
    try {
      await this.svc.updateMedia(this.selectedNs(), m.id, { enabled });
      await this.loadDocMedia(d);
    } catch (err: any) {
      this.mediaErr.set(err?.message ?? String(err));
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
