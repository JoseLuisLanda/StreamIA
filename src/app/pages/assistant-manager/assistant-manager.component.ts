import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { AvatarManagerService } from '../../services/avatar-manager.service';
import { RagAdminService } from '../../services/rag-admin.service';
import { AdminService } from '../../services/admin.service';
import { LlmProfileService } from '../../services/llm-profile.service';
import { LlmProfileEditorComponent } from '../llm-admin/llm-profile-editor.component';
import { ConversationContentService } from '../../services/conversation-content.service';
import {
  AssistantConvContent,
  ConvKind,
  PhraseEntry,
  SuggestedPrompt as ConvPrompt,
} from '../../lib/conversation-content/conv-content.models';
import { AssistantConfig } from '../../lib/rag/rag.models';
import { Avatar } from '../../lib/avatars/avatar.models';
import { RagNamespace } from '../../lib/rag/rag-admin.models';
import { LlmConfigProfile, TestProfileResult, activeKeyOf, newProfileDraft } from '../../lib/llm-admin/llm-profile.models';
import { PROVIDER_LABELS } from '../../lib/llm-admin/llm-admin.models';
import { GESTURE_MAP } from '../../lib/gestures/gesture-library';
import { PIPER_VOICES, TtsLang } from '../../services/tts-lipsync.service';
import { environment } from '../../../environments/environment';

interface VoiceOpt { id: string; label: string; }

/**
 * Assistant Manager (admin) -- CRUD for `assistants/{id}`. An assistant binds an
 * avatar (from avatars catalog) + a RAG namespace + a persona (systemPrompt) +
 * voice/role/description. The /assistants selector lists enabled ones; chatRag
 * resolves persona + ragCollection server-side from assistants/{id}.
 *
 * Route: /assistant-manager (admin-gated). Visual + persona config only; the
 * heavy RAG/LLM work stays server-side.
 */
