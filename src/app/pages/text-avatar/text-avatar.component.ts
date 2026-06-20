import { Component, ElementRef, ViewChild, AfterViewChecked, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AdminService } from '../../services/admin.service';
import { AvatarManagerService } from '../../services/avatar-manager.service';
import { AvatarService } from '../../services/avatar.service';
import { AvatarTtsComponent, DEFAULT_AVATAR_URL } from '../../components/avatar-tts/avatar-tts.component';
import { AvatarCatalogService } from '../../services/avatar-catalog.service';
import { getCatalogEntry } from '../../lib/avatars/avatar-catalog';
import { RigReport, Conformance, conformanceLabel } from '../../lib/avatars/rig-spec';
import { MediaGalleryComponent } from '../../components/media-gallery/media-gallery.component';
import { RagAvatarService } from '../../services/rag-avatar.service';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { ConversationContentService } from '../../services/conversation-content.service';
import { AssistantConvContent, SuggestedPrompt } from '../../lib/conversation-content/conv-content.models';
import { MediaItem } from '../../lib/rag/rag.models';
import { AssistantConfig } from '../../lib/rag/rag.models';
import { getRagEndpoint, setRagEndpoint, getAssistantId, setAssistantId } from '../../lib/rag/rag.config';
import { TtsLipsyncService, TtsProvider, TtsLang, PIPER_VOICES } from '../../services/tts-lipsync.service';
import { SpeechRecognitionService } from '../../services/speech-recognition.service';
import { LlmService, LlmProviderId, LLM_PROVIDER_LABELS } from '../../services/llm.service';
import { ConversationService, ConvMessage } from '../../services/conversation.service';
import { parseGestureMarkup } from '../../lib/gestures/gesture-markup';
import { GESTURE_MAP, GestureDef, SPEED_MULTIPLIERS } from '../../lib/gestures/gesture-library';
import { CustomGestureRegistryService } from '../../services/custom-gesture-registry.service';
import { MotionStoreService } from '../../services/motion-store.service';
import { GesturePlayerService } from '../../services/gesture-player.service';

interface MsgSegment { kind: 'text' | 'chip'; value: string; }

const CHIP_LABELS: Record<string, string> = {
    yes: 'nod', no: 'shake', surprise: 'surprise', thinking: 'thinking', sigh: 'sigh', laugh: 'laugh',
};

/**
 * "Avatar Live" — immersive voice-conversation screen.
 * All conversation flow is owned by ConversationService (explicit state
 * machine); this component is a thin view binding to conv.state().
 */
