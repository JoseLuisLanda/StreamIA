import { Component, ElementRef, ViewChild, AfterViewChecked, OnInit, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AdminService } from '../../services/admin.service';
import { AvatarManagerService } from '../../services/avatar-manager.service';
import { AvatarService } from '../../services/avatar.service';
import { AvatarTtsComponent, DEFAULT_AVATAR_URL } from '../../components/avatar-tts/avatar-tts.component';
import { AvatarCatalogService } from '../../services/avatar-catalog.service';
import { getCatalogEntry } from '../../lib/avatars/avatar-catalog';
import { Avatar } from '../../lib/avatars/avatar.models';
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
import { GESTURES_LEADIN_ENABLED, GESTURES_TAIL_ENABLED } from '../../lib/config/feature-flags';
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
            <span class="status-line"><i class="dot-online"></i> {{ activeAvatarName() }}</span>
          </div>
        </div>
        <div class="topctl">
          <!-- Chat popup toggle (everyone). The written conversation lives in an on-demand
               popup so the avatar + voice stay the primary focus. -->
          <button #chatIconBtn class="iconbtn" (click)="toggleChat()" [class.active]="chatOpen()"
                  [class.unread]="chatUnread() > 0"
                  title="Conversacion" aria-label="Conversacion">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-5.1A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/>
            </svg>
            <span class="badge" *ngIf="chatUnread() > 0">{{ chatBadge() }}</span>
          </button>
          <!-- Media popup toggle (everyone). Amber-green when unseen media has arrived;
               returns to neutral white once opened (mediaSeen). Hidden until any media exists. -->
          <button class="iconbtn" *ngIf="mediaMessages().length" (click)="toggleMedia()"
                  [class.active]="mediaOpen()" [class.hasnew]="mediaHasNew()"
                  title="Contenido relacionado" aria-label="Contenido relacionado">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2"/>
              <circle cx="8.5" cy="10" r="1.6"/>
              <path d="M21 16l-5-5L5 19"/>
            </svg>
            <span class="badge media" *ngIf="mediaUnread() > 0">{{ mediaBadge() }}</span>
          </button>
          <!-- Settings gear (admin-only). The theater-masks Studio toggle was removed. -->
          <button class="iconbtn" *ngIf="admin.isAdmin()" (click)="settingsOpen.set(!settingsOpen())" title="Ajustes">⚙️</button>
        </div>
      </header>

      <!-- ===================== STATUS BAND (between top bar and avatar) ===================== -->
      <div class="statusband">
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
          <ng-container *ngSwitchDefault>
            <svg class="warn-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.3 3.86 1.82 18.5A1.5 1.5 0 0 0 3.12 21h17.76a1.5 1.5 0 0 0 1.3-2.5L13.7 3.86a1.5 1.5 0 0 0-2.6 0z"/>
              <path d="M12 9v4"/><path d="M12 17h.01"/>
            </svg>
            Presiona el microfono para hablar
          </ng-container>
        </div>
      </div>

      <!-- ===================== BASE LAYER: full-screen avatar ===================== -->
      <!-- Canvas is resized via avatar-tts' ResizeObserver (camera aspect + renderer),
           never recreated — the cached GLB, WebGL context, and avatar state persist. -->
      <div class="viewport" [class.pip]="pipActive()">
        <div class="glow"></div>
        <app-avatar-tts [avatarUrl]="avatarUrl()" [compact]="pipActive()" (rigReport)="onRigReport($event)"></app-avatar-tts>
        <button class="pip-x" *ngIf="pipActive()" (click)="closeDetail(); closeMediaViewer()" title="Expandir avatar">⤢</button>

        <!-- suggested-prompt carousel pinned to the avatar's bottom edge; auto-advances
             through the FULL per-assistant prompt set (PROMPT_CAROUSEL_INTERVAL_MS).
             Hover/touch pauses rotation. Tapping a chip still sends that prompt.
             Dimmed (faded out) while subtitles are showing; fades back when idle. -->
        <div class="prompt-carousel" *ngIf="ragMode && suggestedPrompts().length"
             [class.dim]="subStage() !== 'hidden'"
             (pointerenter)="pauseCarousel()" (pointerleave)="resumeCarousel()">
          <button class="chip" *ngFor="let p of carouselPrompts(); trackBy: trackPrompt"
                  (click)="sendChip(p)"
                  [disabled]="conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                  [title]="p.prompt">{{ p.label }}</button>
        </div>

        <!-- LIVE SUBTITLE (rolling caption): progressively revealed in sync with the voice
             (reuses the SAME tts.revealedChars() timing as the chat karaoke). The inner
             .subtitle-roll is a fixed-height clipped window (1 line desktop / 2 lines
             portrait) auto-scrolled to the bottom so the NEWEST words stay visible and older
             text rolls off the top. On natural finish the whole bar "flies" to the chat icon. -->
        <div class="subtitle" *ngIf="subStage() !== 'hidden'" #subtitleBar
             [class.flying]="subStage() === 'flying'"
             [style.transform]="subStage() === 'flying' ? flyTransform() : null">
          <div class="subtitle-roll" #subtitleRoll [style.height.em]="subtitleHeightEm()">{{ subtitleText() }}</div>
        </div>
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

      <!-- ===================== ON-DEMAND CHAT POPUP (glass overlay, auto-fades when idle) =====================
           Opened from the top-bar chat button. Holds BOTH the conversation history AND the message input.
           Any interaction (focus/keystroke/pointer/wheel) resets the idle fade timer; when idle it fades
           out and closes. Spoken responses never auto-open it; history accumulates in the background. -->
      <aside class="chat popup" *ngIf="chatOpen()" [class.faded]="!chatActive()"
             (focusin)="chatActivity()" (keydown)="chatActivity()"
             (pointerdown)="chatActivity()" (wheel)="chatActivity()">
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
              <div class="sysline" *ngIf="m.role === 'system' && m.kind === 'error'"
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

          <!-- message input (moved here from the bottom area; chat is now audio-first) -->
          <div class="chat-input">
            <textarea rows="1" [(ngModel)]="convText" maxlength="1000"
                      (keydown.enter)="onConvEnter($event)"
                      [disabled]="conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                      [placeholder]="'Envía un mensaje a ' + assistantName() + '…'"></textarea>
            <button class="send" (click)="sendTyped()"
                    [disabled]="!convText.trim() || conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                    title="Enviar (Enter)">➤</button>
          </div>

      </aside>

      <!-- ===================== "CONTENIDO RELACIONADO" MEDIA POPUP (top-bar icon) =====================
           On-demand overlay (NOT inline) so it never pushes the audio controls down / creates overflow.
           Scrollable media history: newest carousel shown by default (auto-scrolled to bottom),
           scroll up to revisit earlier responses' media. -->
      <aside class="media-panel popup" *ngIf="mediaOpen() && mediaMessages().length">
        <div class="media-head">
          <h2>Contenido relacionado</h2>
          <button class="iconbtn-sm" (click)="closeMedia()" title="Cerrar">✕</button>
        </div>
        <div class="media-feed" #mediaFeedEl>
          <div class="media-entry" *ngFor="let m of mediaMessages(); trackBy: trackMsg">
            <!-- Originating user question for this media group (from m.srcQuery). Falls back
                 to a neutral label for legacy entries with no stored query. -->
            <div class="media-q" [title]="m.srcQuery || 'Contenido relacionado'">
              <span class="media-q-kicker">Relacionado con:</span>
              <span class="media-q-text">{{ m.srcQuery || 'tu consulta' }}</span>
            </div>
            <app-media-gallery [media]="m.media!" mode="preview"
                               (openViewer)="openMediaViewer(m, $event)"></app-media-gallery>
          </div>
        </div>
      </aside>

      <!-- ===================== AUDIO CONTROLS (raised, just above the static footer) ===================== -->
      <div class="bottom-cluster">
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
        <!-- NOTE: status pill moved ABOVE the avatar; prompt chips moved to the avatar's
             bottom edge as a carousel; message input lives in the chat popup. -->
      </div>

      <!-- ===================== THIN STATIC FOOTER (always visible, not scrollable) ===================== -->
      <footer class="appfooter">Publicar3D</footer>

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
      <div class="backdrop" *ngIf="settingsOpen()" (click)="settingsOpen.set(false)"></div>
      <div class="slideover" [class.open]="settingsOpen()">
        <div class="so-head">
          <h2>Ajustes</h2>
          <button class="do-x" (click)="settingsOpen.set(false)" title="Cerrar" aria-label="Cerrar">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        </div>

        <!-- ONLY setting: load another avatar, listed from the avatars/{id} DB collection.
             Selecting a card loads its GLB AND closes the panel (pickAvatar). -->
        <h4>Avatar</h4>
        <p class="note" *ngIf="!dbAvatars().length && !avatarLoadError()">Cargando avatares...</p>
        <div class="avatar-grid">
          <div *ngFor="let a of dbAvatars()"
               class="avatar-card" [class.selected]="catalog.selectedId() === a.id"
               (click)="pickAvatar(a.id)" [title]="a.name">
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
      /* Detail-overlay PiP avatar box = base x scale. The box is taller than the visible
         area on purpose: it is sunk below the bottom edge (--detail-pip-sink) so only the
         chest-up shows, and wide enough that the shoulders are NOT sliced by the side edges.
         Knobs: --detail-pip-scale (overall size), base-w (shoulder room), base-h (how much
         body), --detail-pip-sink (how far it sinks below the bottom). */
      --detail-pip-scale: 0.5;
      --detail-pip-base-w: 200px;   /* x0.5 -> 100px wide: room for full shoulders */
      --detail-pip-base-h: 280px;   /* x0.5 -> 140px tall: head..torso, lower half sunk */
      --detail-pip-sink: 48%;       /* portion of the box hidden below the bottom edge (clips the waist; head has headroom so it never clips at the top) */
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
      position: relative; /* anchors the unread count badge */
      width: 36px; height: 36px; border-radius: 50%; border: 1px solid rgba(255,255,255,.14);
      background: rgba(20,18,30,.45); backdrop-filter: blur(8px); color: #E8E9EE; cursor: pointer; font-size: 15px;
      display: grid; place-items: center; transition: background .15s;
    }
    .iconbtn:hover:not(:disabled) { background: rgba(40,36,60,.65); }
    .iconbtn:disabled { opacity: .35; cursor: default; }
    .iconbtn.active { background: rgba(139,92,246,.35); border-color: rgba(139,92,246,.6); color: #fff; }
    /* Unread chat indicator: accent (violet) icon until the chat popup is opened. */
    .iconbtn.unread { color: #c4b0f7; border-color: rgba(139,92,246,.6); box-shadow: 0 0 10px rgba(139,92,246,.35); }
    /* New-media indicator: amber-green icon until the media popup is opened. */
    .iconbtn.hasnew { color: #b6e84a; border-color: rgba(182,232,74,.6); box-shadow: 0 0 10px rgba(182,232,74,.35); }
    .iconbtn svg { display: block; }
    /* WhatsApp-style unread count bubble, top-right of the icon. */
    .iconbtn .badge {
      position: absolute; top: -3px; right: -3px;
      min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
      display: grid; place-items: center; font-size: 10px; font-weight: 700; line-height: 1;
      background: var(--accent); color: #fff; border: 1.5px solid #0E0F13;
      font-family: 'JetBrains Mono', ui-monospace, monospace; pointer-events: none;
    }
    .iconbtn .badge.media { background: #b6e84a; color: #15230a; }
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
    /* Picture-in-picture (detail "Ver mas" overlay): pinned bottom-right corner.
       Card-less + TRANSPARENT -- only the avatar silhouette floats over the detail
       text. The canvas is already alpha (renderer alpha:true, scene.background unset,
       .canvas-container forced transparent above); here we strip the .viewport CSS
       chrome (gradient fill, rounded card, shadow) and the glow. This is scoped to the
       .pip class only, so the MAIN full-screen .viewport keeps its dark/violet gradient.
       The avatar-tts ResizeObserver resizes the existing canvas -- no GLB reload. */
    .viewport.pip {
      position: fixed; right: 8px; bottom: 0; left: auto; top: auto;
      width: calc(var(--detail-pip-base-w) * var(--detail-pip-scale));
      height: calc(var(--detail-pip-base-h) * var(--detail-pip-scale));
      /* Sink the lower part below the viewport bottom edge: only chest-up shows, as if
         the avatar is emerging from the bottom. The browser clips what is off-screen
         (bottom only); the sides stay on-screen so the shoulders are NOT sliced. */
      transform: translateY(var(--detail-pip-sink));
      flex: none; z-index: 70;
      background: transparent; /* override the base .viewport gradient -> no card box */
      border-radius: 0; box-shadow: none;
      overflow: visible;       /* the box never clips the avatar horizontally */
      transition: width .25s ease, height .25s ease;
    }
    /* Responsive detail PiP size: portrait keeps the small 0.5 scale (100x140); landscape/
       desktop (>=1024px, same app breakpoint) triples it to 1.5 (300x420) since there is
       room. Only the var changes -> the box (and the canvas via ResizeObserver) resizes;
       camera framing (FRAMING_COMPACT, chest-up) and the canvas itself are untouched. The
       width/height CSS transition keeps the resize smooth; it also re-evaluates on
       orientation/size change. */
    @media (min-width: 1024px) { .app { --detail-pip-scale: 1.5; } }
    /* No background glow halo behind the floating PiP avatar. */
    .viewport.pip .glow { display: none; }
    /* The prompt carousel is hidden while the avatar is a small PiP (no room, and it
       must not clutter the detail overlay). */
    .viewport.pip .prompt-carousel { display: none; }
    .viewport.pip .subtitle { display: none; }
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

    /* Slim audio strip: compact row; mic is a rounded-rectangle pill so it fits the
       thin band; side buttons shrink to match the slim height (< half the old size). */
    .microw { display: flex; align-items: center; justify-content: center; gap: 12px; flex: none; }
    .micbtn {
      position: relative; width: 128px; height: 40px; border-radius: 999px;
      border: 2px solid rgba(139,92,246,.55); background: transparent; color: #fff;
      font-size: 19px; cursor: pointer; display: grid; place-items: center;
      transition: background .2s, border-color .2s, transform .1s;
    }
    .micbtn:hover:not(:disabled) { background: var(--accent-soft); transform: scale(1.03); }
    .micbtn:disabled { opacity: .35; cursor: default; }
    .micbtn.listening { background: var(--accent); border-color: var(--accent); box-shadow: 0 0 22px rgba(139,92,246,.6); }
    .rings { position: absolute; inset: -2px; border-radius: 999px; border: 2px solid var(--accent); animation: ring 1.4s ease-out infinite; pointer-events: none; }
    @keyframes ring { 0% { transform: scale(1); opacity: .8; } 100% { transform: scale(1.55); opacity: 0; } }
    .spinner { position: absolute; inset: -2px; border-radius: 999px; pointer-events: none; border: 2px solid transparent; border-top-color: var(--accent); animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ctl {
      width: 38px; height: 38px; border-radius: 50%; border: 1px solid rgba(255,255,255,.16);
      background: rgba(20,18,30,.5); backdrop-filter: blur(8px); color: #e6e6ee; font-size: 15px; cursor: pointer;
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

    /* On-demand chat POPUP: glass overlay docked to the right; leaves the avatar
       visible. Opens from the top-bar button; auto-fades to opacity 0 when idle
       (then *ngIf removes it). pointer-events drop while faded so it can't block. */
    .chat.popup {
      position: fixed; top: 70px; right: 16px; bottom: 92px; z-index: 40;
      width: 360px; max-width: 40vw;
      display: flex; flex-direction: column; overflow: hidden;
      background: rgba(14,13,22,.6); backdrop-filter: blur(18px);
      border: 1px solid rgba(255,255,255,.14); border-radius: 18px;
      box-shadow: 0 16px 48px rgba(0,0,0,.55);
      opacity: 1; transition: opacity .9s ease; /* fade duration -> CHAT_FADE_ANIM_MS */
      animation: chatpop .22s ease both;
    }
    .chat.popup.faded { opacity: 0; pointer-events: none; }
    @keyframes chatpop { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
    /* Input as a footer bar inside the popup (it used to be a floating pill at the bottom). */
    .chat.popup .chat-input {
      flex: none; margin: 0; border-radius: 0; border: none;
      border-top: 1px solid rgba(255,255,255,.1);
      background: rgba(10,9,16,.5); box-shadow: none; padding: 8px 8px 8px 14px;
    }
    /* On-demand media POPUP: left-docked glass overlay (chat is on the right), so it
       never renders inline / never pushes the audio controls down. Opened from the
       top-bar media button. */
    .media-panel.popup {
      position: fixed; top: 70px; left: 16px; bottom: 92px; z-index: 40;
      width: 300px; max-width: 40vw;
      display: flex; flex-direction: column; overflow: hidden;
      background: rgba(14,13,22,.6); backdrop-filter: blur(18px);
      border: 1px solid rgba(255,255,255,.14); border-radius: 18px;
      box-shadow: 0 16px 48px rgba(0,0,0,.55);
      animation: chatpop .22s ease both;
    }
    .media-head { display: flex; align-items: center; justify-content: space-between;
      padding: 10px 13px; border-bottom: 1px solid rgba(255,255,255,.08); flex: none; }
    .media-head h2 { margin: 0; font-size: 12.5px; font-weight: 600; color: #eceaf6; text-shadow: 0 1px 4px rgba(0,0,0,.6); }
    .media-feed { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
    .media-entry { flex: none; }
    /* Originating-question caption above each media group. Compact, dark/violet, single-line
       with ellipsis (full text on hover via title). */
    .media-q { margin: 0 2px 4px; display: flex; flex-direction: column; gap: 1px; }
    .media-q-kicker { font-size: 9.5px; letter-spacing: .5px; text-transform: uppercase; color: #8b85a6; }
    .media-q-text {
      font-size: 12px; font-weight: 600; color: #d6c9fb; line-height: 1.25;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }
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
    /* Slim audio-control strip (responsive rules place it just above the footer). */
    .bottom-cluster {
      position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 15;
      width: min(680px, 92vw); display: flex; flex-direction: column; align-items: center; gap: 4px;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
    .chip { background: rgba(20,18,30,.5); backdrop-filter: blur(8px); border: 1px solid rgba(160,120,255,.4); color: #d6c9fb;
      border-radius: 999px; padding: 6px 14px; font-size: 12px; cursor: pointer; white-space: nowrap;
      text-shadow: 0 1px 3px rgba(0,0,0,.5); font-family: 'JetBrains Mono', ui-monospace, monospace; }
    .chip:hover:not(:disabled) { background: rgba(139,92,246,.4); }
    .chip:disabled { opacity: .45; cursor: default; }

    /* Status pill: absolute overlay pinned just under the header so it does NOT consume
       a layout row -- this frees the avatar to expand upward. --status-top is tuned per
       breakpoint (header height differs desktop vs portrait). */
    .statusband {
      position: absolute; top: var(--status-top, 50px); left: 0; right: 0; z-index: 18;
      display: flex; justify-content: center; align-items: center; padding: 0 12px;
      pointer-events: none;
    }
    .statusband .statuspill { pointer-events: auto; }

    /* Prompt-chip carousel pinned to the avatar's bottom edge (auto-rotating window). */
    .prompt-carousel {
      position: absolute; left: 0; right: 0; bottom: 8px; z-index: 12;
      display: flex; gap: 8px; justify-content: center; align-items: center;
      flex-wrap: nowrap; overflow: hidden; padding: 0 12px;
    }
    .prompt-carousel .chip { animation: chipfade .4s ease both; }
    @keyframes chipfade { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
    /* Carousel fades out while subtitles show, fades back in when idle (220ms). */
    .prompt-carousel { transition: opacity .22s ease; }
    .prompt-carousel.dim { opacity: 0; pointer-events: none; }

    /* Live subtitle bar over the lower avatar. Durations below MUST match the TS
       constants SUBTITLE_FLY_MS (650) and SUBTITLE_FADE_MS (220). */
    .subtitle {
      position: absolute; left: 8%; right: 8%; bottom: 10px; z-index: 13;
      margin: 0 auto; max-width: 92%; text-align: center;
      font-size: 15px; font-weight: 600; color: #fff;
      text-shadow: 0 1px 4px rgba(0,0,0,.85), 0 0 10px rgba(0,0,0,.6);
      background: rgba(10,9,16,.5); backdrop-filter: blur(4px);
      border: 1px solid rgba(255,255,255,.1); border-radius: 12px;
      padding: 8px 14px; overflow: visible; /* inner .subtitle-roll does the clipping */
      transform-origin: center center;
      animation: subin .22s ease both;
      transition: transform .65s cubic-bezier(.4,0,.2,1), opacity .65s ease;
    }
    /* Fixed-height rolling window: height (em) set inline from subtitleHeightEm(); clipped,
       smooth-scrolled to the bottom so newest words show and older text rolls off the top. */
    .subtitle-roll {
      line-height: 1.35; overflow: hidden; scroll-behavior: smooth;
      box-sizing: content-box;
    }
    @keyframes subin { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    /* Fly-to-history: transform is set inline (toward the chat icon); we just fade + shrink. */
    .subtitle.flying { opacity: 0; }
    /* Warning glyph in the idle status pill. */
    .warn-ico { vertical-align: -2px; margin-right: 2px; color: #f0c674; }

    /* Thin, always-visible static footer (never part of a scroll region). */
    .appfooter {
      flex: none; height: 26px; display: flex; align-items: center; justify-content: center;
      font-size: 11px; letter-spacing: 1.5px; color: #8b85a6;
      background: rgba(10,9,16,.6); border-top: 1px solid rgba(255,255,255,.06);
      font-family: 'JetBrains Mono', ui-monospace, monospace; z-index: 16;
    }
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

    /* Above EVERYTHING (top bar z-20, toasts 30, popups 40, detail 60, pip 70) so the
       open settings panel + its backdrop fully cover the main-screen top-bar icons. */
    .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 90; }
    .slideover {
      position: fixed; top: 0; right: -420px; width: 400px; max-width: 92vw; height: 100%;
      background: #15161c; border-left: 1px solid rgba(255,255,255,.08); z-index: 91;
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

    /* ============================================================
       RESPONSIVE LAYOUTS  (breakpoint: 1024px)
       Avatar is the HERO in both widths; chat is an overlay popup (NOT in flow).
       Strict top-to-bottom order in BOTH layouts, with NO page scroll:
         top bar -> status band -> avatar (hero) -> [prompt carousel at avatar's
         bottom edge] -> audio controls -> thin static footer.
       The avatar is the only flex/grid element that grows; every other band is a
       fixed/auto height, so the controls + footer are always fully visible.
       The avatar-tts ResizeObserver resizes the EXISTING canvas whenever its
       cell/band changes size -- the canvas is never recreated.
       ============================================================ */

    /* ---- WIDE / DESKTOP (>= 1024px): single centered column; chat + media are overlay popups ---- */
    @media (min-width: 1024px) {
      .app {
        display: grid;
        grid-template-columns: 1fr;
        /* No status row: the status pill is an absolute overlay, so the avatar row
           expands UPWARD; the slim controls row lets it expand DOWNWARD. */
        grid-template-rows: auto minmax(0, 1fr) auto auto;
        grid-template-areas:
          "top"
          "avatar"
          "controls"
          "footer";
        padding: 0 16px 0; /* footer sits flush to the bottom margin */
        --status-top: 46px; /* pill sits just under the one-line desktop header */
      }
      /* Top bar becomes a real grid row (no scrim needed over its own band). */
      .topbar.floating { position: relative; grid-area: top; padding: 12px 6px 6px; background: none; }
      /* Avatar is a real grid cell (NOT full-screen), centered with a sane max width.
         The canvas fills it; the ResizeObserver updates camera aspect + renderer. */
      .viewport {
        position: relative; inset: auto; grid-area: avatar; border-radius: 20px;
        width: 100%; max-width: 820px; justify-self: center;
      }
      .glow { top: 30%; }
      /* Slim audio strip directly BELOW the avatar, above the footer. */
      .bottom-cluster {
        position: relative; grid-area: controls; left: auto; bottom: auto; transform: none;
        width: 100%; max-width: 720px; justify-self: center; gap: 4px; padding-bottom: 6px;
      }
      .appfooter { grid-area: footer; }
      /* Chat (right) + media (left) are fixed overlay popups -- not part of the grid. */
    }

    /* ---- NARROW / VERTICAL / MOBILE (<= 1023px): vertical stack, NO page scroll ---- */
    @media (max-width: 1023px) {
      .app {
        display: flex; flex-direction: column;
        height: 100%; overflow: hidden; /* controls + footer always visible, no scroll */
        --status-top: 62px; /* pill sits under the taller two-line portrait header */
      }
      .topbar.floating { position: relative; order: 0; }
      /* Avatar band is the ONLY element that grows; the status pill overlays its top
         (absolute) so the avatar expands upward, and the slim strip lets it grow down. */
      .viewport {
        position: relative; inset: auto; order: 1;
        flex: 1 1 auto; width: 100%; height: auto; min-height: 200px;
      }
      /* Slim audio strip: fixed-height band, fully visible, just above the footer. */
      .bottom-cluster {
        position: relative; left: auto; bottom: auto; transform: none; order: 2;
        width: 100%; max-width: none; flex: none; gap: 4px; padding: 4px 12px;
      }
      .appfooter { order: 3; }
      /* Chat + media popups become bottom sheets above the footer; avatar stays visible. */
      .chat.popup {
        top: auto; left: 8px; right: 8px; bottom: 34px;
        width: auto; max-width: none; max-height: 70vh;
      }
      .media-panel.popup {
        top: auto; left: 8px; right: 8px; bottom: 34px;
        width: auto; max-width: none; max-height: 70vh;
      }
      /* Studio (admin debug) spans the width when open. */
      .studio-overlay { width: calc(100vw - 24px); left: 12px; right: 12px; }

      /* ---- narrow/portrait type scale + edge gutters (desktop unaffected) ---- */
      /* Slightly smaller, better-proportioned text for small widths. */
      .brandtext .name { font-size: 15px; }
      .status-line { font-size: 9.5px; letter-spacing: .9px; }
      .statuspill { font-size: 12px; padding: 6px 13px; }
      .bubble { font-size: 12.5px; }
      .vermas { font-size: 11px; }
      /* Hint chips: keep them FULLY visible -- inset from both edges, smaller font/padding,
         and WRAP (overflow visible) so a chip is never sliced by the screen edge. */
      .prompt-carousel {
        left: 0; right: 0; padding: 0 14px; overflow: visible;
        flex-wrap: wrap; row-gap: 6px;
      }
      .prompt-carousel .chip { font-size: 11px; padding: 5px 11px; max-width: calc(100vw - 36px); }
      /* Consistent side gutter for the other edge-touching bands. */
      .statusband { padding-left: 14px; padding-right: 14px; }
      .bottom-cluster { padding-left: 14px; padding-right: 14px; }
    }
  `]
})
export class TextAvatarComponent implements AfterViewChecked, OnInit, OnDestroy {
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

    // ----------------------------------------------------------- chat popup
    /** Idle time (ms) the chat popup stays fully visible before it begins to fade. */
    private readonly CHAT_FADE_IDLE_MS = 6000;
    /** Fade-out transition duration (ms). Must match the .chat.popup opacity transition (.9s). */
    private readonly CHAT_FADE_ANIM_MS = 900;
    /** Whether the chat popup is mounted (drives *ngIf). Default closed: avatar is the hero. */
    chatOpen = signal(false);
    /** True = fully visible; false = fading out (adds .faded -> opacity 0). */
    chatActive = signal(false);
    private chatIdleTimer: any = null;
    private chatFadeTimer: any = null;

    // chat unread badge ----------------------------------------------------
    /** Assistant-message count the user has already seen (snapshot on open). */
    private chatSeenCount = signal(0);
    /** Assistant responses that have FINISHED speaking (user's own messages are NOT
     *  counted; a reply still being spoken is "live" and not yet counted). */
    chatMsgCount = computed(() => this.conv.deliveredCount());
    /** New assistant responses that arrived while the chat popup was closed. */
    chatUnread = computed(() => Math.max(0, this.chatMsgCount() - this.chatSeenCount()));
    /** Badge text with a 9+ cap. */
    chatBadge = computed(() => this.badgeText(this.chatUnread()));
    /** While the chat is open, keep "seen" synced to "count" so the badge stays cleared. */
    private _chatSeenSync = effect(() => { if (this.chatOpen()) this.chatSeenCount.set(this.chatMsgCount()); });

    /** Top-bar button: open if closed, close if open. */
    toggleChat(): void { this.chatOpen() ? this.closeChat() : this.openChat(); }

    /** Open (or re-show) the popup and arm the idle->fade timer. Clears the unread badge. */
    openChat(): void {
        this.clearChatTimers();
        this.chatSeenCount.set(this.chatMsgCount()); // mark all current messages read -> badge to 0
        this.chatOpen.set(true);
        this.chatActive.set(true);
        this.armChatIdle();
    }

    /** Close immediately (top-bar toggle off). */
    closeChat(): void {
        this.clearChatTimers();
        this.chatActive.set(false);
        this.chatOpen.set(false);
    }

    /** Any interaction in the popup (focus/keystroke/pointer/wheel) keeps it visible. */
    chatActivity(): void {
        if (!this.chatOpen()) return;
        this.chatActive.set(true);
        this.armChatIdle();
    }

    private armChatIdle(): void {
        this.clearChatTimers();
        this.chatIdleTimer = setTimeout(() => this.beginChatFade(), this.CHAT_FADE_IDLE_MS);
    }
    private beginChatFade(): void {
        this.chatActive.set(false); // CSS transitions opacity -> 0
        this.chatFadeTimer = setTimeout(() => this.chatOpen.set(false), this.CHAT_FADE_ANIM_MS);
    }
    private clearChatTimers(): void {
        if (this.chatIdleTimer) { clearTimeout(this.chatIdleTimer); this.chatIdleTimer = null; }
        if (this.chatFadeTimer) { clearTimeout(this.chatFadeTimer); this.chatFadeTimer = null; }
    }

    // ---------------------------------------------------------- media popup
    /** Media popup open state (on-demand overlay, like the chat). */
    mediaOpen = signal(false);
    /** Count of media-bearing responses the user has already seen (cleared on open). */
    private mediaSeenCount = signal(0);
    /** Number of assistant responses that carry media (drives the new-content flag). */
    /** Media-bearing responses that have FINISHED speaking (counts on speech-finish,
     *  not on arrival), so the media badge/color stay in sync with the chat badge. */
    mediaCount = computed(() => this.conv.deliveredMediaCount());
    /** New-content indicator: more media has arrived than the user has seen. */
    mediaHasNew = computed(() => this.mediaCount() > this.mediaSeenCount());
    /** Count of NEW media-bearing responses since the media popup was last opened. */
    mediaUnread = computed(() => Math.max(0, this.mediaCount() - this.mediaSeenCount()));
    /** Badge text with a 9+ cap. */
    mediaBadge = computed(() => this.badgeText(this.mediaUnread()));
    /** While the popup is open, keep "seen" synced to "count" so the flag stays cleared. */
    private _mediaSeenSync = effect(() => { if (this.mediaOpen()) this.mediaSeenCount.set(this.mediaCount()); });

    /** WhatsApp-style unread badge text: caps at "9+" once the count exceeds 9. */
    private badgeText(n: number): string { return n > 9 ? '9+' : String(n); }

    toggleMedia(): void { this.mediaOpen() ? this.closeMedia() : this.openMedia(); }
    openMedia(): void {
        this.mediaSeenCount.set(this.mediaCount());
        this.mediaOpen.set(true);
        // Show the newest media when the popup mounts (newest is at the bottom of the feed).
        setTimeout(() => {
            const el = this.mediaFeedEl?.nativeElement;
            if (el) el.scrollTop = el.scrollHeight;
        }, 0);
    }
    closeMedia(): void { this.mediaOpen.set(false); }

    // -------------------------------------------------------- prompt carousel
    /** Auto-advance interval (ms) for the suggested-prompt carousel. */
    private readonly PROMPT_CAROUSEL_INTERVAL_MS = 2000;
    /** Chips visible in the carousel window at once (it slides through the full set). */
    private readonly PROMPT_CAROUSEL_VISIBLE = 2;
    /** Rotating start index into the full suggested-prompts list. */
    carouselIndex = signal(0);
    private carouselTimer: any = null;

    /** A wrapping window of the FULL per-assistant suggested-prompts list. */
    carouselPrompts = computed<SuggestedPrompt[]>(() => {
        const all = this.suggestedPrompts();
        const n = all.length;
        if (n <= this.PROMPT_CAROUSEL_VISIBLE) return all;
        const start = this.carouselIndex() % n;
        const out: SuggestedPrompt[] = [];
        for (let i = 0; i < this.PROMPT_CAROUSEL_VISIBLE; i++) out.push(all[(start + i) % n]);
        return out;
    });
    trackPrompt = (_: number, p: SuggestedPrompt) => p.label + '|' + p.prompt;

    private startCarousel(): void {
        if (this.carouselTimer) return;
        this.carouselTimer = setInterval(() => {
            const n = this.suggestedPrompts().length;
            if (n > this.PROMPT_CAROUSEL_VISIBLE) this.carouselIndex.update((i) => (i + 1) % n);
        }, this.PROMPT_CAROUSEL_INTERVAL_MS);
    }
    private stopCarousel(): void {
        if (this.carouselTimer) { clearInterval(this.carouselTimer); this.carouselTimer = null; }
    }
    /** Pause on hover/touch (nice-to-have). */
    pauseCarousel(): void { this.stopCarousel(); }
    resumeCarousel(): void { this.startCarousel(); }

    ngOnDestroy(): void {
        this.clearChatTimers(); this.stopCarousel(); this.clearFlyTimer();
        this.subMql?.removeEventListener('change', this.subMqlHandler);
    }

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

    // avatar picker state (DB-driven: avatars/{id} Firestore collection)
    thumbUrls = signal<Record<string, string | null>>({});
    /** Avatars listed from the DB, filtered to those whose GLB actually resolves. */
    dbAvatars = signal<Avatar[]>([]);
    /** Display name of the currently selected avatar (top-bar caption). Reactive: updates
     *  immediately on avatar switch (catalog.selectedId + dbAvatars are signals). */
    activeAvatarName = computed<string>(() => {
        const id = this.catalog.selectedId();
        return (id ? this.dbAvatars().find((a) => a.id === id)?.name : '') ?? '';
    });
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
    @ViewChild('subtitleBar') subtitleBar?: ElementRef<HTMLDivElement>;
    @ViewChild('subtitleRoll') subtitleRoll?: ElementRef<HTMLDivElement>;
    @ViewChild('chatIconBtn') chatIconBtn?: ElementRef<HTMLButtonElement>;

    // ---------------------------------------------------- live subtitles + fly
    /** Fly-to-history animation duration (ms). Must match the .subtitle CSS transition. */
    private readonly SUBTITLE_FLY_MS = 650;
    /** Rolling-caption window: visible lines by orientation (responsive). */
    private readonly SUBTITLE_MAX_LINES_PORTRAIT = 2;
    private readonly SUBTITLE_MAX_LINES_DESKTOP = 1;
    /** Line-height (em) of the subtitle text; must match the .subtitle-roll CSS line-height. */
    private readonly SUBTITLE_LINE_EM = 1.35;
    /** Desktop breakpoint (same 1024px used across the page). matchMedia keeps it reactive. */
    private subMql = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
    private subMqlHandler = (e: MediaQueryListEvent) => this.isDesktopWide.set(e.matches);
    /** True on wide/desktop (>=1024px); flips on orientation/size change. */
    isDesktopWide = signal(this.subMql ? this.subMql.matches : false);
    /** Active rolling-caption line limit (1 desktop / 2 portrait). */
    subtitleMaxLines = computed(() =>
        this.isDesktopWide() ? this.SUBTITLE_MAX_LINES_DESKTOP : this.SUBTITLE_MAX_LINES_PORTRAIT);
    /** Fixed window height in em for that line limit. */
    subtitleHeightEm = computed(() => this.subtitleMaxLines() * this.SUBTITLE_LINE_EM);

    /**
     * Rolling-caption auto-scroll: after each reveal tick (or a line-limit change), pin the
     * clipped window to the BOTTOM so the newest words stay visible and older text rolls off
     * the top. rAF runs after the DOM paints the new text; CSS scroll-behavior:smooth eases it.
     */
    private _subRollFx = effect(() => {
        this.subtitleText();       // dep: re-run as words reveal (same speech-reveal timing)
        this.subtitleMaxLines();   // dep: re-pin on orientation/size change
        const open = this.subStage() !== 'hidden';
        if (!open) return;
        requestAnimationFrame(() => {
            const el = this.subtitleRoll?.nativeElement;
            if (el) el.scrollTop = el.scrollHeight;
        });
    });
    /** Stage of the subtitle overlay: hidden -> live (revealing) -> flying (to chat icon). */
    subStage = signal<'hidden' | 'live' | 'flying'>('hidden');
    /** Message id whose text the subtitle shows (captured when it goes live). */
    private subCurrentId = signal<number | null>(null);
    /** Fly translation toward the chat icon (px), set in startFly(). */
    private flyX = signal(0);
    private flyY = signal(-160);
    flyTransform = computed(() => `translate(${this.flyX()}px, ${this.flyY()}px) scale(0.32)`);
    private flyTimer: any = null;
    private lastCompleted = 0;

    /**
     * Subtitle text = the SAME reveal source as the chat karaoke. While the revealing
     * message matches, slice its clean text to tts.revealedChars() (word/segment sync with
     * the voice); otherwise (finished/flying, or a non-reveal engine) show the full line.
     */
    subtitleText = computed<string>(() => {
        const revId = this.conv.revealingMsgId();
        const id = revId ?? this.conv.speakingMsgId() ?? this.subCurrentId();
        if (id == null) return '';
        const m = this.conv.messages().find((x) => x.id === id);
        if (!m) return '';
        const model = this.displayModel(m);
        if (revId === id) return model.clean.slice(0, Math.min(this.tts.revealedChars(), model.clean.length));
        return model.clean;
    });

    /**
     * Drives the hint<->subtitle swap from the speaking state + the natural-finish pulse:
     *   (a) speechCompleted pulse while live  -> fly to history (then hide).
     *   (b) state==='speaking'                -> show live subtitle (hints fade out).
     *   (c) left speaking with NO pulse (Stop/interrupt) -> quick hide, hints fade back.
     * untracked() wraps the writes so the effect only re-runs on state/completed changes.
     */
    private _subtitleFx = effect(() => {
        const speaking = this.conv.state() === 'speaking';
        const speakId = this.conv.speakingMsgId();
        const completed = this.conv.speechCompleted();
        untracked(() => {
            if (completed !== this.lastCompleted) {
                this.lastCompleted = completed;
                if (this.subStage() === 'live') this.startFly(); // natural finish -> fly
                return;
            }
            if (speaking && speakId != null) {
                if (this.subStage() !== 'live') { this.clearFlyTimer(); this.subStage.set('live'); }
                this.subCurrentId.set(speakId);
                return;
            }
            if (!speaking && this.subStage() === 'live') {
                // Stop/interrupt mid-speech: quick fade back to hints, no fly.
                this.clearFlyTimer();
                this.subStage.set('hidden');
            }
        });
    });

    /** Animate the live subtitle toward the chat icon, then remove it. */
    private startFly(): void {
        this.clearFlyTimer();
        const sub = this.subtitleBar?.nativeElement;
        const icon = this.chatIconBtn?.nativeElement;
        if (sub && icon) {
            const s = sub.getBoundingClientRect();
            const i = icon.getBoundingClientRect();
            this.flyX.set(Math.round((i.left + i.width / 2) - (s.left + s.width / 2)));
            this.flyY.set(Math.round((i.top + i.height / 2) - (s.top + s.height / 2)));
        } else {
            this.flyX.set(0); this.flyY.set(-160);
        }
        this.subStage.set('flying');
        this.flyTimer = setTimeout(() => { this.subStage.set('hidden'); this.flyTimer = null; }, this.SUBTITLE_FLY_MS);
    }
    private clearFlyTimer(): void { if (this.flyTimer) { clearTimeout(this.flyTimer); this.flyTimer = null; } }
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
    /** Current GLB URL bound to <app-avatar-tts [avatarUrl]>. SIGNAL so that setting a
     *  new avatar notifies the zoneless change detector -> the input updates -> avatar-tts
     *  ngOnChanges swaps the model immediately (no panel reopen, no Zone.js, no timer). */
    avatarUrl = signal(localStorage.getItem('textAvatar.avatarUrl') || DEFAULT_AVATAR_URL);
    avatarUrlInput = this.avatarUrl();

    // view options
    showMarkup = false; // debug toggle: chips hidden by default, clean text only
    showProcess = true;
    /** Settings slide-over open state (signal -> zoneless-friendly). */
    settingsOpen = signal(false);
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
        // Replay lead/tail blocks only when their OWN flag is on (debug). Each is
        // independent; speech (body gestures handled inside tts) always replays.
        const wantLead = GESTURES_LEADIN_ENABLED && !!msg.leadGesture;
        const wantTail = GESTURES_TAIL_ENABLED && !!msg.tailGesture;
        if (wantLead || wantTail) {
            if (this.previewBusy()) return;
            this.previewRunning = true;
            try {
                if (wantLead) await this.playGestureBlock(msg.leadGesture!);
                await this.conv.replayMessage(msgId, this.opts());
                if (wantTail) await this.playGestureBlock(msg.tailGesture!);
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
        this.avatarUrl.set(url);
        localStorage.setItem('textAvatar.avatarUrl', url);
    }

    // --------------------------------------------------------- avatar catalog

    async ngOnInit(): Promise<void> {
        // Resolve admin status for UI gating (gear + Response Editor). UX only —
        // real enforcement is server-side in rules/callables.
        void this.admin.check();
        // Start the suggested-prompt carousel rotation (idempotent; paused on hover).
        this.startCarousel();
        // React to orientation/size crossing the 1024px breakpoint (subtitle line limit).
        this.subMql?.addEventListener('change', this.subMqlHandler);
        // Load the avatar list from the DB (avatars/{id}) and restore the last selection.
        await this.loadDbAvatars();

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
     * Load the avatar picker list from the DB (avatars/{id} collection via
     * AvatarService.listAvatars), then KEEP only the avatars whose GLB actually
     * resolves to a download URL (valid, existing glbPath). This drops docs with a
     * missing/empty glbPath or a path pointing at a non-existent file -- the ones
     * that would fail to load. Thumbnails are resolved best-effort (a miss just
     * shows the person-icon; the avatar is still kept if its GLB loads). Finally,
     * restores the previously selected avatar if it is still in the valid list.
     */
    private async loadDbAvatars(): Promise<void> {
        this.avatarLoadError.set('');
        let list: Avatar[] = [];
        try {
            list = await this.avatars.listAvatars(true);
        } catch (e: any) {
            this.avatarLoadError.set('No se pudieron cargar los avatares: ' + (e?.message ?? e));
            return;
        }
        // Keep only avatars whose GLB resolves (valid glbPath + existing file).
        const checks = await Promise.all(
            list.map(async (a) => {
                if (!a.glbPath) return null;
                const url = await this.avatarMgr.resolveUrl(a.glbPath);
                return url ? a : null;
            }),
        );
        const valid = checks.filter((a): a is Avatar => !!a)
            .sort((x, y) => x.name.localeCompare(y.name));
        this.dbAvatars.set(valid);

        // Resolve thumbnails (best-effort; missing -> person-icon placeholder).
        for (const a of valid) {
            this.avatars.resolveThumb(a.id)
                .then((url) => this.thumbUrls.update((m) => ({ ...m, [a.id]: url })))
                .catch(() => {});
        }

        // Restore the previously selected avatar if it is still valid.
        const selId = this.catalog.selectedId();
        if (selId && valid.some((a) => a.id === selId)) await this.selectAvatar(selId);
    }

    /** Picker tap: close the settings panel and load the chosen avatar (GLB via
     *  AvatarService; canvas resizes, never recreates). Closing first is purely visual. */
    pickAvatar(id: string): void {
        this.settingsOpen.set(false);
        void this.selectAvatar(id);
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
        this.avatarUrl.set(url);         // signal set -> zoneless CD -> [avatarUrl] updates -> avatar-tts swaps the model
        this.avatarUrlInput = url;
        // Don't persist blob: URLs (they don't survive a reload); persist only
        // real URLs. Cold loads re-resolve via the assistant's avatarId anyway.
        if (!url.startsWith('blob:')) localStorage.setItem('textAvatar.avatarUrl', url);
        if (voice) this.applyDefaultVoice(voice);
    }

    /**
     * Apply the avatar's default voice. Any vits-web voice id is valid (the catalog is
     * now dynamic), so we don't gate on the old 6-entry list -- we derive the language
     * from the id prefix (same rule synthesis uses) and apply it directly.
     */
    private applyDefaultVoice(voiceId: string): void {
        const id = (voiceId || '').trim();
        if (!id) return;
        this.lang = id.toLowerCase().startsWith('en') ? 'en' : 'es';
        this.voiceId = id;
        this.onProviderOrLangChange();
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
        // The dynamic voice catalog lets an avatar/assistant be configured with ANY valid
        // vits-web voice id, not just the hardcoded PIPER_VOICES seed. Do NOT reset a
        // configured voice just because it is not in that seed list -- that membership check
        // is what forced every voice back to PIPER_VOICES[lang][0] (es_MX-claude-high). The
        // spoken voice must follow the configured id independently of the dropdown catalog.
        // Only fall back when the id is empty OR belongs to a DIFFERENT language than the
        // current lang (the legitimate es<->en manual-switch case). The id prefix is the
        // source of truth for language (same rule synthesis uses).
        const id = (this.voiceId || '').trim();
        const idLang: TtsLang = id.toLowerCase().startsWith('en') ? 'en' : 'es';
        if (!id || idLang !== this.lang) this.voiceId = PIPER_VOICES[this.lang][0].id;
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