@Component({
  selector: 'app-assistant-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, LlmProfileEditorComponent],
  template: `
    <div class="wrap">
      <header class="bar">
        <div class="brand"><span class="logo">AS</span> Assistant Manager</div>
        <nav class="topnav">
          <a routerLink="/admin">&larr; Admin</a>
          <a routerLink="/avatar-manager">Avatar Manager</a>
          <a routerLink="/rag-admin">RAG Admin</a>
          <a routerLink="/llm-admin">LLM Admin</a>
          <a routerLink="/role-admin">Roles</a>
          <a routerLink="/llm-responses">Respuestas</a>
        </nav>
      </header>

      <div class="denied" *ngIf="!allowed()">You do not have admin access to this panel.</div>

      <main class="main" *ngIf="allowed()">
        <!-- ============ LIST ============ -->
        <ng-container *ngIf="view() === 'list'">
          <div class="head">
            <div>
              <h1>Assistants</h1>
              <p class="sub">Configure assistants: an avatar + a RAG namespace + a persona. Enabled ones appear in the public selector and answer from their own knowledge base.</p>
            </div>
            <button class="btn primary" (click)="newAssistant()">+ New Assistant</button>
          </div>

          <div class="state" *ngIf="loading()"><span class="spin"></span><p>Loading...</p></div>

          <div class="empty" *ngIf="!loading() && !assistants().length">
            <h2>No assistants yet</h2>
            <p>Create one to bind an avatar to a knowledge base + persona.</p>
            <button class="btn primary" (click)="newAssistant()">+ New Assistant</button>
          </div>

          <div class="rows" *ngIf="!loading() && assistants().length">
            <div class="arow" *ngFor="let a of assistants()">
              <div class="athumb">
                <img *ngIf="thumb(a.avatarId)" [src]="thumb(a.avatarId)!" [alt]="a.name" />
                <span *ngIf="!thumb(a.avatarId)" class="ph">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>
                </span>
              </div>
              <div class="ainfo">
                <div class="aname">{{ a.name }} <span class="pill" *ngIf="a.role">{{ a.role }}</span></div>
                <div class="ameta">
                  <span [class.warn]="!avatarExists(a.avatarId)">avatar: {{ a.avatarId }}<span *ngIf="!avatarExists(a.avatarId)"> (missing)</span></span>
                  <span [class.warn]="!namespaceExists(a.ragCollection)">ns: {{ a.ragCollection }}<span *ngIf="!namespaceExists(a.ragCollection)"> (missing)</span></span>
                  <span>{{ a.language | uppercase }}</span>
                </div>
              </div>
              <label class="toggle" [title]="a.enabled !== false ? 'Enabled' : 'Disabled'">
                <input type="checkbox" [checked]="a.enabled !== false" (change)="toggleEnabled(a, $event)" />
                <span>{{ a.enabled !== false ? 'Enabled' : 'Disabled' }}</span>
              </label>
              <div class="actions">
                <button class="btn ghost sm" (click)="preview(a)" title="Open in Text-Avatar">Test</button>
                <button class="btn ghost sm" (click)="editAssistant(a)">Edit</button>
                <button class="btn danger sm" (click)="remove(a)">Delete</button>
              </div>
            </div>
          </div>
          <p class="err" *ngIf="error()">{{ error() }}</p>
        </ng-container>

        <!-- ============ CREATE / EDIT ============ -->
        <ng-container *ngIf="view() === 'edit'">
          <div class="head">
            <h1>{{ form.id ? 'Edit Assistant' : 'New Assistant' }}</h1>
            <button class="btn ghost" (click)="cancel()">Back</button>
          </div>

          <div class="editor">
            <section class="col">
              <label class="fld"><span>Name</span><input type="text" [(ngModel)]="form.name" placeholder="Sofia" /></label>
              <label class="fld"><span>Role (card pill)</span><input type="text" [(ngModel)]="form.role" placeholder="Asesora de Muebles" /></label>
              <label class="fld"><span>Description</span><textarea rows="2" [(ngModel)]="form.description" placeholder="One-line card description"></textarea></label>
              <label class="fld"><span>Topic tag (chip)</span><input type="text" [(ngModel)]="form.topicTag" placeholder="Catalogo" /></label>

              <label class="fld"><span>Avatar *</span>
                <select [(ngModel)]="form.avatarId" (ngModelChange)="onAvatarChange($event)">
                  <option value="">- select avatar -</option>
                  <option *ngFor="let av of avatars()" [value]="av.id">{{ av.name }} ({{ av.id }})</option>
                </select>
              </label>
              <div class="av-preview" *ngIf="form.avatarId">
                <img *ngIf="thumb(form.avatarId)" [src]="thumb(form.avatarId)!" [alt]="form.avatarId" />
                <span class="hint" *ngIf="!avatarExists(form.avatarId)">Warning: this avatar id is not in the catalog.</span>
              </div>
              <p class="hint" *ngIf="!avatars().length">No avatars found. Create one in the Avatar Manager first.</p>

              <label class="fld"><span>RAG namespace *</span>
                <select [(ngModel)]="form.ragCollection">
                  <option value="">- select namespace -</option>
                  <option *ngFor="let n of namespaces()" [value]="n.id">{{ n.name || n.id }}</option>
                </select>
              </label>
              <p class="hint" *ngIf="!namespaces().length">No namespaces found. Create + ingest one in RAG Admin first.</p>

              <label class="fld"><span>Persona (system prompt)</span>
                <textarea rows="5" [(ngModel)]="form.systemPrompt" placeholder="Eres Sofia, una asesora experta de una tienda de muebles..."></textarea>
              </label>

              <!-- ===== LLM config ===== -->
              <div class="llmbox">
                <div class="llmhead">LLM</div>
                <label class="fld"><span>Config profile</span>
                  <select [(ngModel)]="form.llmProfileId" (ngModelChange)="onProfilePicked()">
                    <option [ngValue]="undefined">- system default (global) -</option>
                    <optgroup label="Global">
                      <option *ngFor="let p of globalProfiles()" [ngValue]="p.id">{{ p.name }} ({{ llmLabels[p.provider] }}/{{ p.model }})</option>
                    </optgroup>
                    <optgroup label="Privados de este asistente" *ngIf="privateProfiles().length">
                      <option *ngFor="let p of privateProfiles()" [ngValue]="p.id">{{ p.name }} ({{ llmLabels[p.provider] }}/{{ p.model }})</option>
                    </optgroup>
                  </select>
                </label>
                <p class="hint">Efectivo: {{ effectiveLlm() }}</p>
                <div class="llmbtns">
                  <button class="btn ghost sm" type="button" (click)="newPrivateProfile()" [disabled]="!form.id">+ Perfil privado</button>
                  <button class="btn ghost sm" type="button" (click)="editPickedProfile()" *ngIf="pickedProfile()">Editar perfil</button>
                  <button class="btn ghost sm" type="button" (click)="testLlm()" [disabled]="!form.llmProfileId || llmTesting()">{{ llmTesting() ? 'Probando...' : 'Probar LLM' }}</button>
                </div>
                <p class="hint" *ngIf="form.id === ''">Guarda el asistente primero para crear perfiles privados.</p>
                <p class="ok" *ngIf="llmTest()?.ok">OK — {{ llmTest()?.provider }}/{{ llmTest()?.model }} (llave: {{ llmTest()?.key }})</p>
                <p class="err" *ngIf="llmTest() && !llmTest()?.ok">Fallo: {{ llmTest()?.error }}</p>

                <div class="profedit" *ngIf="llmEditing()">
                  <app-llm-profile-editor [p]="llmEditing()!" (changed)="onLlmProfileChanged($event)"></app-llm-profile-editor>
                  <button class="btn ghost sm" type="button" (click)="llmEditing.set(null)">Cerrar editor</button>
                </div>
              </div>
            </section>

            <aside class="col side">
              <label class="fld"><span>Voice</span>
                <select [(ngModel)]="form.voice">
                  <option value="">{{ avatarDefaultVoiceLabel() }}</option>
                  <option *ngFor="let v of voices" [value]="v.id">{{ v.label }}</option>
                </select>
              </label>
              <label class="fld"><span>Language</span>
                <select [(ngModel)]="form.language"><option value="es">ES</option><option value="en">EN</option></select>
              </label>
              <label class="fld"><span>Lead-in gesture</span>
                <select [(ngModel)]="form.leadGestureId"><option value="">- none -</option><option *ngFor="let g of gestures" [value]="g">{{ g }}</option></select>
              </label>
              <label class="fld"><span>Tail gesture</span>
                <select [(ngModel)]="form.tailGestureId"><option value="">- none -</option><option *ngFor="let g of gestures" [value]="g">{{ g }}</option></select>
              </label>
              <label class="fld"><span>Activation command (optional)</span><input type="text" [(ngModel)]="form.activationCommand" placeholder="ok strimearia" /></label>
              <label class="toggle big"><input type="checkbox" [(ngModel)]="form.enabled" /> <span>Enabled (show in selector)</span></label>

              <div class="actions">
                <button class="btn primary" (click)="save()" [disabled]="!canSave() || saving()">{{ saving() ? 'Saving...' : 'Save' }}</button>
                <button class="btn ghost" (click)="cancel()">Cancel</button>
                <button class="btn ghost" *ngIf="form.id" (click)="preview(form)" [disabled]="!canSave()">Test</button>
              </div>
              <p class="hint">* Avatar and RAG namespace are required.</p>
              <p class="err" *ngIf="error()">{{ error() }}</p>
            </aside>
          </div>

          <!-- ============ CONVERSACION / PERSONALIDAD ============ -->
          <section class="convsec" *ngIf="form.id">
            <h2>Conversación / Personalidad</h2>
            <p class="sub">Frases y sugerencias por asistente. Cada cambio actualiza el marcador de contenido.</p>
            <div class="state sm" *ngIf="convLoading()"><span class="spin"></span> Cargando...</div>

            <div class="convgrid" *ngIf="!convLoading() && convEdit() as c">
              <!-- phrase lists -->
              <div class="convcol" *ngFor="let kind of phraseKinds">
                <div class="cvhead"><h3>{{ phraseTitle[kind] }}</h3>
                  <button class="btn sm" type="button" (click)="genPhrases(kind)" [disabled]="convGen()">Generar con IA</button>
                </div>
                <div class="cvrow" *ngFor="let e of phraseList(c, kind); let i = index">
                  <input type="checkbox" [checked]="e.enabled" (change)="togglePhrase(kind, e, $event)" title="Habilitado" />
                  <input class="cvtext" type="text" [ngModel]="e.text" (blur)="savePhrase(kind, e, $event)" />
                  <button class="ix" (click)="movePhrase(kind, i, -1)" [disabled]="i===0" title="Subir">↑</button>
                  <button class="ix" (click)="movePhrase(kind, i, 1)" [disabled]="i===phraseList(c,kind).length-1" title="Bajar">↓</button>
                  <button class="ix danger" (click)="delPhrase(kind, e)" title="Eliminar">✕</button>
                </div>
                <div class="cvadd">
                  <input type="text" [(ngModel)]="newPhrase[kind]" placeholder="Nueva frase..." (keydown.enter)="addPhrase(kind)" />
                  <button class="btn sm" (click)="addPhrase(kind)" [disabled]="!newPhrase[kind]?.trim()">+ Añadir</button>
                </div>
              </div>

              <!-- suggested prompts -->
              <div class="convcol wide">
                <div class="cvhead"><h3>Sugerencias (chips)</h3>
                  <button class="btn sm" type="button" (click)="genPromptsAI()" [disabled]="convGen()">Generar con IA</button>
                  <a class="btn ghost sm" routerLink="/llm-responses">Editor avanzado</a>
                </div>
                <div class="cvrow" *ngFor="let p of c.suggestedPrompts; let i = index">
                  <input type="checkbox" [checked]="p.enabled" (change)="togglePrompt(p, $event)" title="Habilitado" />
                  <input class="cvtext" type="text" [ngModel]="p.label" (blur)="savePromptField(p, 'label', $event)" placeholder="Etiqueta" />
                  <input class="cvtext" type="text" [ngModel]="p.prompt" (blur)="savePromptField(p, 'prompt', $event)" placeholder="Prompt enviado" />
                  <button class="ix" (click)="movePrompt(i, -1)" [disabled]="i===0">↑</button>
                  <button class="ix" (click)="movePrompt(i, 1)" [disabled]="i===c.suggestedPrompts.length-1">↓</button>
                  <button class="ix danger" (click)="delPrompt(p)">✕</button>
                </div>
                <div class="cvadd">
                  <input type="text" [(ngModel)]="newPromptLabel" placeholder="Etiqueta (ej. Becas)" />
                  <input type="text" [(ngModel)]="newPromptText" placeholder="Prompt (ej. ¿Qué becas hay?)" />
                  <button class="btn sm" (click)="addPrompt()" [disabled]="!newPromptLabel.trim() || !newPromptText.trim()">+ Añadir</button>
                </div>

                <h3 style="margin-top:14px">Palabras clave (opcional)</h3>
                <label class="fld"><span>Saludo (separadas por coma)</span>
                  <input type="text" [(ngModel)]="greetingKwText" (blur)="saveKeywords()" placeholder="hola, buenas, hey" />
                </label>
                <label class="fld"><span>Despedida (separadas por coma)</span>
                  <input type="text" [(ngModel)]="farewellKwText" (blur)="saveKeywords()" placeholder="adios, hasta luego, chao" />
                </label>
              </div>
            </div>
            <p class="err" *ngIf="convErr()">{{ convErr() }}</p>
          </section>
        </ng-container>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    * { box-sizing: border-box; }
    .wrap { height: 100%; display: flex; flex-direction: column; background: #0a0e14; color: #e6e8ee; font-family: 'Segoe UI', system-ui, sans-serif; --accent: #8b5cf6; }
    .bar { flex: none; height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 22px; border-bottom: 1px solid rgba(255,255,255,.07); }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; }
    .logo { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; background: rgba(139,92,246,.22); color: #c4b0f7; font-size: 11px; font-weight: 700; }
    .topnav { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .topnav a { color: #c7ccd6; text-decoration: none; font-size: 13px; padding: 7px 12px; border-radius: 8px; border: 1px solid transparent; }
    .topnav a:hover { background: rgba(255,255,255,.06); color: #fff; border-color: rgba(255,255,255,.1); }
    .denied { margin: 80px auto; color: #ffb3b3; }
    .main { flex: 1; min-height: 0; overflow-y: auto; width: 100%; max-width: 1100px; margin: 0 auto; padding: 26px 24px 64px; }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
    h1 { font-size: 28px; font-weight: 800; margin: 0 0 6px; }
    .sub { color: #8b93a3; font-size: 13.5px; max-width: 720px; line-height: 1.5; margin: 0; }
    .state { display: flex; flex-direction: column; align-items: center; gap: 10px; color: #8b93a3; margin-top: 50px; }
    .spin { width: 24px; height: 24px; border: 3px solid rgba(255,255,255,.15); border-top-color: var(--accent); border-radius: 50%; animation: sp 1s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .empty { text-align: center; margin: 60px auto; max-width: 420px; }
    .empty h2 { margin: 0 0 6px; } .empty p { color: #8b93a3; margin: 0 0 14px; }

    .rows { display: flex; flex-direction: column; gap: 10px; }
    .arow { display: flex; align-items: center; gap: 14px; background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 12px; padding: 12px 14px; }
    .athumb { width: 48px; height: 48px; border-radius: 50%; overflow: hidden; flex: none; display: grid; place-items: center; border: 2px solid rgba(139,92,246,.5); background: radial-gradient(circle at 50% 30%, rgba(139,92,246,.4), rgba(139,92,246,.05)); }
    .athumb img { width: 100%; height: 100%; object-fit: cover; } .ph { color: #c4b0f7; }
    .ainfo { flex: 1; min-width: 0; }
    .aname { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .pill { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; background: rgba(139,92,246,.16); border: 1px solid rgba(139,92,246,.35); color: #c4b0f7; }
    .ameta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: #8b93a3; margin-top: 3px; font-family: ui-monospace, Menlo, monospace; }
    .ameta .warn { color: #f0c674; }
    .toggle { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #aeb4c0; cursor: pointer; }
    .toggle.big { margin: 8px 0; font-size: 13px; }
    .actions { display: flex; gap: 7px; }

    .editor { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; align-items: start; }
    .col { background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .col.side { position: sticky; top: 16px; }
    .fld { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #99a; }
    .fld input, .fld textarea, .fld select { background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 9px; padding: 9px 11px; font-size: 13px; }
    .av-preview { display: flex; align-items: center; gap: 10px; }
    .av-preview img { width: 56px; height: 56px; border-radius: 10px; object-fit: cover; border: 1px solid rgba(255,255,255,.12); }
    .hint { font-size: 11px; color: #6b7384; line-height: 1.45; margin: 2px 0; }
    .err { color: #ff9c9c; font-size: 12.5px; margin-top: 8px; }
    .btn { padding: 9px 15px; border-radius: 9px; cursor: pointer; font-size: 13px; background: rgba(139,92,246,.18); border: 1px solid rgba(139,92,246,.4); color: #cbb8f8; text-decoration: none; display: inline-block; }
    .btn:hover:not(:disabled) { background: rgba(139,92,246,.3); }
    .btn:disabled { opacity: .45; cursor: default; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.ghost { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.12); color: #cdd; }
    .btn.danger { background: rgba(179,57,57,.2); border-color: rgba(179,57,57,.5); color: #ffb3b3; }
    .btn.sm { padding: 5px 11px; font-size: 11.5px; }
    .ok { color: #6ee7b7; font-size: 12.5px; margin: 2px 0; }
    .llmbox { border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .llmhead { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #8b93a3; font-weight: 700; }
    .llmbtns { display: flex; gap: 7px; flex-wrap: wrap; }
    .profedit { border-top: 1px solid rgba(255,255,255,.08); padding-top: 10px; margin-top: 4px; display: flex; flex-direction: column; gap: 8px; }
    .convsec { margin-top: 20px; background: #121823; border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 18px; }
    .convsec h2 { margin: 0 0 2px; font-size: 18px; }
    .convgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
    .convcol { display: flex; flex-direction: column; gap: 7px; }
    .convcol.wide { grid-column: 1 / -1; }
    .convcol h3 { margin: 0 0 2px; font-size: 13.5px; color: #cbd0da; }
    .cvhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .cvrow { display: flex; align-items: center; gap: 6px; }
    .cvtext { flex: 1; background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 6px 9px; font-size: 12.5px; }
    .cvadd { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
    .cvadd input { flex: 1; min-width: 120px; background: rgba(255,255,255,.05); color: #e6e8ee; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 6px 9px; font-size: 12.5px; }
    .ix { width: 26px; height: 28px; border-radius: 7px; cursor: pointer; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); color: #aeb4c0; font-size: 12px; }
    .ix:hover:not(:disabled) { background: rgba(255,255,255,.1); color: #fff; } .ix:disabled { opacity: .35; cursor: default; }
    .ix.danger:hover { background: rgba(179,57,57,.25); color: #ffb3b3; }
    .state.sm { margin: 8px 0; }
    @media (max-width: 860px) { .editor { grid-template-columns: 1fr; } .col.side { position: static; } .convgrid { grid-template-columns: 1fr; } }
  `]
})
export class AssistantManagerComponent implements OnInit {
  private svc = inject(AssistantConfigService);
  private avatarSvc = inject(AvatarManagerService);
  private ragSvc = inject(RagAdminService);
  admin = inject(AdminService);
  private router = inject(Router);
  private profileSvc = inject(LlmProfileService);
  private convContent = inject(ConversationContentService);