@Component({
    selector: 'app-text-avatar',
    standalone: true,
    imports: [CommonModule, FormsModule, AvatarTtsComponent, MediaGalleryComponent],
    template: `
    <div class="app">

      <!-- ===================== FLOATING TOP BAR (over avatar) ===================== -->
      <header class="topbar floating">
        <div class="brand">
          <button class="backbtn" (click)="goBack()" title="Volver a asistentes" aria-label="Volver a asistentes">←</button>
          <div class="brandtext">
            <span class="name">{{ assistantName() }}</span>
            <span class="status-line"><i class="dot-online"></i> Active Instance</span>
          </div>
        </div>
        <div class="topctl">
          <!-- Admin-only: Response Editor (studio) + settings gear. Non-admins see nothing. -->
          <button class="iconbtn" *ngIf="admin.isAdmin()" (click)="studioOpen = !studioOpen" title="Response Editor">🎭</button>
          <button class="iconbtn" *ngIf="admin.isAdmin()" (click)="settingsOpen = !settingsOpen" title="Ajustes">⚙️</button>
        </div>
      </header>

      <!-- ===================== BASE LAYER: full-screen avatar ===================== -->
      <!-- Canvas is resized via avatar-tts' ResizeObserver (camera aspect + renderer),
           never recreated — the cached GLB, WebGL context, and avatar state persist. -->
      <div class="viewport" [class.pip]="pipActive()">
        <div class="glow"></div>
        <app-avatar-tts [avatarUrl]="avatarUrl" (rigReport)="onRigReport($event)"></app-avatar-tts>
        <button class="pip-x" *ngIf="pipActive()" (click)="closeDetail(); closeMediaViewer()" title="Expandir avatar">⤢</button>
      </div>

      <!-- floating toasts (top-center) -->
      <div class="toastwrap">
        <div class="toast warn" *ngIf="tts.gestureWarnings().length">
          <div *ngFor="let w of tts.gestureWarnings()">⚠️ {{ w }}</div>
        </div>
        <div class="toast err" *ngIf="tts.error()">⚠️ {{ tts.error() }}</div>
      </div>

      <!-- ===================== ADMIN STUDIO OVERLAY (hidden until opened) ===================== -->
      <div class="studio-overlay" *ngIf="admin.isAdmin() && studioOpen">
        <div class="studio-head">
          <span class="studio-title">🎭 Studio</span>
          <button class="iconbtn" (click)="studioOpen = false" title="Cerrar">✕</button>
        </div>

          <!-- Preview Editor Panel — admin-only, collapsed by default (previewMode=false). -->
          <div class="preview-panel" *ngIf="admin.isAdmin()" [class.open]="previewMode">
            <button class="drawer-toggle preview-toggle" (click)="previewMode = !previewMode"
                    [class.active]="previewMode" title="Author and preview avatar responses with gesture markup">
              🎭 Response Editor {{ previewMode ? '▾' : '▸' }}
            </button>

            <div class="preview-body" *ngIf="previewMode">
              <!-- Gesture insert row -->
              <div class="preview-insert-row">
                <select [(ngModel)]="previewGestureId" class="gesture-select">
                  <option value="" disabled>— pick gesture —</option>
                  <optgroup label="Built-in">
                    <option *ngFor="let g of builtInGestures()" [value]="g.id">{{ g.id }}</option>
                  </optgroup>
                  <optgroup label="Custom" *ngIf="gestureRegistry.customGestures().length">
                    <option *ngFor="let g of gestureRegistry.customGestures()" [value]="g.id">{{ g.id }}</option>
                  </optgroup>
                </select>
                <button class="ghost small" (click)="insertGesture()" [disabled]="!previewGestureId"
                        title="Insert [gestureId] token at cursor">＋ Insert</button>
                <span class="hint">[id]:[reps]:[speed]</span>
              </div>

              <!-- Response text area -->
              <textarea #previewTextareaEl
                        [(ngModel)]="previewText"
                        rows="4" maxlength="3000"
                        placeholder="Type the avatar's response here. Use the picker above to insert gesture tokens like [yes]:[2]:[slow] anywhere in the text."></textarea>

              <!-- Lead-in / Tail blocks -->
              <div class="block-row">
                <div class="block-cell">
                  <label class="block-label">▶ Lead-in</label>
                  <select [(ngModel)]="previewLeadGestureId" class="gesture-select small-select">
                    <option value="">— none —</option>
                    <optgroup label="Built-in">
                      <option *ngFor="let g of builtInGestures()" [value]="g.id">{{ g.id }}</option>
                    </optgroup>
                    <optgroup label="Custom" *ngIf="gestureRegistry.customGestures().length">
                      <option *ngFor="let g of gestureRegistry.customGestures()" [value]="g.id">{{ g.id }}</option>
                    </optgroup>
                  </select>
                </div>
                <div class="block-cell">
                  <label class="block-label">◀ Tail</label>
                  <select [(ngModel)]="previewTailGestureId" class="gesture-select small-select">
                    <option value="">— none —</option>
                    <optgroup label="Built-in">
                      <option *ngFor="let g of builtInGestures()" [value]="g.id">{{ g.id }}</option>
                    </optgroup>
                    <optgroup label="Custom" *ngIf="gestureRegistry.customGestures().length">
                      <option *ngFor="let g of gestureRegistry.customGestures()" [value]="g.id">{{ g.id }}</option>
                    </optgroup>
                  </select>
                </div>
                <span class="hint block-hint">Lead-in plays first (filler); tail plays after speech</span>
              </div>

              <!-- LLM Command output — live preview of the canonical sequence string -->
              <div class="cmd-row" *ngIf="llmCommand">
                <div class="cmd-header">
                  <label class="block-label">📋 LLM Command</label>
                  <span class="hint">copy this as the target output format for your LLM</span>
                </div>
                <div class="cmd-box">
                  <textarea class="cmd-textarea" readonly [value]="llmCommand" rows="2" spellcheck="false"></textarea>
                  <button class="ghost small cmd-copy" (click)="copyCommand()" title="Copy command to clipboard">⎘ Copy</button>
                </div>
              </div>

              <!-- Action row -->
              <div class="drawer-actions">
                <button class="ghost accent" (click)="generatePreview()"
                        [disabled]="previewBusy() || (!previewText.trim() && !previewLeadGestureId && !previewTailGestureId)"
                        title="Generate avatar performance: lead-in → text → tail">
                  {{ previewRunning ? '⏳ Running…' : '🎭 Generate Preview' }}
                </button>
                <button class="ghost" (click)="fillPreviewDemo()">💡 Demo</button>
                <button class="ghost small" (click)="stopPreview()" [disabled]="!previewBusy()"
                        title="Stop current preview">⏹</button>
                <button class="ghost small" (click)="previewText = ''" [disabled]="!previewText"
                        title="Clear editor">✕ Clear</button>
                <span class="counter">{{ previewText.length }}/3000</span>
              </div>
            </div>
          </div>

          <!-- bottom drawer: manual text mode (secondary) -->
          <div class="drawer" [class.open]="textMode">
            <button class="drawer-toggle" (click)="textMode = !textMode">
              ⌨️ Modo directo (sin IA) {{ textMode ? '▾' : '▸' }}
            </button>
            <div class="drawer-body" *ngIf="textMode">
              <textarea [(ngModel)]="text" (keydown.enter)="onEnter($event)" rows="3" maxlength="2000"
                        placeholder="Texto directo al avatar (sin IA, con markup) — Enter para hablar"></textarea>
              <div class="drawer-actions">
                <button class="ghost" (click)="speakManual()" [disabled]="!text.trim()">▶️ Speak</button>
                <button class="ghost" (click)="fillDemo()">🎭 Demo</button>
                <span class="counter">{{ text.length }}/2000</span>
              </div>
            </div>
          </div>
      </div>

      <!-- ===================== FLOATING CHAT OVERLAY (upper-right, glass) ===================== -->
      <aside class="chat floating">
          <div class="chat-head">
            <h2>Conversación</h2>
            <div class="chat-head-ctl">
              <!-- Icon-only content reload; tooltip shows last-updated; click runs the per-assistant sync. -->
              <button class="reload-icon" *ngIf="ragMode" (click)="syncConvContent()" [disabled]="syncing()"
                      [class.spin]="syncing()" [class.hot]="syncState() === 'changes'"
                      [title]="syncTooltip()" aria-label="Recargar contenido">↻</button>
              <button class="iconbtn-sm" (click)="conv.clear()" [disabled]="!conv.messages().length" title="Limpiar conversación">🧹</button>
            </div>
          </div>

          <div class="feed" #feedEl (scroll)="onFeedScroll()">
            <div class="empty" *ngIf="!conv.messages().length && !conv.streaming() && !stt.interim()">
              Pulsa el micrófono y habla
            </div>

            <ng-container *ngFor="let m of conv.messages(); let i = index">
              <div class="sysline" *ngIf="m.role === 'system' && (showProcess || m.kind === 'error')"
                   [class.errline]="m.kind === 'error'" [title]="msgTitle(m)">
                {{ m.content }}
              </div>
              <div class="bubble user" *ngIf="m.role === 'user'" [title]="msgTitle(m)">{{ m.content }}</div>
              <div class="bubble bot" *ngIf="m.role === 'assistant'"
                   [class.karaoke]="isSpokenNow(m)" [title]="msgTitle(m)">
                <ng-container *ngFor="let seg of revealSegments(m)">
                  <span *ngIf="seg.kind === 'text'">{{ seg.value }}</span>
                  <span class="chip" *ngIf="seg.kind === 'chip' && showMarkup">{{ seg.value }}</span>
                </ng-container>
                <span class="cursor" *ngIf="isRevealing(m)">▍</span>
                <!-- Appears only when detail exists AND the typing/paint reveal of this message has finished. -->
                <button class="vermas" *ngIf="canShowDetail(m)" (click)="openDetail(m)">Ver más</button>
                <!-- Media is NOT shown inline (chat is text-only); it lives in the left "Contenido relacionado" panel. -->
                <div class="botfoot">
                  <span class="meta" *ngIf="m.meta">{{ m.meta }}</span>
                  <button class="replay" *ngIf="m.replayable" (click)="replay(m.id)" title="Repetir (voz + gestos)">↻</button>
                </div>
              </div>
            </ng-container>

            <div class="bubble bot streaming" *ngIf="conv.streaming()">{{ conv.streaming() }}</div>
            <div class="bubble user interimb" *ngIf="stt.interim()">{{ stt.interim() }}…</div>
            <div class="inline-err" *ngIf="stt.error()">{{ stt.error() }}</div>
          </div>

      </aside>

      <!-- ===================== LEFT "CONTENIDO RELACIONADO" MEDIA PANEL ===================== -->
      <!-- Compact, scrollable media history: newest carousel shown by default (auto-scrolled
           to bottom), scroll up to revisit earlier responses' media. Hidden when empty. -->
      <aside class="media-panel floating" *ngIf="mediaMessages().length">
        <div class="media-head">
          <h2>Contenido relacionado</h2>
        </div>
        <div class="media-feed" #mediaFeedEl>
          <div class="media-entry" *ngFor="let m of mediaMessages(); trackBy: trackMsg">
            <app-media-gallery [media]="m.media!" mode="preview"
                               (openViewer)="openMediaViewer(m, $event)"></app-media-gallery>
          </div>
        </div>
      </aside>

      <!-- ===================== FLOATING BOTTOM CLUSTER (center, over avatar) ===================== -->
      <div class="bottom-cluster">
        <!-- status pill -->
        <div class="statuspill" [ngSwitch]="conv.state()">
          <ng-container *ngSwitchCase="'listening'">
            <span class="wave"><i></i><i></i><i></i><i></i><i></i></span> Escuchando…
          </ng-container>
          <ng-container *ngSwitchCase="'sending'">
            <span class="dots"><i></i><i></i><i></i></span> Pensando…
          </ng-container>
          <ng-container *ngSwitchCase="'waiting_llm'">
            <span class="dots"><i></i><i></i><i></i></span> Pensando…
          </ng-container>
          <ng-container *ngSwitchCase="'speaking'">
            <span class="spk"></span> {{ tts.bridging() ? '…' : 'Hablando…' }}
          </ng-container>
          <ng-container *ngSwitchCase="'error'">⚠️ Error</ng-container>
          <ng-container *ngSwitchDefault>🕐 Esperando…</ng-container>
        </div>

        <!-- circular controls: Stop↔Repeat toggle / mic / mute -->
        <div class="microw">
          <!-- Speaking → Stop (clean halt + neutral pose). Otherwise → Repeat last response. -->
          <button class="ctl small stop" *ngIf="conv.state() === 'speaking'"
                  (click)="stopSpeech()" title="Detener voz">■</button>
          <button class="ctl small" *ngIf="conv.state() !== 'speaking'"
                  (click)="repeatLast()" [disabled]="!lastReplayable()" title="Repetir última respuesta">↻</button>
          <button class="micbtn"
                  [class.listening]="conv.state() === 'listening'"
                  [class.processing]="conv.state() === 'sending' || conv.state() === 'waiting_llm'"
                  (click)="micPress()" [disabled]="!stt.isSupported || conv.muted"
                  [title]="micTitle()">
            <span class="rings" *ngIf="conv.state() === 'listening'"></span>
            <span class="spinner" *ngIf="conv.state() === 'sending' || conv.state() === 'waiting_llm'"></span>
            🎤
          </button>
          <button class="ctl small" [class.active]="conv.muted" (click)="toggleMute()" title="Silenciar micrófono">
            {{ conv.muted ? '🔇' : '🎙️' }}
          </button>
        </div>
        <p class="stt-unsupported" *ngIf="!stt.isSupported">
          Este navegador no soporta reconocimiento de voz — usa Chrome o Edge, o el Modo texto.
        </p>

        <!-- suggested-prompt chips -->
        <div class="chips" *ngIf="ragMode && suggestedPrompts().length">
          <button class="chip" *ngFor="let p of suggestedPrompts()" (click)="sendChip(p)"
                  [disabled]="conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                  [title]="p.prompt">{{ p.label }}</button>
        </div>

        <!-- message input -->
        <div class="chat-input">
          <textarea rows="1" [(ngModel)]="convText" maxlength="1000"
                    (keydown.enter)="onConvEnter($event)"
                    [disabled]="conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                    [placeholder]="'Envía un mensaje a ' + assistantName() + '…'"></textarea>
          <button class="send" (click)="sendTyped()"
                  [disabled]="!convText.trim() || conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                  title="Enviar (Enter)">➤</button>
        </div>
      </div>

      <!-- ============================== FULL-SCREEN DETAIL ============================== -->
      <div class="detail-overlay" *ngIf="detailOpen() as dm">
        <header class="do-head">
          <div>
            <span class="do-kicker">Análisis detallado</span>
            <h1>{{ detailTitle() }}</h1>
          </div>
          <button class="do-x" (click)="closeDetail()" title="Cerrar">✕</button>
        </header>
        <div class="do-scroll">
          <!-- STAGE 2 loading: detail is generated on demand when "Ver mas" is clicked. -->
          <div class="do-loading" *ngIf="detailLoading()">
            <span class="do-spin"></span> Generando el detalle...
          </div>
          <p class="do-err" *ngIf="detailError() && !detailLoading()">No se pudo generar el detalle: {{ detailError() }}</p>
          <!-- TEXT ONLY: media is handled separately via the chat carousel -->
          <article class="do-text" *ngIf="!detailLoading()">
            <p *ngFor="let p of detailParas()">{{ p }}</p>
          </article>
        </div>
      </div>

      <!-- ============ FULL-SCREEN IMAGE VIEWER (root-level, image-only) ============ -->
      <app-media-gallery *ngIf="mediaViewer() as mv" mode="viewer"
                         [media]="mv.media" [startIndex]="mv.index"
                         (closed)="closeMediaViewer()"></app-media-gallery>

      <!-- ============================== SETTINGS SLIDE-OVER ============================== -->
      <div class="backdrop" *ngIf="settingsOpen" (click)="settingsOpen = false"></div>
      <div class="slideover" [class.open]="settingsOpen">
        <div class="so-head">
          <h2>Ajustes</h2>
          <button class="iconbtn" (click)="settingsOpen = false">✕</button>
        </div>

        <h4>Proveedor LLM — {{ providerLabels[llm.settings().provider] }}</h4>
        <label>Proveedor
          <select [ngModel]="llm.settings().provider" (ngModelChange)="setLlmProvider($event)">
            <option *ngFor="let p of providerIds" [value]="p">{{ providerLabels[p] }}</option>
          </select>
        </label>
        <label>Modelo
          <input type="text" [ngModel]="activeCfg.model" (ngModelChange)="setCfg('model', $event)" />
        </label>
        <label *ngIf="llm.settings().provider === 'ollama' || llm.settings().provider === 'deepseek'">Base URL
          <input type="text" [ngModel]="activeCfg.baseUrl" (ngModelChange)="setCfg('baseUrl', $event)" />
        </label>
        <label *ngIf="llm.settings().provider !== 'ollama'">API key
          <input type="password" autocomplete="off" [ngModel]="activeCfg.apiKey" (ngModelChange)="setCfg('apiKey', $event)"
                 placeholder="se guarda solo en este navegador" />
        </label>
        <p class="note warn-text">⚠️ Las API keys se guardan en localStorage y van directo desde el navegador: solo pruebas locales.</p>
        <p class="note" *ngIf="llm.settings().provider === 'ollama'">
          Ollama local: <code>OLLAMA_ORIGINS="*" ollama serve</code> y <code>ollama pull llama3.2</code>.
        </p>

        <h4>Conversación</h4>
        <label class="chk"><input type="checkbox" [(ngModel)]="conv.continuous" /> Conversación continua</label>
        <label class="chk"><input type="checkbox" [(ngModel)]="showMarkup" /> Mostrar chips de gestos (debug)</label>
        <label class="chk"><input type="checkbox" [(ngModel)]="showProcess" /> Mostrar procesos (líneas de sistema)</label>
        <label>Máx. turnos
          <input type="number" min="1" max="50" [ngModel]="llm.settings().maxTurns" (ngModelChange)="setMaxTurns($event)" />
        </label>
        <label>Máx. tokens por respuesta
          <input type="number" min="50" max="2000" [ngModel]="llm.settings().maxReplyTokens" (ngModelChange)="setMaxReplyTokens($event)" />
        </label>

        <h4>System prompt</h4>
        <textarea rows="9" class="sysprompt" [ngModel]="llm.settings().systemPrompt" (ngModelChange)="setSystemPrompt($event)"></textarea>
        <button class="ghost" (click)="llm.resetSystemPrompt()">↩️ Restaurar prompt por defecto</button>

        <h4>Voz (TTS)</h4>
        <label>Motor
          <select [(ngModel)]="provider" (ngModelChange)="onProviderOrLangChange()">
            <option value="piper">Piper (local, neural)</option>
            <option value="webspeech">Web Speech (voces del SO)</option>
          </select>
        </label>
        <label>Idioma
          <select [ngModel]="lang" (ngModelChange)="setLang($event)">
            <option value="es">Español (ES)</option>
            <option value="en">English (EN)</option>
          </select>
        </label>
        <label>Voz
          <select [(ngModel)]="voiceId">
            <option *ngFor="let v of piperVoices[lang]" [value]="v.id">{{ v.label }}</option>
          </select>
        </label>

        <h4>Avatar</h4>
        <div class="avatar-grid">
          <div *ngFor="let a of catalog.catalog()"
               class="avatar-card" [class.selected]="catalog.selectedId() === a.id"
               (click)="selectAvatar(a.id)" [title]="avatarCardTitle(a.id)">
            <div class="avatar-thumb-wrapper">
              <img *ngIf="thumbUrl(a.id)" [src]="thumbUrl(a.id)" [alt]="a.name" class="avatar-thumb" />
              <span *ngIf="!thumbUrl(a.id)" class="avatar-thumb placeholder" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6">
                  <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
                </svg>
              </span>
            </div>
            <span class="avatar-name">{{ a.name }}</span>
            <span class="conf-badge" *ngIf="confOf(a.id) as c" [ngClass]="'conf-' + c">{{ confDot(c) }}</span>
          </div>
        </div>
        <p class="note err-text" *ngIf="avatarLoadError()">⚠️ {{ avatarLoadError() }}</p>
        <div class="conf-detail" *ngIf="selectedReport() as r">
          <b>{{ confLabel(r.conformance) }}</b> — {{ r.matchedArkit.length }}/52 ARKit, head bone: {{ r.hasHeadBone ? '✓' : '✕' }}
          <div *ngFor="let w of r.warnings" class="conf-warn">⚠️ {{ w }}</div>
        </div>

        <label class="manual-label">…o carga un GLB manual (dev/fallback)
          <input type="text" [(ngModel)]="avatarUrlInput" placeholder="https://... .glb o /assets/models/avatar.glb" />
        </label>
        <button class="ghost" (click)="loadAvatar()" [disabled]="!avatarUrlInput.trim()">🧑 Cargar avatar manual</button>
        <p class="note">Los avatares del catálogo se resuelven desde Firebase Storage por ruta (sin tokens). Ready Player Me cerró su hosting (2026-01-31).</p>

        <h4>Modo informativo (RAG)</h4>
        <label class="chk"><input type="checkbox" [ngModel]="ragMode" (ngModelChange)="setRagMode($event)" /> Activar respuestas desde la base de conocimiento (Cloud Function)</label>
        <p class="note">Con esto activado, cada pregunta (voz o texto) se responde vía la Cloud Function (Vertex AI + RAG), no el LLM del navegador. El lead-in cubre la latencia.</p>
        <label>Endpoint de la Function
          <input type="text" [ngModel]="ragEndpoint" (ngModelChange)="onRagEndpointChange($event)" placeholder="https://…cloudfunctions.net/api/rag/query" />
        </label>
        <label>Assistant ID
          <input type="text" [ngModel]="assistantId" (ngModelChange)="onAssistantIdChange($event)" placeholder="default" />
          <button class="ghost small" (click)="reloadAssistant()">↻ Cargar asistente</button>
        </label>
        <div class="conf-detail" *ngIf="assistant() as d">
          <b>{{ d.name || d.id }}</b> — avatar: {{ d.avatarId }} · tema: {{ d.ragCollection }} · voz: {{ d.voice || '—' }}<br>
          lead: {{ d.leadGestureId || '—' }} · tail: {{ d.tailGestureId || '—' }}<span *ngIf="d.activationCommand"> · “{{ d.activationCommand }}”</span>
        </div>
        <p class="note err-text" *ngIf="assistantSvc.error()">⚠️ {{ assistantSvc.error() }}</p>
        <p class="note err-text" *ngIf="ragError()">⚠️ {{ ragError() }}</p>
      </div>
    </div>
  `,
    styles: [`
    :host { display: block; height: 100vh; }
    * { box-sizing: border-box; }
    .app {
      position: relative; height: 100%; overflow: hidden;
      background: #0E0F13; color: #E8E9EE;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      --accent: #8B5CF6; --accent-soft: rgba(139, 92, 246, .18);
    }
    /* Floating top bar: faint gradient scrim for legibility, no solid bar. */
    .topbar.floating {
      position: absolute; top: 0; left: 0; right: 0; z-index: 20;
      display: flex; align-items: flex-start; justify-content: space-between;
      padding: 14px 18px 28px; pointer-events: none;
      background: linear-gradient(to bottom, rgba(8,8,12,.55) 0%, rgba(8,8,12,.18) 55%, transparent 100%);
    }
    .topbar.floating .brand, .topbar.floating .topctl { pointer-events: auto; }
    .brand { display: flex; align-items: center; gap: 11px; font-size: 17px; font-weight: 700; letter-spacing: .3px; }
    .brandtext { display: flex; flex-direction: column; line-height: 1.15; }
    .brandtext .name { font-size: 17px; font-weight: 700; color: #f3f0ff; text-shadow: 0 1px 6px rgba(0,0,0,.7); }
    .status-line { font-size: 10.5px; letter-spacing: 1.2px; text-transform: uppercase; color: #b9b2d6;
      font-family: 'JetBrains Mono', ui-monospace, monospace; text-shadow: 0 1px 4px rgba(0,0,0,.7);
      display: flex; align-items: center; gap: 6px; margin-top: 2px; }
    .dot-online { width: 7px; height: 7px; border-radius: 50%; background: #34d399; box-shadow: 0 0 7px #34d399; }
    .backbtn {
      width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255,255,255,.14);
      background: rgba(20,18,30,.45); backdrop-filter: blur(8px); color: #E8E9EE; cursor: pointer;
      font-size: 18px; line-height: 1; display: grid; place-items: center; transition: background .15s; flex: none;
    }
    .backbtn:hover { background: rgba(40,36,60,.65); }
    .topctl { display: flex; align-items: center; gap: 10px; }
    .pill {
      display: flex; align-items: center; gap: 7px; padding: 6px 12px;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
      border-radius: 999px; font-size: 12.5px;
    }
    .pill select { background: transparent; color: #E8E9EE; border: none; outline: none; font-size: 12.5px; max-width: 150px; cursor: pointer; }
    .pill select option { background: #16171d; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .dot.ok { background: #34d399; box-shadow: 0 0 6px #34d39988; }
    .dot.err { background: #f87171; box-shadow: 0 0 6px #f8717188; }
    .lang { cursor: pointer; color: #888; gap: 3px; }
    .lang b { color: #666; font-weight: 600; }
    .lang b.on { color: var(--accent); }
    .iconbtn {
      width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,.14);
      background: rgba(20,18,30,.45); backdrop-filter: blur(8px); color: #E8E9EE; cursor: pointer; font-size: 15px;
      display: grid; place-items: center; transition: background .15s;
    }
    .iconbtn:hover:not(:disabled) { background: rgba(40,36,60,.65); }
    .iconbtn:disabled { opacity: .35; cursor: default; }
    .iconbtn-sm {
      width: 26px; height: 26px; border-radius: 50%; border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06); color: #cfd3dc; cursor: pointer; font-size: 12px;
      display: grid; place-items: center; transition: background .15s; flex: none;
    }
    .iconbtn-sm:hover:not(:disabled) { background: rgba(255,255,255,.14); }
    .iconbtn-sm:disabled { opacity: .35; cursor: default; }

    /* BASE LAYER: avatar fills the entire screen, edge-to-edge. */
    .viewport {
      position: absolute; inset: 0; z-index: 1; overflow: hidden;
      background: radial-gradient(ellipse at 50% 30%, #1a1530 0%, #0a0a0f 70%);
    }
    .viewport app-avatar-tts { position: absolute; inset: 0; }
    .viewport ::ng-deep .canvas-container { background-color: transparent !important; }
    /* Picture-in-picture: shrink to a bottom-right corner. The avatar-tts
       ResizeObserver resizes the existing canvas -- no GLB reload. */
    .viewport.pip {
      position: fixed; right: 18px; bottom: 18px; left: auto; top: auto;
      width: 220px; height: 165px; flex: none; z-index: 70;
      border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.5);
      transition: width .25s ease, height .25s ease;
    }
    .pip-x { position: absolute; top: 6px; right: 6px; z-index: 2; width: 26px; height: 26px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,.2); background: rgba(0,0,0,.45);
      color: #fff; cursor: pointer; font-size: 13px; }
    /* full-screen detail overlay */
    .detail-overlay { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
      background: radial-gradient(ellipse at 50% 0%, #15122a 0%, #0a0e14 70%); color: #e6e8ee;
      font-family: 'Segoe UI', system-ui, sans-serif; }
    .do-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; padding: 22px 28px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .do-kicker { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #a78bfa; }
    .do-head h1 { margin: 4px 0 0; font-size: 24px; font-weight: 700; max-width: 70ch; }
    .do-x { width: 40px; height: 40px; border-radius: 999px; border: 1px solid rgba(255,255,255,.15);
      background: rgba(255,255,255,.06); color: #cfd3dc; cursor: pointer; font-size: 16px; flex: none; }
    .do-x:hover { background: rgba(255,255,255,.12); color: #fff; }
    .do-scroll { flex: 1; overflow-y: auto; padding: 24px 28px 120px; max-width: 980px; width: 100%; margin: 0 auto; }
    .do-text p { font-size: 15px; line-height: 1.7; color: #c7ccd6; margin: 0 0 16px; }
    .do-text p:first-child { color: #e6e8ee; }
    .do-loading { display: flex; align-items: center; gap: 10px; color: #b9b2d6; font-size: 14px; padding: 8px 0; }
    .do-spin { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,.18); border-top-color: #a78bfa; border-radius: 50%; animation: spin 1s linear infinite; }
    .do-err { color: #fca5a5; font-size: 13.5px; }
    .glow {
      position: absolute; left: 50%; top: 38%; width: 480px; height: 480px;
      transform: translate(-50%, -50%); pointer-events: none; z-index: 1;
      background: radial-gradient(circle, rgba(139,92,246,.45) 0%, rgba(139,92,246,.12) 45%, transparent 70%);
      mix-blend-mode: screen;
    }
    .statuspill {
      display: inline-flex; align-items: center; gap: 8px; align-self: center;
      background: rgba(14,15,19,.7); backdrop-filter: blur(8px);
      border: 1px solid rgba(139,92,246,.35); color: #ddd;
      padding: 7px 16px; border-radius: 999px; font-size: 13px; white-space: nowrap;
      box-shadow: 0 6px 20px rgba(0,0,0,.35);
    }
    .wave { display: inline-flex; gap: 2px; align-items: flex-end; height: 14px; }
    .wave i { width: 3px; background: var(--accent); border-radius: 2px; animation: wv 1s ease-in-out infinite; }
    .wave i:nth-child(1) { height: 6px; }
    .wave i:nth-child(2) { height: 11px; animation-delay: .15s; }
    .wave i:nth-child(3) { height: 14px; animation-delay: .3s; }
    .wave i:nth-child(4) { height: 9px; animation-delay: .45s; }
    .wave i:nth-child(5) { height: 5px; animation-delay: .6s; }
    @keyframes wv { 50% { transform: scaleY(.4); } }
    .dots { display: inline-flex; gap: 4px; }
    .dots i { width: 6px; height: 6px; background: var(--accent); border-radius: 50%; animation: dt 1.2s infinite; }
    .dots i:nth-child(2) { animation-delay: .2s; }
    .dots i:nth-child(3) { animation-delay: .4s; }
    @keyframes dt { 30% { opacity: .25; transform: translateY(-3px); } }
    .spk { width: 9px; height: 9px; background: var(--accent); border-radius: 50%; animation: pulse 1s infinite; }
    @keyframes pulse { 50% { opacity: .4; } }
    .toastwrap { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 30;
      width: min(560px, 82vw); display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .toast { padding: 9px 14px; border-radius: 10px; font-size: 12.5px; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
    .toast.warn { background: rgba(160,120,20,.9); }
    .toast.err { background: rgba(160,30,30,.92); }

    .microw { display: flex; align-items: center; justify-content: center; gap: 18px; flex: none; }
    .micbtn {
      position: relative; width: 76px; height: 76px; border-radius: 50%;
      border: 2px solid rgba(139,92,246,.55); background: transparent; color: #fff;
      font-size: 26px; cursor: pointer; display: grid; place-items: center;
      transition: background .2s, border-color .2s, transform .1s;
    }
    .micbtn:hover:not(:disabled) { background: var(--accent-soft); transform: scale(1.03); }
    .micbtn:disabled { opacity: .35; cursor: default; }
    .micbtn.listening { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 28px rgba(139,92,246,.6); }
    .rings { position: absolute; inset: -2px; border-radius: 50%; border: 2px solid var(--accent); animation: ring 1.4s ease-out infinite; pointer-events: none; }
    @keyframes ring { 0% { transform: scale(1); opacity: .8; } 100% { transform: scale(1.55); opacity: 0; } }
    .spinner { position: absolute; inset: -2px; border-radius: 50%; pointer-events: none; border: 2px solid transparent; border-top-color: var(--accent); animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ctl {
      width: 46px; height: 46px; border-radius: 50%; border: 1px solid rgba(255,255,255,.16);
      background: rgba(20,18,30,.5); backdrop-filter: blur(8px); color: #e6e6ee; font-size: 16px; cursor: pointer;
      display: grid; place-items: center; transition: background .15s;
    }
    .ctl:hover:not(:disabled) { background: rgba(40,36,60,.7); }
    .ctl:disabled { opacity: .35; cursor: default; }
    .ctl.active { background: #b33939; border-color: #b33939; color: #fff; }
    .ctl.stop { background: rgba(179,57,57,.85); border-color: #c0392b; color: #fff; }
    .ctl.stop:hover:not(:disabled) { background: #c0392b; }
    .stt-unsupported { text-align: center; color: #d9a440; font-size: 12px; margin: -6px 0 0; }

    .drawer { flex: none; }
    .drawer-toggle { background: none; border: none; color: #777; font-size: 12.5px; cursor: pointer; padding: 4px 2px; }
    .drawer-toggle:hover { color: #aaa; }
    .drawer-body { display: flex; flex-direction: column; gap: 8px; padding-top: 6px; }
    .drawer-body textarea {
      width: 100%; resize: vertical; min-height: 64px;
      background: rgba(255,255,255,.04); color: #E8E9EE; border: 1px solid rgba(255,255,255,.1);
      border-radius: 12px; padding: 10px 12px; font-size: 14px; line-height: 1.5;
    }
    .drawer-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .counter { margin-left: auto; font-size: 11px; color: #666; }
    .ghost {
      padding: 8px 16px; border-radius: 10px; cursor: pointer; font-size: 13px;
      background: rgba(255,255,255,.06); color: #ddd; border: 1px solid rgba(255,255,255,.1);
      transition: background .15s;
    }
    .ghost:hover:not(:disabled) { background: rgba(255,255,255,.12); }
    .ghost:disabled { opacity: .4; cursor: default; }
    .ghost.small { padding: 6px 10px; font-size: 12px; }
    .ghost.accent {
      background: rgba(139,92,246,.18); border-color: rgba(139,92,246,.4); color: #c4b0f7;
    }
    .ghost.accent:hover:not(:disabled) { background: rgba(139,92,246,.3); }

    /* ---- Admin Studio overlay (floating, hidden until opened) ---- */
    .studio-overlay {
      position: absolute; left: 16px; bottom: 16px; z-index: 25;
      width: min(380px, 90vw); max-height: 82vh; overflow-y: auto;
      display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
      background: rgba(16,15,24,.86); backdrop-filter: blur(18px);
      border: 1px solid rgba(139,92,246,.3); border-radius: 16px;
      box-shadow: 0 18px 50px rgba(0,0,0,.6);
    }
    .studio-head { display: flex; align-items: center; justify-content: space-between; }
    .studio-title { font-size: 13px; font-weight: 700; color: #c4b0f7; letter-spacing: .3px; }

    /* ---- Preview Editor Panel ---- */
    .preview-panel { flex: none; }
    .preview-toggle { color: #9b87c4 !important; }
    .preview-toggle:hover { color: #c4b0f7 !important; }
    .preview-toggle.active { color: var(--accent) !important; font-weight: 600; }
    .preview-body {
      display: flex; flex-direction: column; gap: 8px; padding: 10px;
      background: rgba(139,92,246,.06); border: 1px solid rgba(139,92,246,.15);
      border-radius: 14px; margin-top: 6px;
    }
    .preview-insert-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .gesture-select {
      flex: 1; min-width: 120px; max-width: 220px;
      background: rgba(255,255,255,.05); color: #E8E9EE; border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px; padding: 6px 10px; font-size: 12.5px; cursor: pointer;
    }
    .gesture-select option, .gesture-select optgroup { background: #16171d; color: #E8E9EE; }
    .hint { font-size: 10.5px; color: #667; font-family: monospace; white-space: nowrap; }
    .preview-body textarea {
      width: 100%; resize: vertical; min-height: 80px;
      background: rgba(255,255,255,.04); color: #E8E9EE; border: 1px solid rgba(139,92,246,.2);
      border-radius: 12px; padding: 10px 12px; font-size: 13.5px; line-height: 1.55;
    }
    .preview-body textarea:focus { outline: none; border-color: rgba(139,92,246,.5); }
    .block-row { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
    .block-cell { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 130px; }
    .block-label { font-size: 10.5px; color: #8896a9; font-weight: 600; letter-spacing: .4px; text-transform: uppercase; }
    .small-select { padding: 5px 8px !important; font-size: 12px !important; }
    .block-hint { font-size: 10px; color: #556; align-self: flex-end; padding-bottom: 6px; flex: 2; }
    .cmd-row { display: flex; flex-direction: column; gap: 4px; }
    .cmd-header { display: flex; align-items: baseline; gap: 10px; }
    .cmd-box { display: flex; align-items: flex-start; gap: 6px; }
    .cmd-textarea { flex: 1; resize: none; background: rgba(0,0,0,.25); color: #a8b5c8; border: 1px solid rgba(139,92,246,.15); border-radius: 10px; padding: 8px 10px; font-size: 11.5px; font-family: 'JetBrains Mono', 'Fira Code', monospace; line-height: 1.5; cursor: text; }
    .cmd-textarea:focus { outline: none; }
    .cmd-copy { margin-top: 2px; flex: none; }

    /* Floating, semi-transparent full-height chat panel anchored on the right. */
    .chat.floating {
      position: absolute; top: 74px; right: 16px; bottom: 24px; z-index: 15;
      width: 340px; max-width: 38vw;
      display: flex; flex-direction: column; overflow: hidden;
      background: rgba(14,13,22,.42); backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,.12); border-radius: 18px;
      box-shadow: 0 16px 48px rgba(0,0,0,.5);
    }
    /* Compact, semi-transparent media history panel anchored on the left. */
    .media-panel.floating {
      position: absolute; left: 16px; top: 50%; transform: translateY(-50%); z-index: 15;
      width: 248px; max-width: 26vw; max-height: 56vh;
      display: flex; flex-direction: column; overflow: hidden;
      background: rgba(14,13,22,.42); backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,.12); border-radius: 18px;
      box-shadow: 0 16px 48px rgba(0,0,0,.5);
    }
    .media-head { padding: 10px 13px; border-bottom: 1px solid rgba(255,255,255,.08); flex: none; }
    .media-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; color: #eceaf6; text-shadow: 0 1px 4px rgba(0,0,0,.6); }
    .media-feed { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
    .media-entry { flex: none; }
    /* Themed scrollbar: transparent track, blue outline (media + chat feeds). */
    .media-feed::-webkit-scrollbar, .feed::-webkit-scrollbar { width: 8px; }
    .media-feed::-webkit-scrollbar-track, .feed::-webkit-scrollbar-track { background: transparent; }
    .media-feed::-webkit-scrollbar-thumb, .feed::-webkit-scrollbar-thumb {
      background: transparent; border: 1px solid rgba(96,165,250,.7); border-radius: 999px;
    }
    .media-feed::-webkit-scrollbar-thumb:hover, .feed::-webkit-scrollbar-thumb:hover { border-color: rgba(96,165,250,1); }
    .media-feed, .feed { scrollbar-width: thin; scrollbar-color: rgba(96,165,250,.7) transparent; }
    .chat-head { display: flex; align-items: center; justify-content: space-between; padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,.08); flex: none; }
    .chat-head h2 { margin: 0; font-size: 13.5px; font-weight: 600; color: #eceaf6; text-shadow: 0 1px 4px rgba(0,0,0,.6); }
    .chat-head-ctl { display: flex; align-items: center; gap: 8px; }
    .reload-icon {
      width: 26px; height: 26px; border-radius: 50%; flex: none; cursor: pointer; font-size: 13px;
      display: grid; place-items: center; transition: background .15s, color .15s, border-color .15s;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); color: #c7ccd6;
    }
    .reload-icon:hover:not(:disabled) { background: rgba(255,255,255,.12); color: #fff; }
    .reload-icon:disabled { opacity: .55; cursor: default; }
    .reload-icon.hot { background: rgba(240,198,116,.18); border-color: rgba(240,198,116,.55); color: #f0c674; }
    .reload-icon.spin { animation: spin 1s linear infinite; }
    .feed { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 9px; }
    .empty { margin: auto; color: #9aa; font-size: 13px; text-align: center; text-shadow: 0 1px 4px rgba(0,0,0,.6); }
    /* New messages fade in (stream-chat feel). Legible over a variable 3D backdrop. */
    .bubble { max-width: 92%; padding: 8px 12px; border-radius: 13px; font-size: 13px; line-height: 1.5;
      text-shadow: 0 1px 3px rgba(0,0,0,.5); animation: bubblein .35s ease both; }
    @keyframes bubblein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    .bubble.user { align-self: flex-end; background: rgba(139,92,246,.42); border: 1px solid rgba(160,120,255,.45); border-bottom-right-radius: 4px; color: #f1ecff; }
    .bubble.user.interimb { opacity: .6; font-style: italic; }
    .bubble.bot { align-self: flex-start; background: rgba(18,16,28,.62); border: 1px solid rgba(255,255,255,.14); border-bottom-left-radius: 4px; color: #eef0f6; }
    .bubble.bot.streaming { opacity: .7; }
    .bubble.bot.karaoke {
      background: linear-gradient(100deg, rgba(139,92,246,.22) 30%, rgba(139,92,246,.06) 60%, rgba(139,92,246,.22) 90%);
      background-size: 220% 100%; animation: karaoke 2.2s linear infinite;
      border-color: rgba(139,92,246,.4);
    }
    @keyframes karaoke { to { background-position: -120% 0; } }
    .meta { margin-top: 5px; font-size: 10px; color: #66708c; }
    .chip {
      display: inline-block; margin: 0 3px; padding: 1px 8px; border-radius: 999px;
      background: var(--accent-soft); border: 1px solid rgba(139,92,246,.4);
      color: #c4b0f7; font-size: 11px; white-space: nowrap; vertical-align: baseline;
    }
    .karaoke .chip { box-shadow: 0 0 8px rgba(139,92,246,.5); }
    .sysline { align-self: center; text-align: center; color: #66708c; font-size: 11px; max-width: 95%; }
    .botfoot { margin-top: 5px; display: flex; align-items: center; gap: 8px; }
    .cursor { color: var(--accent); animation: blinkc 1s steps(2) infinite; margin-left: 1px; }
    @keyframes blinkc { 50% { opacity: 0; } }
    .replay {
      flex: none; width: 22px; height: 22px; padding: 0; border-radius: 50%;
      background: rgba(139,92,246,.15); border: 1px solid rgba(139,92,246,.35);
      color: #c4b0f7; font-size: 12px; cursor: pointer; opacity: .45; transition: opacity .15s, background .15s;
      display: grid; place-items: center;
    }
    .bubble.bot:hover .replay { opacity: 1; }
    .replay:hover { background: rgba(139,92,246,.35); }
    /* Bootstrap outline-success: green outline, transparent bg, green text, fill on hover. Compact. */
    .vermas { display: inline-block; margin-top: 7px; padding: 3px 11px; border-radius: 6px; cursor: pointer;
      background: transparent; border: 1px solid #22c55e; color: #4ade80; font-size: 11.5px; font-weight: 600;
      line-height: 1.5; transition: background .15s, color .15s; }
    .vermas:hover { background: #22c55e; color: #062b14; }
    /* Floating bottom cluster: status pill + mic + chips + input, centered over avatar. */
    .bottom-cluster {
      position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 15;
      width: min(680px, 92vw); display: flex; flex-direction: column; align-items: center; gap: 12px;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
    .chip { background: rgba(20,18,30,.5); backdrop-filter: blur(8px); border: 1px solid rgba(160,120,255,.4); color: #d6c9fb;
      border-radius: 999px; padding: 6px 14px; font-size: 12px; cursor: pointer; white-space: nowrap;
      text-shadow: 0 1px 3px rgba(0,0,0,.5); font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .chip:hover:not(:disabled) { background: rgba(139,92,246,.4); }
    .chip:disabled { opacity: .45; cursor: default; }
    .syncrow { display: flex; align-items: center; gap: 10px; font-size: 11px; color: #6b7384; flex-wrap: wrap; }
    .synced { color: #8b93a3; }
    .changes { color: #f0c674; font-weight: 600; }
    .syncbtn { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.12); color: #c7ccd6;
      border-radius: 8px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
    .syncbtn:hover:not(:disabled) { background: rgba(255,255,255,.1); }
    .syncbtn:disabled { opacity: .5; cursor: default; }
    .syncbtn.hot { background: rgba(240,198,116,.18); border-color: rgba(240,198,116,.5); color: #f0c674; }
    /* Floating input pill, full width of the bottom cluster. */
    .chat-input {
      width: 100%; display: flex; gap: 8px; align-items: flex-end;
      padding: 7px 7px 7px 16px; border-radius: 26px;
      background: rgba(14,13,22,.5); backdrop-filter: blur(16px);
      border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 36px rgba(0,0,0,.45);
    }
    .chat-input textarea {
      flex: 1; resize: none; min-height: 26px; max-height: 110px;
      background: transparent; color: #E8E9EE; border: none; outline: none;
      padding: 6px 0; font-size: 13.5px; line-height: 1.45;
    }
    .chat-input textarea::placeholder { color: #8b8ba0; }
    .chat-input textarea:disabled { opacity: .5; }
    .send {
      flex: none; width: 38px; height: 38px; border-radius: 50%; border: none;
      background: var(--accent); color: #fff; font-size: 15px; cursor: pointer;
      display: grid; place-items: center; transition: opacity .15s;
    }
    .send:disabled { opacity: .35; cursor: default; }
    .sysline.errline { color: #ff9c9c; font-size: 12px; }
    .inline-err { color: #ff9c9c; font-size: 12px; }

    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 9; }
    .slideover {
      position: fixed; top: 0; right: -420px; width: 400px; max-width: 92vw; height: 100%;
      background: #15161c; border-left: 1px solid rgba(255,255,255,.08); z-index: 10;
      padding: 18px 20px 40px; overflow-y: auto; transition: right .25s ease;
      display: flex; flex-direction: column; gap: 10px;
    }
    .slideover.open { right: 0; }
    .so-head { display: flex; align-items: center; justify-content: space-between; }
    .so-head h2 { margin: 0; font-size: 16px; }
    .slideover h4 { margin: 14px 0 2px; font-size: 13px; color: var(--accent); font-weight: 600; }
    .slideover label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #99a; }
    .slideover input[type=text], .slideover input[type=password], .slideover input[type=number], .slideover select, .slideover textarea {
      background: rgba(255,255,255,.05); color: #E8E9EE; border: 1px solid rgba(255,255,255,.1);
      border-radius: 8px; padding: 8px 10px; font-size: 12.5px; width: 100%;
    }
    .sysprompt { resize: vertical; min-height: 120px; line-height: 1.45; }
    .chk { flex-direction: row !important; align-items: center; gap: 8px; }
    .chk input { width: auto !important; }
    .note { font-size: 11.5px; color: #778; line-height: 1.45; margin: 2px 0; }
    .warn-text { color: #d9a440; }
    .err-text { color: #ff9c9c; }

    /* ---- Avatar catalog picker ---- */
    .avatar-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 4px 0 8px; }
    .avatar-card {
      position: relative; display: flex; flex-direction: column; align-items: center; gap: 5px;
      padding: 9px 6px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.1);
      border-radius: 12px; cursor: pointer; transition: border-color .15s, background .15s;
    }
    .avatar-card:hover { background: rgba(139,92,246,.1); border-color: rgba(139,92,246,.4); }
    .avatar-card.selected { border-color: var(--accent); background: rgba(139,92,246,.16); box-shadow: 0 0 0 1px var(--accent); }
    .avatar-thumb-wrapper {
      width: 52px; height: 52px; border-radius: 50%; overflow: hidden;
      background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.1);
      display: grid; place-items: center;
    }
    .avatar-thumb { width: 100%; height: 100%; object-fit: cover; }
    .avatar-thumb.placeholder { color: #8a7fb0; display: grid; place-items: center; }
    .avatar-name { font-size: 11.5px; color: #E8E9EE; text-align: center; line-height: 1.1; }
    .conf-badge { font-size: 9px; line-height: 1; }
    .conf-full { color: #34d399; } .conf-remapped { color: #8ab4f8; }
    .conf-partial { color: #d9a440; } .conf-incompatible { color: #f87171; }
    .conf-detail { font-size: 11px; color: #98a; background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 8px 10px; margin: 2px 0 6px; }
    .conf-detail b { color: #c4b0f7; }
    .conf-warn { color: #d9a440; margin-top: 3px; font-size: 10.5px; }
    .manual-label { margin-top: 4px; }
    code { background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; font-size: 11px; }

    /* Keep overlays clear of the avatar's face on smaller windows. */
    @media (max-width: 900px) {
      .chat.floating { width: 42vw; max-width: 42vw; top: 66px; bottom: 96px; }
      .media-panel.floating { width: 30vw; max-width: 30vw; max-height: 44vh; }
      .bottom-cluster { width: 94vw; bottom: 12px; }
      .studio-overlay { width: 92vw; }
    }
    @media (max-width: 560px) {
      /* Side panels would crowd the face: chat becomes a short top overlay, media hidden. */
      .chat.floating { width: calc(100vw - 24px); max-width: none; left: 12px; right: 12px; top: 60px; bottom: auto; height: 30vh; }
      .media-panel.floating { display: none; }
    }
  `]
})
export class TextAvatarComponent implements AfterViewChecked, OnInit {
    public tts = inject(TtsLipsyncService);
    public stt = inject(SpeechRecognitionService);
    public llm = inject(LlmService);
    public conv = inject(ConversationService);
    public gestureRegistry = inject(CustomGestureRegistryService);
    public catalog = inject(AvatarCatalogService);
    public rag = inject(RagAvatarService);
    public assistantSvc = inject(AssistantConfigService);
    public admin = inject(AdminService);
    private store = inject(MotionStoreService);
    private player = inject(GesturePlayerService);
    private route = inject(ActivatedRoute);
    private router = inject(Router);
    private avatarMgr = inject(AvatarManagerService);
    private avatars = inject(AvatarService);
    private convContent = inject(ConversationContentService);