  // ---- Conversational content editing ----
  readonly phraseKinds: ConvKind[] = ['greetings', 'infoAcknowledgements', 'farewells'];
  readonly phraseTitle: Record<string, string> = {
    greetings: 'Saludos', infoAcknowledgements: 'Frases mientras busca', farewells: 'Despedidas',
  };
  readonly convEdit = signal<AssistantConvContent | null>(null);
  readonly convLoading = signal(false);
  readonly convGen = signal(false);
  readonly convErr = signal('');
  newPhrase: Record<string, string> = { greetings: '', infoAcknowledgements: '', farewells: '' };
  newPromptLabel = '';
  newPromptText = '';
  greetingKwText = '';
  farewellKwText = '';

  readonly llmLabels = PROVIDER_LABELS;
  readonly profiles = signal<LlmConfigProfile[]>([]);
  readonly llmEditing = signal<LlmConfigProfile | null>(null);
  readonly llmTesting = signal(false);
  readonly llmTest = signal<TestProfileResult | null>(null);

  readonly assistants = signal<AssistantConfig[]>([]);
  readonly avatars = signal<Avatar[]>([]);
  readonly namespaces = signal<RagNamespace[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly view = signal<'list' | 'edit'>('list');
  private thumbs = signal<Record<string, string | null>>({});

  voices: VoiceOpt[] = this.buildVoices();
  gestures: string[] = Array.from(GESTURE_MAP.keys());

  form: AssistantConfig = this.blank();

  readonly allowed = computed(() => !environment.enforceAdminRole || this.admin.isAdmin() === true);

  async ngOnInit(): Promise<void> {
    await this.admin.check();
    if (!this.allowed()) { this.loading.set(false); return; }
    await this.reload();
  }

  private blank(): AssistantConfig {
    return { id: '', name: '', role: '', description: '', avatarId: '', ragCollection: '', systemPrompt: '', voice: '', language: 'es', enabled: true };
  }

  private buildVoices(): VoiceOpt[] {
    const out: VoiceOpt[] = [];
    for (const lang of ['es', 'en'] as TtsLang[]) {
      for (const v of PIPER_VOICES[lang]) out.push({ id: v.id, label: `${v.label} (${lang.toUpperCase()})` });
    }
    return out;
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [list, avatars, namespaces, profiles] = await Promise.all([
        this.svc.listAssistants(),
        this.avatarSvc.listAvatars(),
        this.ragSvc.listNamespaces(),
        this.profileSvc.listAll().catch(() => [] as LlmConfigProfile[]),
      ]);
      this.assistants.set(list);
      this.avatars.set(avatars);
      this.namespaces.set(namespaces);
      this.profiles.set(profiles);
      // resolve avatar thumbnails (by avatarId) for list + picker
      for (const av of avatars) {
        this.avatarSvc.resolveUrl(av.thumbnailPath)
          .then((u) => this.thumbs.update((m) => ({ ...m, [av.id]: u })))
          .catch(() => {});
      }
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.loading.set(false);
    }
  }