    // Per-assistant conversational content (chips + sync indicator)
    suggestedPrompts = signal<SuggestedPrompt[]>([]);
    lastSyncAt = signal<number>(0);
    syncState = signal<'in-sync' | 'changes'>('in-sync');
    syncing = signal<boolean>(false);

    // Full-screen detail view ("Ver mas") + PiP avatar.
    detailOpen = signal<ConvMessage | null>(null);
    // Resolved detail text shown in the overlay (fetched on demand in stage 2).
    detailText = signal<string>('');
    // True while the on-demand detail (stage 2) is being generated.
    detailLoading = signal<boolean>(false);
    // Error from the on-demand detail call (shown in the overlay).
    detailError = signal<string>('');
    // Full-screen image-only viewer (root-level overlay).
    mediaViewer = signal<{ media: MediaItem[]; index: number } | null>(null);

    /** Avatar shrinks to PiP whenever ANY full-screen overlay is open. */
    pipActive = computed(() => !!this.detailOpen() || !!this.mediaViewer());

    openMediaViewer(m: ConvMessage, index: number): void {
        if (m.media?.length) this.mediaViewer.set({ media: m.media, index });
    }
    closeMediaViewer(): void { this.mediaViewer.set(null); }

    /** Assistant messages that carry media, oldest→newest (newest rendered at the bottom). */
    mediaMessages(): ConvMessage[] {
        return this.conv.messages().filter((m) => m.role === 'assistant' && !!m.media?.length);
    }
    trackMsg = (_: number, m: ConvMessage) => m.id;

    /** Stop button: cleanly halt audio + speech animation; avatar returns to neutral pose. */
    stopSpeech(): void { this.conv.interrupt(); }

    /** Most recent replayable assistant message, if any (drives the Repeat toggle). */
    private lastReplayableMsg(): ConvMessage | null {
        const ms = this.conv.messages();
        for (let i = ms.length - 1; i >= 0; i--) {
            if (ms[i].role === 'assistant' && ms[i].replayable) return ms[i];
        }
        return null;
    }
    lastReplayable(): boolean { return !!this.lastReplayableMsg(); }

    /** Repeat button: replay the last response (voice + gestures). */
    repeatLast(): void {
        const m = this.lastReplayableMsg();
        if (m) void this.replay(m.id);
    }

    /** True when "Ver mas" should show: a detail exists OR can be fetched, and typing finished. */
    canShowDetail(m: ConvMessage): boolean {
        return (!!m.detail || !!m.detailAvailable) && !this.isRevealing(m);
    }

    /**
     * Open the detail overlay. STAGE 2: if the detail is not cached yet, fetch it
     * on demand (mode 'detail', reusing the stage-1 chunk ids) and cache it on the
     * message so a second "Ver mas" does not re-call the LLM. Setting detailOpen
     * shrinks .viewport to PiP via CSS; the avatar-tts ResizeObserver resizes the
     * existing canvas (camera aspect + renderer) -- no GLB reload.
     */
    async openDetail(m: ConvMessage): Promise<void> {
        this.detailOpen.set(m);
        this.detailError.set('');
        const cached = (m.detail ?? '').trim();
        if (cached) { this.detailText.set(cached); return; }
        if (!m.detailAvailable) { this.detailText.set(m.content); return; } // no detail to fetch
        this.detailText.set('');
        this.detailLoading.set(true);
        try {
            const q = (m.srcQuery && m.srcQuery.trim()) ? m.srcQuery : this.detailTitle();
            const resp = await this.rag.ask(q, {
                assistantId: this.assistantId,
                namespace: this.assistant()?.ragCollection,
                language: this.lang,
                voice: this.voiceId,
                mode: 'detail',
                chunkIds: m.sourceIds,
            });
            const text = (resp.detail || resp.body || '').trim();
            if (this.detailOpen()?.id !== m.id) return; // overlay changed while loading
            m.detail = text;                 // cache on the message (no re-call next time)
            this.detailText.set(text || m.content);
        } catch (e: any) {
            if (this.detailOpen()?.id !== m.id) return;
            this.detailError.set(e?.message ?? String(e));
            this.detailText.set(m.content);  // fall back to the spoken summary
        } finally {
            this.detailLoading.set(false);
        }
    }
    closeDetail(): void {
        this.detailOpen.set(null);
        this.detailText.set('');
        this.detailError.set('');
        this.detailLoading.set(false);
    }