  thumb(avatarId?: string): string | null { return avatarId ? (this.thumbs()[avatarId] ?? null) : null; }
  avatarExists(id?: string): boolean { return !!id && this.avatars().some((a) => a.id === id); }
  namespaceExists(id?: string): boolean { return !!id && this.namespaces().some((n) => n.id === id); }

  avatarDefaultVoiceLabel(): string {
    const av = this.avatars().find((a) => a.id === this.form.avatarId);
    if (av?.defaultVoice) {
      const v = this.voices.find((x) => x.id === av.defaultVoice);
      return `Avatar default: ${v?.label ?? av.defaultVoice}`;
    }
    return '- avatar default -';
  }

  onAvatarChange(avatarId: string): void {
    // Prefill voice from the avatar's default when no override is set.
    const av = this.avatars().find((a) => a.id === avatarId);
    if (av?.defaultVoice && !this.form.voice) this.form.voice = av.defaultVoice;
  }

  // -------------------------------------------------------------- LLM profiles
  globalProfiles(): LlmConfigProfile[] {
    return this.profiles().filter((p) => p.scope === 'global');
  }
  privateProfiles(): LlmConfigProfile[] {
    return this.profiles().filter((p) => p.scope === 'assistant' && p.ownerAssistantId === this.form.id);
  }
  pickedProfile(): LlmConfigProfile | null {
    return this.profiles().find((p) => p.id === this.form.llmProfileId) ?? null;
  }
  private systemDefaultProfile(): LlmConfigProfile | null {
    return this.profiles().find((p) => p.scope === 'global' && p.isSystemDefault) ?? null;
  }
  effectiveLlm(): string {
    const p = this.pickedProfile();
    if (p) {
      const k = activeKeyOf(p);
      const scope = p.scope === 'assistant' ? 'Propia' : 'Global';
      return `${scope}: ${p.name} / ${p.model}${k ? ', llave: ' + k.label : ' (sin llave)'}`;
    }
    const d = this.systemDefaultProfile();
    return d ? `Global (default): ${d.name} / ${d.model}` : 'Sin perfil — configura uno en LLM Admin';
  }
  onProfilePicked(): void {
    this.llmTest.set(null);
    this.llmEditing.set(null);
  }
  newPrivateProfile(): void {
    if (!this.form.id) return;
    this.llmEditing.set(newProfileDraft('assistant', this.form.id));
  }
  editPickedProfile(): void {
    const p = this.pickedProfile();
    if (p) this.llmEditing.set({ ...p, keys: [...p.keys] });
  }
  async onLlmProfileChanged(profileId: string): Promise<void> {
    await this.reload();
    // Auto-assign a freshly created private profile and keep its editor open for keys.
    if (profileId) {
      this.form.llmProfileId = profileId;
      const fresh = this.profiles().find((x) => x.id === profileId);
      if (fresh) this.llmEditing.set({ ...fresh, keys: [...fresh.keys] });
    }
  }
  async testLlm(): Promise<void> {
    if (!this.form.llmProfileId) return;
    this.llmTesting.set(true);
    this.llmTest.set(null);
    try {
      this.llmTest.set(await this.profileSvc.test(this.form.llmProfileId));
    } finally {
      this.llmTesting.set(false);
    }
  }