    /** Title of the detail view = the user question that produced this answer. */
    detailTitle(): string {
        const m = this.detailOpen();
        if (!m) return '';
        const msgs = this.conv.messages();
        const idx = msgs.findIndex((x) => x.id === m.id);
        for (let i = idx - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') return msgs[i].content;
        }
        return 'Detalle';
    }

    /** Detail paragraphs from the resolved (on-demand) detail text. */
    detailParas(): string[] {
        const src = this.detailText();
        if (!src) return [];
        return src.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    }

    // avatar catalog picker state
    thumbUrls = signal<Record<string, string | null>>({});
    avatarLoadError = signal<string>('');
    /** which catalog avatar (if any) is currently loaded — keys its rig report */
    private currentLoadedAvatarId: string | null = this.catalog.selectedId();

    // RAG / informational mode state
    ragMode = false;
    ragEndpoint = getRagEndpoint();
    assistantId = getAssistantId();
    assistant = signal<AssistantConfig | null>(null);
    ragError = signal<string>('');

    @ViewChild('feedEl') feedEl?: ElementRef<HTMLDivElement>;
    @ViewChild('previewTextareaEl') previewTextareaEl?: ElementRef<HTMLTextAreaElement>;
    @ViewChild('mediaFeedEl') mediaFeedEl?: ElementRef<HTMLDivElement>;
    private stickToBottom = true;
    private lastMsgCount = 0;
    private lastMediaCount = 0;

    // manual text mode
    text = '';
    textMode = false;

    // preview editor mode (admin studio)
    studioOpen = false;     // floating Studio overlay (Response Editor + manual mode); hidden by default
    previewMode = false;
    previewText = '';
    previewGestureId = '';
    previewLeadGestureId = '';
    previewTailGestureId = '';
    previewRunning = false;

    // tts config
    provider: TtsProvider = 'piper';
    lang: TtsLang = 'es';
    voiceId = PIPER_VOICES.es[0].id;
    piperVoices = PIPER_VOICES;
    avatarUrl = localStorage.getItem('textAvatar.avatarUrl') || DEFAULT_AVATAR_URL;
    avatarUrlInput = this.avatarUrl;

    // view options
    showMarkup = false; // debug toggle: chips hidden by default, clean text only
    showProcess = true;
    settingsOpen = false;
    providerLabels = LLM_PROVIDER_LABELS;
    providerIds: LlmProviderId[] = ['ollama', 'openai', 'gemini', 'anthropic', 'deepseek'];

    // ------------------------------------------------------------ ui helpers

    /** Header title = current assistant's name; graceful fallback when none is set. */
    assistantName(): string {
        const a = this.assistant();
        return (a?.name && a.name.trim()) || a?.id || 'Avatar';
    }

    /** 1–2 letter initials chip for the header, derived from the assistant name. */
    assistantInitials(): string {
        const name = this.assistantName();
        const parts = name.trim().split(/\s+/).filter(Boolean);
        const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
        return letters.toUpperCase();
    }

    /** Back arrow -> assistants list. */
    goBack(): void { void this.router.navigate(['/assistants']); }

    /** Language change from the settings slideover (replaces the removed navbar toggle). */
    setLang(l: TtsLang): void {
        this.lang = l;
        this.onProviderOrLangChange();
    }

    /** Tooltip for the top-of-chat reload icon: last-updated, or sync/changes state. */
    syncTooltip(): string {
        if (this.syncing()) return 'Sincronizando…';
        if (this.syncState() === 'changes') return 'Hay cambios nuevos — clic para sincronizar';
        const at = this.convLastSyncLabel();
        return at ? `Contenido actualizado: ${at}` : 'Recargar contenido';
    }

    private opts() {
        return { provider: this.provider, lang: this.lang, voiceId: this.voiceId };
    }

    micPress() {
        // Sync lead/tail gestures (deployment in RAG mode, else editor dropdowns)
        this.applyTurnGestures();
        // listening -> finish turn; speaking/thinking -> interrupt + listen; idle -> listen
        this.conv.startListening(this.opts());
    }

    /** Set the lead/tail gestures for the next turn from the deployment (RAG) or editor. */
    private applyTurnGestures(): void {
        if (this.ragMode) {
            const d = this.assistant();
            this.conv.liveLeadGesture.set(d?.leadGestureId ?? '');
            this.conv.liveTailGesture.set(d?.tailGestureId ?? '');
        } else {
            this.conv.liveLeadGesture.set(this.previewLeadGestureId);
            this.conv.liveTailGesture.set(this.previewTailGestureId);
        }
    }

    micTitle(): string {
        if (!this.stt.isSupported) return 'SpeechRecognition no disponible (usa Chrome/Edge)';
        if (this.conv.muted) return 'Micrófono silenciado';
        switch (this.conv.state()) {
            case 'listening': return 'Toca para terminar tu turno';
            case 'speaking': return 'Toca para interrumpir y hablar';
            default: return 'Toca y habla';
        }
    }

    lastError(): boolean {
        const ms = this.conv.messages();
        for (let i = ms.length - 1; i >= 0; i--) {
            if (ms[i].role === 'system' && ms[i].kind === 'error') return true;
            if (ms[i].role === 'assistant') return false;
        }
        return false;
    }

    /** Is this message the one currently being performed? (incl. replays) */
    isSpokenNow(m: ConvMessage): boolean {
        return this.conv.state() === 'speaking' && this.conv.speakingMsgId() === m.id;
    }

    msgTitle(m: ConvMessage): string {
        const time = new Date(m.at).toLocaleTimeString();
        return m.meta ? `${time} — ${m.meta}` : time;
    }

    /** True while this message's text is being revealed in sync with speech. */
    isRevealing(m: ConvMessage): boolean {
        return this.conv.revealingMsgId() === m.id;
    }

    /** Cached clean-text + chip-position model per message (content is immutable). */
    private modelCache = new Map<number, { clean: string; chips: { pos: number; label: string }[] }>();

    private displayModel(m: ConvMessage) {
        let model = this.modelCache.get(m.id);
        if (!model) {
            const parsed = parseGestureMarkup(m.content, new Set(GESTURE_MAP.keys()));
            const chips = parsed.gestures.map(g => {
                let label = CHIP_LABELS[g.id] ?? g.id;
                if (g.repetitions) label += ' ×' + g.repetitions;
                if (g.speed) label += ' ' + g.speed;
                return { pos: g.charIndex, label };
            });
            model = { clean: parsed.cleanText, chips };
            this.modelCache.set(m.id, model);
            if (this.modelCache.size > 100) this.modelCache.clear(); // safety bound
        }
        return model;
    }

    /**
     * Karaoke rendering: clean text revealed up to the spoken position, chips
     * popping in when speech reaches their anchor. Never renders raw [tags].
     * Non-revealing messages (history, replays, interruptions) show full text.
     */
    revealSegments(m: ConvMessage): MsgSegment[] {
        const model = this.displayModel(m);
        const limit = this.isRevealing(m)
            ? Math.min(this.tts.revealedChars(), model.clean.length)
            : model.clean.length;
        const out: MsgSegment[] = [];
        let cursor = 0;
        for (const chip of model.chips) {
            const pos = Math.min(chip.pos, model.clean.length);
            if (pos > limit) break;
            if (pos > cursor) out.push({ kind: 'text', value: model.clean.slice(cursor, pos) });
            out.push({ kind: 'chip', value: chip.label });
            cursor = pos;
        }
        if (limit > cursor) out.push({ kind: 'text', value: model.clean.slice(cursor, limit) });
        return out;
    }