  newAssistant(): void {
    this.form = this.blank();
    this.error.set('');
    this.view.set('edit');
  }

  editAssistant(a: AssistantConfig): void {
    this.form = { ...a };
    this.error.set('');
    this.view.set('edit');
    this.greetingKwText = (a.greetingKeywords ?? []).join(', ');
    this.farewellKwText = (a.farewellKeywords ?? []).join(', ');
    void this.loadConvEdit();
  }

  cancel(): void { this.view.set('list'); this.error.set(''); }

  canSave(): boolean {
    return !!(this.form.name || '').trim() && !!this.form.avatarId && !!this.form.ragCollection;
  }

  async save(): Promise<void> {
    if (!this.canSave()) { this.error.set('Name, avatar and RAG namespace are required.'); return; }
    const id = this.form.id || this.avatarSvc.slugId(this.form.name || '');
    if (!id) { this.error.set('Enter a valid name.'); return; }
    this.form.id = id;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.svc.save(this.form);
      // Ensure the editable GLOBAL defaults exist (assistants inherit them while
      // their useCustomResponses flags are false). No per-assistant seeding.
      await this.convContent.seedGlobals().catch(() => {});
      await this.reload();
      this.view.set('list');
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    } finally {
      this.saving.set(false);
    }
  }

  // ------------------------------------------------ conversational content CRUD
  private async loadConvEdit(): Promise<void> {
    if (!this.form.id) { this.convEdit.set(null); return; }
    this.convLoading.set(true);
    this.convErr.set('');
    try {
      this.convEdit.set(await this.convContent.listForEdit(this.form.id));
    } catch (e: any) {
      this.convErr.set(e?.message ?? String(e));
    } finally {
      this.convLoading.set(false);
    }
  }

  phraseList(c: AssistantConvContent, kind: ConvKind): PhraseEntry[] {
    return (c as any)[kind] as PhraseEntry[];
  }

  async addPhrase(kind: ConvKind): Promise<void> {
    const text = (this.newPhrase[kind] || '').trim();
    if (!text || !this.form.id) return;
    const order = this.phraseList(this.convEdit()!, kind).length;
    await this.guard(() => this.convContent.addPhrase(this.form.id, kind, text, order));
    this.newPhrase[kind] = '';
    await this.loadConvEdit();
  }
  async savePhrase(kind: ConvKind, e: PhraseEntry, ev: Event): Promise<void> {
    const text = (ev.target as HTMLInputElement).value.trim();
    if (text === e.text) return;
    await this.guard(() => this.convContent.updateEntry(this.form.id, kind, e.id, { text }));
    await this.loadConvEdit();
  }
  async togglePhrase(kind: ConvKind, e: PhraseEntry, ev: Event): Promise<void> {
    const enabled = (ev.target as HTMLInputElement).checked;
    await this.guard(() => this.convContent.updateEntry(this.form.id, kind, e.id, { enabled }));
    await this.loadConvEdit();
  }
  async delPhrase(kind: ConvKind, e: PhraseEntry): Promise<void> {
    await this.guard(() => this.convContent.deleteEntry(this.form.id, kind, e.id));
    await this.loadConvEdit();
  }
  async movePhrase(kind: ConvKind, i: number, dir: -1 | 1): Promise<void> {
    const list = [...this.phraseList(this.convEdit()!, kind)];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await this.guard(() => this.convContent.reorder(this.form.id, kind, list.map((x) => x.id)));
    await this.loadConvEdit();
  }

  async addPrompt(): Promise<void> {
    const label = this.newPromptLabel.trim();
    const prompt = this.newPromptText.trim();
    if (!label || !prompt || !this.form.id) return;
    const order = this.convEdit()!.suggestedPrompts.length;
    await this.guard(() => this.convContent.addPrompt(this.form.id, label, prompt, order));
    this.newPromptLabel = ''; this.newPromptText = '';
    await this.loadConvEdit();
  }
  async savePromptField(p: ConvPrompt, field: 'label' | 'prompt', ev: Event): Promise<void> {
    const val = (ev.target as HTMLInputElement).value.trim();
    if (val === (p as any)[field]) return;
    await this.guard(() => this.convContent.updateEntry(this.form.id, 'suggestedPrompts', p.id, { [field]: val }));
    await this.loadConvEdit();
  }
  async togglePrompt(p: ConvPrompt, ev: Event): Promise<void> {
    const enabled = (ev.target as HTMLInputElement).checked;
    await this.guard(() => this.convContent.updateEntry(this.form.id, 'suggestedPrompts', p.id, { enabled }));
    await this.loadConvEdit();
  }
  async delPrompt(p: ConvPrompt): Promise<void> {
    await this.guard(() => this.convContent.deleteEntry(this.form.id, 'suggestedPrompts', p.id));
    await this.loadConvEdit();
  }
  async movePrompt(i: number, dir: -1 | 1): Promise<void> {
    const list = [...this.convEdit()!.suggestedPrompts];
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await this.guard(() => this.convContent.reorder(this.form.id, 'suggestedPrompts', list.map((x) => x.id)));
    await this.loadConvEdit();
  }

  async saveKeywords(): Promise<void> {
    const parse = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
    this.form.greetingKeywords = parse(this.greetingKwText);
    this.form.farewellKeywords = parse(this.farewellKwText);
    await this.guard(() => this.svc.save(this.form));
  }

  /** Run a content mutation, surfacing errors into convErr. */
  private async guard(fn: () => Promise<unknown>): Promise<void> {
    this.convErr.set('');
    try { await fn(); } catch (e: any) { this.convErr.set(e?.message ?? String(e)); }
  }

  /** AI-generate phrases for a category and append them as editable entries (sets flag true). */
  async genPhrases(kind: ConvKind): Promise<void> {
    if (!this.form.id) return;
    this.convGen.set(true); this.convErr.set('');
    try {
      const r = await this.convContent.generate({
        scope: 'assistant', assistantId: this.form.id, category: kind, count: 5,
        context: { name: this.form.name, role: this.form.role, description: this.form.description, topicTag: this.form.topicTag, language: this.form.language, persona: this.form.systemPrompt },
      });
      if (r.error) { this.convErr.set(r.error); return; }
      const base = this.phraseList(this.convEdit()!, kind).length;
      let i = base;
      for (const text of r.phrases ?? []) await this.convContent.addPhrase(this.form.id, kind, text, i++);
      await this.loadConvEdit();
    } finally { this.convGen.set(false); }
  }

  /** AI-generate suggested prompts and append them (sets flag true). */
  async genPromptsAI(): Promise<void> {
    if (!this.form.id) return;
    this.convGen.set(true); this.convErr.set('');
    try {
      const r = await this.convContent.generate({
        scope: 'assistant', assistantId: this.form.id, category: 'suggestedPrompts', count: 4,
        context: { name: this.form.name, role: this.form.role, description: this.form.description, topicTag: this.form.topicTag, language: this.form.language, persona: this.form.systemPrompt },
      });
      if (r.error) { this.convErr.set(r.error); return; }
      const base = this.convEdit()!.suggestedPrompts.length;
      let i = base;
      for (const p of r.prompts ?? []) await this.convContent.addPrompt(this.form.id, p.label, p.prompt, i++);
      await this.loadConvEdit();
    } finally { this.convGen.set(false); }
  }

  async toggleEnabled(a: AssistantConfig, e: Event): Promise<void> {
    const enabled = (e.target as HTMLInputElement).checked;
    try {
      await this.svc.save({ ...a, enabled });
      this.assistants.update((cur) => cur.map((x) => (x.id === a.id ? { ...x, enabled } : x)));
    } catch (err: any) {
      this.error.set(err?.message ?? String(err));
    }
  }

  async remove(a: AssistantConfig): Promise<void> {
    if (!confirm(`Delete assistant "${a.name}"? The /assistants selector will stop showing it.`)) return;
    try {
      await this.svc.deleteAssistant(a.id);
      this.assistants.update((cur) => cur.filter((x) => x.id !== a.id));
    } catch (err: any) {
      this.error.set(err?.message ?? String(err));
    }
  }

  preview(a: AssistantConfig): void {
    if (!a.id) return;
    this.router.navigate(['/text-avatar'], { queryParams: { assistant: a.id } });
  }
}