    /** Splits an assistant message into text segments + gesture chips. */
    segments(content: string): MsgSegment[] {
        const out: MsgSegment[] = [];
        const re = /\[([^\[\]]+)\]((?:\s*:\s*(?:\[[^\[\]]*\]|[\w.]+))*)/g;
        let last = 0;
        for (const m of content.matchAll(re)) {
            const idx = m.index ?? 0;
            if (idx > last) out.push({ kind: 'text', value: content.slice(last, idx) });
            last = idx + m[0].length;
            const id = m[1].trim().toLowerCase();
            const params = [...(m[2] ?? '').matchAll(/:\s*(?:\[([^\[\]]*)\]|([\w.]+))/g)].map(p => (p[1] ?? p[2] ?? '').trim());
            let label = CHIP_LABELS[id] ?? id;
            if (params[0]) label += ' ×' + params[0];
            if (params[1]) label += ' ' + params[1];
            out.push({ kind: 'chip', value: label });
        }
        if (last < content.length) out.push({ kind: 'text', value: content.slice(last) });
        return out;
    }

    // conversation text input
    convText = '';

    sendTyped() {
        const t = this.convText.trim();
        if (!t) return;
        this.convText = '';
        // Sync lead/tail gestures (deployment in RAG mode, else editor dropdowns).
        // dispatchTurn() routes to the RAG Function or the client LLM accordingly.
        this.applyTurnGestures();
        this.conv.sendText(t, this.opts());
    }

    // ------------------------------------------------------------ RAG mode

    /** Toggle informational (RAG) mode: route every turn to the Cloud Function. */
    async setRagMode(on: boolean): Promise<void> {
        this.ragMode = on;
        this.ragError.set('');
        if (on) {
            await this.reloadAssistant();
            this.conv.ragFetcher = (q: string, mode?: 'rag' | 'capabilities') =>
                this.rag.ask(q, {
                    assistantId: this.assistantId,
                    // namespace hint from the loaded assistant config; the Function
                    // prefers the assistant doc's ragCollection when it exists.
                    namespace: this.assistant()?.ragCollection,
                    language: this.lang,
                    voice: this.voiceId,
                    // 'capabilities' -> metadata-only answer (no RAG retrieval).
                    mode,
                });
            // Intent router: greetings answered instantly (no RAG); info queries
            // go to the namespace. Per-assistant lists/reply override the defaults;
            // ambiguous utterances fall back to a one-shot LLM classification.
            const a = this.assistant();
            this.conv.greetingResponse = a?.greetingResponse ?? null;
            this.conv.greetingKeywords = a?.greetingKeywords ?? undefined;
            this.conv.farewellKeywords = (a as any)?.farewellKeywords ?? undefined;
            this.conv.capabilityKeywords = (a as any)?.capabilityKeywords ?? undefined;
            this.conv.queryVerbs = a?.queryVerbs ?? undefined;
            this.conv.intentClassifier = (q: string) => this.llm.classifyIntent(q);
            // Load per-assistant conversational content (cache -> change-detect).
            await this.loadConvContent();
        } else {
            this.conv.ragFetcher = null;
            this.conv.greetingResponse = null;
            this.conv.greetings = [];
            this.conv.farewells = [];
            this.conv.infoAcks = [];
            this.conv.capabilitiesAnswer = '';
            this.conv.greetingKeywords = undefined;
            this.conv.farewellKeywords = undefined;
            this.conv.capabilityKeywords = undefined;
            this.conv.queryVerbs = undefined;
            this.conv.intentClassifier = null;
            this.suggestedPrompts.set([]);
        }
    }

    /**
     * Load this assistant's conversational content via the read-through cache and
     * feed the greeting/farewell/info-ack arrays to the conversation service.
     * Also runs a cheap change check to surface the "changes to sync" indicator.
     */
    private async loadConvContent(): Promise<void> {
        const id = this.assistantId;
        if (!id) return;
        try {
            const env = await this.convContent.getContent(id);
            this.applyConvContent(env.content);
            this.lastSyncAt.set(env.lastSyncAt);
            // Cheap single-doc check: are there unsynced server changes?
            const state = await this.convContent.checkForUpdates(id);
            this.syncState.set(state === 'changes' ? 'changes' : 'in-sync');
        } catch (e: any) {
            console.warn('[text-avatar] conv content load failed:', e?.message ?? e);
        }
    }

    private applyConvContent(c: AssistantConvContent): void {
        this.conv.greetings = c.greetings.map((g) => g.text);
        this.conv.farewells = c.farewells.map((f) => f.text);
        this.conv.infoAcks = c.infoAcknowledgements.map((i) => i.text);
        // Resolved (custom-or-global) pre-written capabilities answer. Empty -> the
        // capabilities intent falls back to chatRag capabilities mode (metadata-only).
        this.conv.capabilitiesAnswer = (c.capabilities?.answer ?? '').trim();
        this.suggestedPrompts.set(c.suggestedPrompts);
    }

    /** Manual sync: force a full re-fetch, overwrite cache, clear the indicator. */
    async syncConvContent(): Promise<void> {
        const id = this.assistantId;
        if (!id || this.syncing()) return;
        this.syncing.set(true);
        try {
            const env = await this.convContent.sync(id);
            this.applyConvContent(env.content);
            this.lastSyncAt.set(env.lastSyncAt);
            this.syncState.set('in-sync');
        } catch (e: any) {
            console.warn('[text-avatar] sync failed:', e?.message ?? e);
        } finally {
            this.syncing.set(false);
        }
    }

    /** Chip tap -> send the prompt straight to the info-query / RAG path. */
    sendChip(p: SuggestedPrompt): void {
        if (!p?.prompt) return;
        this.conv.sendSuggestedPrompt(p.prompt, this.opts());
    }

    convLastSyncLabel(): string {
        const ms = this.lastSyncAt();
        return ms ? new Date(ms).toLocaleString() : '';
    }

    onRagEndpointChange(v: string): void { this.ragEndpoint = v; setRagEndpoint(v); }
    onAssistantIdChange(v: string): void { this.assistantId = v; setAssistantId(v); }

    /** Load the deployment config and apply its avatar/voice/language. */
    async reloadAssistant(): Promise<void> {
        const d = await this.assistantSvc.load(this.assistantId);
        this.assistant.set(d);
        if (!d) return;
        if (d.language === 'es' || d.language === 'en') { this.lang = d.language; this.onProviderOrLangChange(); }
        if (d.voice) this.applyDefaultVoice(d.voice);
        if (d.avatarId) await this.selectAvatar(d.avatarId);
    }

    onConvEnter(event: Event) {
        const e = event as KeyboardEvent;
        if (e.shiftKey) return; // Shift+Enter = newline
        e.preventDefault();
        this.sendTyped();
    }

    async replay(msgId: number): Promise<void> {
        const msg = this.conv.messages().find(m => m.id === msgId);
        if (!msg) return;
        // If the message has stored lead/tail gestures, orchestrate the full sequence
        if (msg.leadGesture || msg.tailGesture) {
            if (this.previewBusy()) return;
            this.previewRunning = true;
            try {
                if (msg.leadGesture) await this.playGestureBlock(msg.leadGesture);
                await this.conv.replayMessage(msgId, this.opts());
                if (msg.tailGesture) await this.playGestureBlock(msg.tailGesture);
            } finally {
                this.previewRunning = false;
            }
        } else {
            void this.conv.replayMessage(msgId, this.opts());
        }
    }

    toggleLang() {
        this.lang = this.lang === 'es' ? 'en' : 'es';
        this.onProviderOrLangChange();
    }

    toggleMute() {
        this.conv.muted = !this.conv.muted;
        if (this.conv.muted && this.conv.state() === 'listening') this.conv.interrupt();
    }

    // ------------------------------------------------------- feed autoscroll

    onFeedScroll() {
        const el = this.feedEl?.nativeElement;
        if (!el) return;
        this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    }

    ngAfterViewChecked() {
        const el = this.feedEl?.nativeElement;
        if (el) {
            const count = this.conv.messages().length + (this.conv.streaming() ? 1 : 0) + (this.stt.interim() ? 1 : 0);
            if (count !== this.lastMsgCount && this.stickToBottom) {
                el.scrollTop = el.scrollHeight;
            }
            this.lastMsgCount = count;
        }
        // Media history: auto-scroll to the newest carousel when new media arrives.
        const mEl = this.mediaFeedEl?.nativeElement;
        const mCount = this.mediaMessages().length;
        if (mEl && mCount !== this.lastMediaCount) {
            mEl.scrollTop = mEl.scrollHeight;
        }
        this.lastMediaCount = mCount;
    }

    // ------------------------------------------------------------ manual mode

    loadAvatar() {
        const url = this.avatarUrlInput.trim();
        if (!url) return;
        // Manual load → leave the catalog (dev/fallback path).
        this.catalog.select(null);
        this.currentLoadedAvatarId = null;
        this.avatarLoadError.set('');
        this.avatarUrl = url;
        localStorage.setItem('textAvatar.avatarUrl', url);
    }

    // --------------------------------------------------------- avatar catalog

    async ngOnInit(): Promise<void> {
        // Resolve admin status for UI gating (gear + Response Editor). UX only —
        // real enforcement is server-side in rules/callables.
        void this.admin.check();
        // Resolve preview thumbnails (best-effort; missing → person-icon fallback).
        for (const a of this.catalog.catalog()) {
            this.catalog.resolveThumbnailUrl(a)
                .then(url => this.thumbUrls.update(m => ({ ...m, [a.id]: url })))
                .catch(() => {});
        }
        // Restore a previously selected catalog avatar (hot-loads its GLB).
        const sel = this.catalog.selected();
        if (sel) await this.selectAvatar(sel.id);

        // If launched from the /assistants selector (?assistant=ID), load that
        // assistant fully configured and turn RAG mode on. Falls back silently if
        // absent so direct /text-avatar access keeps working.
        const dep = this.route.snapshot.queryParamMap.get('assistant');
        if (dep) {
            this.assistantId = dep;
            setAssistantId(dep);
            await this.setRagMode(true); // loads deployment (avatar/voice/lang/lead-tail) + wires RAG fetcher
        }
    }

    /**
     * Resolve + load an avatar GLB. Resolution order:
     *   1) avatars/{id} Firestore doc (Avatar Manager source of truth) -> glbPath
     *   2) static avatar catalog entry (legacy avatars/models/{id}.glb)
     * Surfaces a clear error + logs the attempted Storage path on a missing file
     * (instead of a silent 404). This fixes assistant.avatarId references whose
     * catalog path doesn't match the real file.
     */
    async selectAvatar(id: string): Promise<void> {
        this.catalog.select(id);
        this.avatarLoadError.set('');
        let url: string | null = null;
        let voice: string | undefined;
        let attempted = '';

        // 1) Central AvatarService (avatars collection + global cache: mem -> IndexedDB -> Storage).
        try {
            const av = await this.avatars.getAvatar(id);
            if (av?.glbPath) {
                attempted = av.glbPath;
                url = await this.avatars.resolveModelUrl(id); // cached blob URL (no re-download)
                voice = av.defaultVoice;
            }
        } catch { /* fall through to catalog */ }

        // 2) Static catalog fallback.
        if (!url) {
            const entry = getCatalogEntry(id);
            if (entry) {
                attempted = attempted || entry.storagePath;
                try {
                    url = await this.catalog.resolveGlbUrl(entry);
                    voice = voice ?? entry.defaultVoice;
                } catch { url = null; }
            }
        }

        if (!url) {
            const msg = `Avatar "${id}" GLB not found (tried: ${attempted || 'no path'}). ` +
                `Check avatars/${id}.glbPath points to an existing file under avatars/models/.`;
            console.error('[text-avatar] ' + msg);
            this.avatarLoadError.set(msg);
            return;
        }

        this.currentLoadedAvatarId = id;
        this.avatarUrl = url;            // [avatarUrl] change -> avatar-tts hot-reloads
        this.avatarUrlInput = url;
        // Don't persist blob: URLs (they don't survive a reload); persist only
        // real URLs. Cold loads re-resolve via the assistant's avatarId anyway.
        if (!url.startsWith('blob:')) localStorage.setItem('textAvatar.avatarUrl', url);
        if (voice) this.applyDefaultVoice(voice);
    }

    /** Preselect the avatar's default voice if it exists in the current voice list. */
    private applyDefaultVoice(voiceId: string): void {
        for (const l of ['es', 'en'] as TtsLang[]) {
            if (PIPER_VOICES[l].some(v => v.id === voiceId)) {
                this.lang = l;
                this.voiceId = voiceId;
                this.onProviderOrLangChange();
                return;
            }
        }
    }

    /** Store the rig conformance report for whichever avatar just loaded. */
    onRigReport(r: RigReport): void {
        if (this.currentLoadedAvatarId) this.catalog.setReport(this.currentLoadedAvatarId, r);
    }

    /** Resolved thumbnail URL or '' (falsy → picker shows the person-icon placeholder). */
    thumbUrl(id: string): string { return this.thumbUrls()[id] ?? ''; }
    confOf(id: string): Conformance | undefined { return this.catalog.conformanceOf(id); }
    confLabel(c: Conformance): string { return conformanceLabel(c); }
    confDot(c: Conformance): string {
        return c === 'full' ? '● full' : c === 'remapped' ? '● remap' : c === 'partial' ? '● partial' : '● n/a';
    }
    selectedReport(): RigReport | undefined {
        const id = this.catalog.selectedId();
        return id ? this.catalog.getReport(id) : undefined;
    }
    avatarCardTitle(id: string): string {
        const c = this.confOf(id);
        return c ? `${getCatalogEntry(id)?.name} — ${conformanceLabel(c)}` : (getCatalogEntry(id)?.name ?? id);
    }

    onEnter(event: Event) {
        const e = event as KeyboardEvent;
        if (e.shiftKey) return;
        e.preventDefault();
        this.speakManual();
    }

    onProviderOrLangChange() {
        const list = PIPER_VOICES[this.lang];
        if (!list.some(v => v.id === this.voiceId)) this.voiceId = list[0].id;
    }

    speakManual() {
        const t = this.text.trim();
        if (!t) return;
        this.conv.sayManual(t, this.opts());
    }

    fillDemo() {
        this.text = this.lang === 'es'
            ? 'Bueno, déjame pensar... [sigh] esto es difícil, pero [laugh] jaja está bien. Claro que sí [yes]:[3]:[slow] aunque pensándolo [no]:[2]:[fast] mejor hagámoslo...'
            : 'Okay, let me think... [sigh] this is difficult, but [laugh] haha it is fine. Of course yes [yes]:[3]:[slow] though on second thought [no]:[2]:[fast] let us just do it...';
    }

    // ------------------------------------------------------------ preview editor

    /** Gesture list for the dropdown: built-in gestures (all minus custom). */
    builtInGestures(): GestureDef[] {
        const all = this.gestureRegistry.allGestures();
        const customIds = new Set(this.gestureRegistry.customGestures().map(g => g.id));
        return all.filter(g => !customIds.has(g.id));
    }

    /** True when preview is actively running (lead-in, text, or tail phase). */
    previewBusy(): boolean {
        return this.previewRunning || this.conv.state() === 'speaking' || this.conv.state() === 'sending' || this.conv.state() === 'waiting_llm';
    }

    /** Insert a [gestureId] token at the current cursor position in the preview textarea. */
    insertGesture(): void {
        if (!this.previewGestureId) return;
        const el = this.previewTextareaEl?.nativeElement;
        const token = `[${this.previewGestureId}]`;
        if (!el) {
            this.previewText += token;
            return;
        }
        const start = el.selectionStart ?? this.previewText.length;
        const end = el.selectionEnd ?? start;
        this.previewText = this.previewText.slice(0, start) + token + this.previewText.slice(end);
        requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = start + token.length;
            el.focus();
        });
    }

    /**
     * Play a standalone gesture block (lead-in or tail):
     *   - If the gesture has pre-recorded TTS audio → play voice + lipsync + body motion together
     *   - Otherwise → trigger body motion and wait for its natural duration
     * Returns a Promise that resolves when the block is fully complete.
     */
    async playGestureBlock(gestureId: string): Promise<void> {
        const def = GESTURE_MAP.get(gestureId);
        if (!def) { console.warn(`[preview] unknown gesture id "${gestureId}"`); return; }

        // Look up whether this gesture has saved voice audio
        const rec = this.store.recordings().find(r => r.compiledGesture?.id === gestureId);
        if (rec?.voiceAttachment?.lipsyncFrames?.length) {
            const entry = await this.store.loadAudio(rec.id);
            if (entry?.ttsAudioData) {
                // IMPORTANT ordering: playVisemeTrack is async and calls stopInternal()
                // synchronously as its very first line (before any internal await). If we
                // called player.trigger() BEFORE playVisemeTrack, stopInternal would clear
                // the gesture we just triggered. Instead:
                //   1. Capture the Promise from playVisemeTrack (stopInternal runs now, sync)
                //   2. Immediately trigger body motion (after stopInternal, before audio starts)
                //   3. Await the Promise so the caller waits for audio to finish
                const audioEnd = this.tts.playVisemeTrack(entry.ttsAudioData, rec.voiceAttachment.lipsyncFrames);
                this.player.trigger(gestureId, def.defaultRepetitions, def.defaultSpeed, true);
                await audioEnd;
                return;
            }
        }

        // No voice: trigger body motion and wait for the gesture's natural duration
        const speedMultiplier = typeof def.defaultSpeed === 'number'
            ? def.defaultSpeed
            : SPEED_MULTIPLIERS[def.defaultSpeed ?? 'normal'] ?? 1.0;
        const cycleSec = def.cycleDurationSec ?? 1.0;
        const reps = def.defaultRepetitions ?? 1;
        const totalMs = (cycleSec * reps / speedMultiplier) * 1000 + (def.returnDuration ?? 0.3) * 1000;

        this.player.trigger(gestureId, def.defaultRepetitions, def.defaultSpeed, def.allowMouth === true);
        await new Promise<void>(resolve => setTimeout(resolve, totalMs));
    }

    /**
     * Run the full preview sequence: Lead-in → Main text → Tail.
     * Each block is awaited before the next starts, so there are no gaps or overlaps.
     */
    async generatePreview(): Promise<void> {
        const text = this.previewText.trim();
        if (!text && !this.previewLeadGestureId && !this.previewTailGestureId) return;
        if (this.previewBusy()) return;

        this.previewRunning = true;
        try {
            // 1. Lead-in gesture block (plays with its pre-recorded voice if any)
            if (this.previewLeadGestureId) {
                await this.playGestureBlock(this.previewLeadGestureId);
            }

            // 2. Main response text (TTS + inline gesture body motion)
            // Pass lead/tail IDs so they're persisted in the message for replay
            if (text) {
                await this.conv.sayManual(text, this.opts(),
                    this.previewLeadGestureId || undefined,
                    this.previewTailGestureId || undefined);
            }

            // 3. Tail gesture block
            if (this.previewTailGestureId) {
                await this.playGestureBlock(this.previewTailGestureId);
            }
        } finally {
            this.previewRunning = false;
        }
    }

    /** Interrupt any running preview (lead-in, text, or tail). */
    stopPreview(): void {
        this.previewRunning = false;
        this.conv.interrupt();
        this.player.clear();
    }

    fillPreviewDemo(): void {
        this.previewText = this.lang === 'es'
            ? '¡Hola! [yes] Me alegra verte. [sigh] Ha sido un día largo, pero [laugh] ¡qué bueno que estás aquí! Cuéntame [thinking]:[2] ¿en qué puedo ayudarte?'
            : 'Hello! [yes] Great to see you. [sigh] It has been a long day, but [laugh] I am glad you are here! Tell me [thinking]:[2] how can I help you?';
    }

    /**
     * Canonical serialized form of the current sequence: lead-in + body + tail.
     * Shows the exact string the LLM should output to reproduce this performance.
     * Format: [lead:id]\n{body text}\n[tail:id]
     */
    get llmCommand(): string {
        const parts: string[] = [];
        if (this.previewLeadGestureId) parts.push(`[lead:${this.previewLeadGestureId}]`);
        const body = this.previewText.trim();
        if (body) parts.push(body);
        if (this.previewTailGestureId) parts.push(`[tail:${this.previewTailGestureId}]`);
        return parts.join('\n');
    }

    copyCommand(): void {
        const cmd = this.llmCommand;
        if (!cmd) return;
        navigator.clipboard.writeText(cmd).catch(() => {});
    }

    // ------------------------------------------------------------ settings

    get activeCfg() {
        const s = this.llm.settings();
        return s.providers[s.provider];
    }

    setLlmProvider(p: LlmProviderId) {
        this.llm.settings.update(s => ({ ...s, provider: p }));
        this.llm.save();
    }

    setCfg(field: 'model' | 'baseUrl' | 'apiKey', value: string) {
        this.llm.settings.update(s => {
            const next = { ...s, providers: { ...s.providers } };
            next.providers[s.provider] = { ...next.providers[s.provider], [field]: value };
            return next;
        });
        this.llm.save();
    }

    setSystemPrompt(v: string) {
        this.llm.settings.update(s => ({ ...s, systemPrompt: v }));
        this.llm.save();
    }

    setMaxTurns(v: number) {
        const n = Math.max(1, Math.min(50, Math.floor(+v || 8)));
        this.llm.settings.update(s => ({ ...s, maxTurns: n }));
        this.llm.save();
    }

    setMaxReplyTokens(v: number) {
        const n = Math.max(50, Math.min(2000, Math.floor(+v || 220)));
        this.llm.settings.update(s => ({ ...s, maxReplyTokens: n }));
        this.llm.save();
    }
}
