import { Component, ElementRef, ViewChild, AfterViewChecked, OnInit, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
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
import { AuthService } from '../../services/auth.service';
import { ConversationHistoryService, ConversationSummary, StoredMessage } from '../../services/conversation-history.service';
import { AssistantConvContent, SuggestedPrompt } from '../../lib/conversation-content/conv-content.models';
import { MediaItem } from '../../lib/rag/rag.models';
import { AssistantConfig } from '../../lib/rag/rag.models';
import { getRagEndpoint, setRagEndpoint, getAssistantId, setAssistantId } from '../../lib/rag/rag.config';
import { TtsLipsyncService, TtsProvider, TtsLang, PIPER_VOICES } from '../../services/tts-lipsync.service';
import { SpeechRecognitionService } from '../../services/speech-recognition.service';
import { LlmService, LlmProviderId, LLM_PROVIDER_LABELS } from '../../services/llm.service';
import { ConversationService, ConvMessage, stripMarkdown } from '../../services/conversation.service';
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
            <span class="status-line"><i class="dot-online"></i> {{ activeAvatarName() }}
              <span class="quota-chip" *ngIf="rag.lastQuota() as q"
                    [class.low]="q.remaining > 0 && q.remaining <= 50" [class.zero]="q.remaining <= 0"
                    title="Consultas restantes en tu cuenta (aprox)">{{ q.remaining }} consultas</span>
            </span>
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
          <!-- Settings gear: admins (avatar picker + rig) OR any signed-in user (to
               reach their conversation history). Signed-out users do not see it. -->
          <button class="iconbtn" *ngIf="admin.isAdmin() || auth.user()" (click)="settingsOpen.set(!settingsOpen())" title="Ajustes">⚙️</button>
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

        <!-- suggested-prompt carousel pinned to the avatar's bottom edge: a SLOW, smooth,
             continuous CSS marquee (transform translate, --hint-scroll-ms). Hover or press
             pauses the drift (animation-play-state) so chips are readable/tappable; the
             button click still fires. Content = dynamic 3 suggestions (or static fallback).
             Dimmed (faded out) while subtitles show; fades back + resumes drift when idle. -->
        <div class="prompt-carousel" *ngIf="ragMode && activePrompts().length"
             [class.paused]="hintPaused()"
             (pointerenter)="pauseHints()" (pointerleave)="resumeHints()"
             (pointerdown)="pauseHints()" (pointerup)="resumeHints()" (pointercancel)="resumeHints()">
          <div class="hint-track">
            <button class="chip" *ngFor="let p of hintLoop(); let i = index; trackBy: trackHint"
                    (click)="sendChip(p)"
                    [disabled]="conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                    [title]="p.prompt">{{ p.label }}</button>
          </div>
        </div>

        <!-- LIVE SUBTITLE (rolling caption): progressively revealed in sync with the voice
             (reuses the SAME tts.revealedChars() timing as the chat karaoke). The inner
             .subtitle-roll is a fixed-height clipped window (1 line desktop / 2 lines
             portrait) auto-scrolled to the bottom so the NEWEST words stay visible and older
             text rolls off the top. On natural finish the whole bar "flies" to the chat icon. -->
        <div class="subtitle" *ngIf="subStage() !== 'hidden'" #subtitleBar
             [class.flying]="subStage() === 'flying'"
             [style.transform]="subStage() === 'flying' ? flyTransform() : null">
          <!-- User question/prompt as a YELLOW reference, shown above the response. -->
          <div class="sub-q" *ngIf="subtitleQuestion()">{{ subtitleQuestion() }}</div>
          <!-- RESPONSE caption GROWS with the text up to maxHeight (2 lines); past that a
               themed scrollbar appears and the newest line stays pinned at the bottom. Same
               window for live and held -> no sudden box jump when speech finishes. -->
          <div class="subtitle-roll" #subtitleRoll
               [style.maxHeight.em]="subtitleHeightEm()">{{ subtitleText() }}</div>
          <!-- On-screen "Ver mas" (hint-chip style, yellow text): opens the detail for the
               response currently shown in the subtitle. Appears only when a detail exists. -->
          <button class="sub-vermas" *ngIf="subtitleDetailMsg() as sm" (click)="openDetail(sm)">Ver más</button>
        </div>
      </div>

      <!-- floating toasts (top-center) -->
      <div class="toastwrap">
        <div class="toast err" *ngIf="rag.quotaBlocked()">Has agotado tus consultas; contacta para recargar.</div>
        <div class="toast warn" *ngIf="quotaWarn()">{{ quotaWarn() }}</div>
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
                <!-- "Ver mas" stays (functionality intact); it speaks the detail. The long detail
                     TEXT is intentionally NOT rendered (see the detail overlay below). -->
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
          <div class="do-actions">
            <!-- Play/Pause moved to the floating control (.do-play-float) at the bottom-right. -->
            <button class="do-x" (click)="closeDetail()" title="Cerrar">✕</button>
          </div>
        </header>
        <div class="do-scroll">
          <!-- STAGE 2 loading: detail is generated on demand when "Ver mas" is clicked. -->
          <div class="do-loading" *ngIf="detailLoading()">
            <span class="do-spin"></span> Generando el detalle...
          </div>
          <p class="do-err" *ngIf="detailError() && !detailLoading()">No se pudo generar el detalle: {{ detailError() }}</p>
          <!-- TEXT ONLY + karaoke: the spoken prefix is highlighted; the text is
               already fully visible (pre-wrap preserves the paragraph breaks). -->
          <article class="do-text" *ngIf="!detailLoading()"><span class="do-hi">{{ detailHi() }}</span>{{ detailRest() }}</article>
        </div>
        <!-- Floating pause/play (duplicate of the header control) at the bottom-right of the
             text, left of the PiP avatar, for easier access while reading/scrolling. -->
        <button class="do-play-float" *ngIf="!detailLoading() && detailText()"
                (click)="toggleDetailSpeech()" [title]="detailPlayLabel()">
          <svg *ngIf="detailPlaying()" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          <svg *ngIf="!detailPlaying()" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          <span>{{ detailPlayLabel() }}</span>
        </button>
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

        <!-- Quota: account-wide balance + a link to the full usage detail. -->
        <button class="btn ghost block" *ngIf="auth.user()" (click)="goProfile()">
          Mi cuenta y consultas<span *ngIf="rag.lastQuota() as q"> ({{ q.remaining }} restantes)</span>
        </button>

        <!-- Per-session knowledge-mode override (defaults to the assistant's mode;
             affects only this session, does NOT change the saved default). -->
        <h4>Modo de conocimiento</h4>
        <select class="km-select" [ngModel]="kmOverride()" (ngModelChange)="kmOverride.set($event)">
          <option value="rag_only">Solo RAG (responde solo de la base)</option>
          <option value="hybrid">Hibrido (base si es relevante; si no, general)</option>
          <option value="training_only">Solo entrenamiento (conocimiento general)</option>
        </select>
        <p class="note">Solo para esta sesion. No cambia el modo guardado del asistente.</p>

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

        <!-- Conversation history (per user, per assistant). Replaces the old rig
             "Fully conforms (ARKit-52)" info block. On-demand restore only. -->
        <h4 class="hist-h">Historial de conversaciones</h4>
        <p class="note" *ngIf="!auth.user()">Inicia sesion para guardar tu historial.</p>
        <ng-container *ngIf="auth.user()">
          <p class="note" *ngIf="history.loading()">Cargando historial...</p>
          <p class="note" *ngIf="!history.loading() && !history.list().length">
            Aun no tienes conversaciones guardadas con este asistente.
          </p>
          <div class="hist-list" *ngIf="history.list().length">
            <div class="hist-row" *ngFor="let c of history.list(); trackBy: trackHist"
                 (click)="restoreConversation(c)" [title]="c.title">
              <div class="hist-main">
                <span class="hist-title">{{ c.title }}</span>
                <span class="hist-meta">{{ historyWhen(c.updatedAt) }} &middot; {{ c.messageCount }} msj</span>
              </div>
              <button class="hist-del" (click)="deleteConversation(c, $event)"
                      title="Eliminar conversacion" aria-label="Eliminar conversacion">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>
                </svg>
              </button>
            </div>
          </div>
        </ng-container>
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
      --detail-pip-scale: 0.5;
      --detail-pip-base-w: 200px;
      --detail-pip-base-h: 280px;
      --detail-pip-sink: 48%;
    }
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
    .quota-chip { margin-left: 8px; font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
      background: rgba(255,255,255,.08); color: #cdd2db; border: 1px solid rgba(255,255,255,.12); }
    .quota-chip.low { background: rgba(224,179,65,.2); color: #e8c466; border-color: rgba(224,179,65,.4); }
    .quota-chip.zero { background: rgba(220,70,70,.22); color: #f0a6a6; border-color: rgba(220,70,70,.5); }
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
    .iconbtn.unread { color: #c4b0f7; border-color: rgba(139,92,246,.6); box-shadow: 0 0 10px rgba(139,92,246,.35); }
    .iconbtn.hasnew { color: #b6e84a; border-color: rgba(182,232,74,.6); box-shadow: 0 0 10px rgba(182,232,74,.35); }
    .iconbtn svg { display: block; }
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
    .viewport {
      position: absolute; inset: 0; z-index: 1; overflow: hidden;
      background: radial-gradient(ellipse at 50% 30%, #1a1530 0%, #0a0a0f 70%);
    }
    .viewport app-avatar-tts { position: absolute; inset: 0; }
    .viewport ::ng-deep .canvas-container { background-color: transparent !important; }
    .viewport.pip {
      position: fixed; right: 8px; bottom: 0; left: auto; top: auto;
      width: calc(var(--detail-pip-base-w) * var(--detail-pip-scale));
      height: calc(var(--detail-pip-base-h) * var(--detail-pip-scale));
      transform: translateY(var(--detail-pip-sink));
      flex: none; z-index: 70;
      background: transparent; border-radius: 0; box-shadow: none;
      overflow: visible; transition: width .25s ease, height .25s ease;
    }
    @media (min-width: 1024px) { .app { --detail-pip-scale: 1.5; } }
    .viewport.pip .glow { display: none; }
    .viewport.pip .prompt-carousel { display: none; }
    .viewport.pip .subtitle { display: none; }
    .pip-x { position: absolute; top: 6px; right: 6px; z-index: 2; width: 26px; height: 26px;
      border-radius: 8px; border: 1px solid rgba(255,255,255,.2); background: rgba(0,0,0,.45);
      color: #fff; cursor: pointer; font-size: 13px; }
    .detail-overlay { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column;
      background: radial-gradient(ellipse at 50% 0%, #15122a 0%, #0a0e14 70%); color: #e6e8ee;
      font-family: 'Segoe UI', system-ui, sans-serif; }
    .do-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between;
      gap: 16px; padding: 22px 28px; border-bottom: 1px solid rgba(255,255,255,.08); }
    .do-kicker { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #a78bfa; }
    .do-head h1 { margin: 4px 0 0; font-size: 24px; font-weight: 700; max-width: 70ch; }
    .do-actions { display: flex; align-items: center; gap: 10px; flex: none; }
    .do-play { display: inline-flex; align-items: center; gap: 7px; height: 40px; padding: 0 14px;
      border-radius: 999px; border: 1px solid rgba(139,92,246,.5); background: rgba(139,92,246,.2);
      color: #cbb8f8; cursor: pointer; font-size: 13px; }
    .do-play:hover { background: rgba(139,92,246,.32); color: #fff; }
    .do-x { width: 40px; height: 40px; border-radius: 999px; border: 1px solid rgba(255,255,255,.15);
      background: rgba(255,255,255,.06); color: #cfd3dc; cursor: pointer; font-size: 16px; flex: none; }
    .do-x:hover { background: rgba(255,255,255,.12); color: #fff; }
    .do-scroll { flex: 1; overflow-y: auto; padding: 24px 28px 120px; width: 100%; }
    /* Floating pause/play: bottom-right of the text, just LEFT of the PiP avatar (whose width
       follows --detail-pip vars), so it stays clear of the avatar at any breakpoint. */
    .do-play-float {
      position: fixed; bottom: 24px;
      right: calc(var(--detail-pip-base-w) * var(--detail-pip-scale) + 24px);
      z-index: 71; display: inline-flex; align-items: center; gap: 8px; height: 46px; padding: 0 20px;
      border-radius: 999px; border: 1px solid rgba(139,92,246,.6); background: rgba(139,92,246,.38);
      color: #fff; cursor: pointer; font-size: 14px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,.45);
    }
    .do-play-float:hover { background: rgba(139,92,246,.55); }
    /* Karaoke detail: single pre-wrap block (paragraph breaks preserved); the
       spoken prefix is highlighted as speech advances. */
    .do-text { font-size: 15px; line-height: 1.7; color: #c7ccd6; white-space: pre-wrap; }
    .do-hi { color: #f3eefc; background: rgba(139,92,246,.28); border-radius: 3px;
      box-decoration-break: clone; -webkit-box-decoration-break: clone; }
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
    .chat.popup .chat-input {
      flex: none; margin: 0; border-radius: 0; border: none;
      border-top: 1px solid rgba(255,255,255,.1);
      background: rgba(10,9,16,.5); box-shadow: none; padding: 8px 8px 8px 14px;
    }
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
    .media-q { margin: 0 2px 4px; display: flex; flex-direction: column; gap: 1px; }
    .media-q-kicker { font-size: 9.5px; letter-spacing: .5px; text-transform: uppercase; color: #8b85a6; }
    .media-q-text {
      font-size: 12px; font-weight: 600; color: #d6c9fb; line-height: 1.25;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }
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
    .replay { flex: none; width: 22px; height: 22px; padding: 0; border-radius: 50%;
      background: rgba(139,92,246,.15); border: 1px solid rgba(139,92,246,.35);
      color: #c4b0f7; font-size: 12px; cursor: pointer; opacity: .45; transition: opacity .15s, background .15s;
      display: grid; place-items: center; }
    .bubble.bot:hover .replay { opacity: 1; }
    .replay:hover { background: rgba(139,92,246,.35); }
    .vermas { display: inline-block; margin-top: 7px; padding: 3px 11px; border-radius: 6px; cursor: pointer;
      background: transparent; border: 1px solid #22c55e; color: #4ade80; font-size: 11.5px; font-weight: 600;
      line-height: 1.5; transition: background .15s, color .15s; }
    .vermas:hover { background: #22c55e; color: #062b14; }
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
    .statusband {
      position: absolute; top: var(--status-top, 50px); left: 0; right: 0; z-index: 18;
      display: flex; justify-content: center; align-items: center; padding: 0 12px;
      pointer-events: none;
    }
    .statusband .statuspill { pointer-events: auto; }
    .prompt-carousel {
      position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 12;
      width: 50vw; max-width: 720px;
      display: block; overflow: hidden; padding: 0;
      --hint-scroll-ms: 30000ms;
      transition: opacity .22s ease;
      /* Right-edge fade only: hints the incoming 3rd chip; never clips the left. */
      -webkit-mask-image: linear-gradient(to right, #000 82%, transparent 100%);
              mask-image: linear-gradient(to right, #000 82%, transparent 100%);
    }
    .prompt-carousel.dim { opacity: 0; pointer-events: none; }
    .hint-track {
      display: inline-flex; flex-wrap: nowrap; align-items: center; gap: 10px; width: max-content;
      animation: hint-scroll var(--hint-scroll-ms) linear infinite; will-change: transform;
    }
    /* Pause on hover OR press (the .paused class is toggled on pointerdown/enter). The
       button click still fires -- pausing only freezes the animation, it does not block
       pointer events; the tap lands on the now-stationary chip. */
    .prompt-carousel:hover .hint-track,
    .prompt-carousel.paused .hint-track { animation-play-state: paused; }
    @media (prefers-reduced-motion: reduce) { .hint-track { animation: none; } }
    .prompt-carousel .chip { animation: chipfade .4s ease both; }
    @keyframes chipfade { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
    @keyframes hint-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
    .subtitle {
      /* Sits ABOVE the always-visible hint carousel (bottom: 8px) so both show at once. */
      position: absolute; left: 8%; right: 8%; bottom: 46px; z-index: 13;
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
    /* User question/prompt reference (yellow), shown above the response caption. Clamped to
       2 lines with ellipsis so a long question never dominates the box. */
    .sub-q {
      color: #f5d442; font-weight: 700; font-size: 12.5px; line-height: 1.3;
      margin-bottom: 5px; padding-bottom: 5px; border-bottom: 1px solid rgba(245,212,66,.22);
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    /* Height grows with content up to maxHeight (set inline from subtitleHeightEm = 2 lines);
       past that a themed scrollbar appears and the newest line stays pinned to the bottom. */
    .subtitle-roll {
      line-height: 1.35; height: auto; overflow-y: auto; scroll-behavior: smooth;
      box-sizing: content-box; padding-right: 4px;
    }
    .subtitle-roll::-webkit-scrollbar { width: 8px; }
    .subtitle-roll::-webkit-scrollbar-track { background: transparent; }
    .subtitle-roll::-webkit-scrollbar-thumb {
      background: transparent; border: 1px solid rgba(96,165,250,.7); border-radius: 999px;
    }
    .subtitle-roll::-webkit-scrollbar-thumb:hover { border-color: rgba(96,165,250,1); }
    .subtitle-roll { scrollbar-width: thin; scrollbar-color: rgba(96,165,250,.7) transparent; }
    /* On-screen "Ver mas": hint-chip look (glass, rounded) but YELLOW text/border. */
    .sub-vermas {
      display: inline-block; margin-top: 8px; padding: 4px 14px; border-radius: 999px; cursor: pointer;
      background: rgba(20,18,30,.55); backdrop-filter: blur(8px);
      border: 1px solid rgba(245,212,66,.55); color: #f5d442; font-weight: 600; font-size: 12.5px;
      transition: background .15s ease, border-color .15s ease;
    }
    .sub-vermas:hover { background: rgba(245,212,66,.18); border-color: rgba(245,212,66,.95); }
    @keyframes subin { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .subtitle.flying { opacity: 0; }
    .warn-ico { vertical-align: -2px; margin-right: 2px; color: #f0c674; }
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
    .hist-h { margin-top: 16px; }
    .hist-list { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 6px; }
    .hist-row {
      display: flex; align-items: center; gap: 8px; cursor: pointer;
      background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.08);
      border-radius: 10px; padding: 8px 10px; transition: background .15s, border-color .15s;
    }
    .hist-row:hover { background: rgba(139,92,246,.12); border-color: rgba(139,92,246,.35); }
    .hist-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .hist-title { font-size: 12.5px; color: #E8E9EE; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hist-meta { font-size: 10.5px; color: #889; }
    .hist-del {
      flex: none; width: 26px; height: 26px; border-radius: 8px; cursor: pointer;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); color: #b9899a;
      display: grid; place-items: center; transition: background .15s, color .15s;
    }
    .hist-del:hover { background: rgba(179,57,57,.55); color: #fff; border-color: #c0392b; }
    .conf-warn { color: #d9a440; margin-top: 3px; font-size: 10.5px; }
    .manual-label { margin-top: 4px; }
    code { background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; font-size: 11px; }
    @media (min-width: 1024px) {
      .app {
        display: grid; grid-template-columns: 1fr;
        grid-template-rows: auto minmax(0, 1fr) auto auto;
        grid-template-areas: "top" "avatar" "controls" "footer";
        padding: 0 16px 0; --status-top: 46px;
      }
      .topbar.floating { position: relative; grid-area: top; padding: 12px 6px 6px; background: none; }
      .viewport {
        position: relative; inset: auto; grid-area: avatar; border-radius: 20px;
        width: 100%; max-width: 820px; justify-self: center;
      }
      .glow { top: 30%; }
      .bottom-cluster {
        position: relative; grid-area: controls; left: auto; bottom: auto; transform: none;
        width: 100%; max-width: 720px; justify-self: center; gap: 4px; padding-bottom: 6px;
      }
      .appfooter { grid-area: footer; }
    }
    @media (max-width: 1023px) {
      .app { display: flex; flex-direction: column;
        height: 100%; overflow: hidden; --status-top: 62px;
      }
      .topbar.floating { position: relative; order: 0; }
      .viewport {
        position: relative; inset: auto; order: 1;
        flex: 1 1 auto; width: 100%; height: auto; min-height: 200px;
      }
      .bottom-cluster {
        position: relative; left: auto; bottom: auto; transform: none; order: 2;
        width: 100%; max-width: none; flex: none; gap: 4px; padding: 4px 12px;
      }
      .appfooter { order: 3; }
      .chat.popup {
        top: auto; left: 8px; right: 8px; bottom: 34px;
        width: auto; max-width: none; max-height: 70vh;
      }
      .media-panel.popup { top: auto; left: 8px; right: 8px; bottom: 34px;
        width: auto; max-width: none; max-height: 70vh;
      }
      .studio-overlay { width: calc(100vw - 24px); left: 12px; right: 12px; }
      .brandtext .name { font-size: 15px; }
      .status-line { font-size: 9.5px; letter-spacing: .9px; }
      .statuspill { font-size: 12px; padding: 6px 13px; }
      .bubble { font-size: 12.5px; }
      .vermas { font-size: 11px; }
      .prompt-carousel { width: 75vw; max-width: none; }
      .prompt-carousel .chip { font-size: 11px; padding: 5px 11px; max-width: 70vw; }
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
    public auth = inject(AuthService);
    public history = inject(ConversationHistoryService);

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

    // ---- detail spoken playback (TTS + avatar lipsync + karaoke) ----
    /** Auto-start speaking the detail when the overlay opens. Flag so it can be
     *  turned off later without code changes. */
    private readonly DETAIL_AUTOSPEAK = true;
    /** True while THIS detail's text is the active speech (gates the karaoke). */
    readonly detailSpeaking = signal<boolean>(false);
    /** Detail message id we already auto-started, so re-renders don't restart it. */
    private detailSpokenId: number | null = null;
    /** Spoken-char count to highlight up to -- the tts reveal signal (audio-anchored)
     *  while this detail is speaking; 0 otherwise (no highlight). */
    private detailReveal = computed(() => this.detailSpeaking() ? this.tts.revealedChars() : 0);
    detailHi = computed(() => this.detailText().slice(0, this.detailReveal()));
    detailRest = computed(() => this.detailText().slice(this.detailReveal()));
    /** True when the detail audio is actively playing (not paused/idle). */
    detailPlaying = computed(() => this.detailSpeaking() && this.tts.state() === 'speaking');
    detailPlayLabel = computed(() => {
        if (this.tts.state() === 'paused' && this.detailSpeaking()) return 'Reanudar';
        if (this.detailPlaying()) return 'Pausar';
        return 'Reproducir';
    });

    /** Auto-start detail speech once the text is loaded (flag-gated). */
    private _detailSpeakFx = effect(() => {
        const dm = this.detailOpen();
        const txt = this.detailText();
        const loading = this.detailLoading();
        untracked(() => {
            if (!dm || loading || !txt.trim() || !this.DETAIL_AUTOSPEAK) return;
            if (this.detailSpokenId === dm.id) return; // already started for this message
            this.detailSpokenId = dm.id;
            this.playDetail();
        });
    });

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
        // Chat stays open until the user closes it (no idle auto-fade). Always scroll to
        // the newest message on open; the feed mounts via *ngIf, so defer one tick.
        this.stickToBottom = true;
        setTimeout(() => {
            const el = this.feedEl?.nativeElement;
            if (el) el.scrollTop = el.scrollHeight;
        }, 0);
    }

    /** Close immediately (top-bar toggle off). */
    closeChat(): void {
        this.clearChatTimers();
        this.chatActive.set(false);
        this.chatOpen.set(false);
    }

    /** Any interaction in the popup keeps it fully visible. The chat no longer auto-hides;
     *  it stays open until the user closes it explicitly (no idle->fade timer). */
    chatActivity(): void {
        if (!this.chatOpen()) return;
        this.chatActive.set(true);
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

    // ----------------------------------------------- prompt carousel (CSS marquee)
    /** Dynamic, per-turn LLM follow-up suggestions. null/empty -> static fallback chips. */
    dynamicSuggestions = signal<SuggestedPrompt[] | null>(null);
    /** Active chip set: the dynamic suggestions for this turn when present, otherwise the
     *  static per-assistant prompts (so the chips are never empty / never block on the LLM). */
    activePrompts = computed<SuggestedPrompt[]>(() => {
        const d = this.dynamicSuggestions();
        return (d && d.length) ? d : this.suggestedPrompts();
    });
    /** Doubled list for a SEAMLESS CSS marquee: the track translates 0 -> -50%, where the
     *  second copy sits exactly where the first started -> the loop wraps with no visible
     *  jump. Motion is pure CSS (transform animation); no JS timer / per-step index. */
    hintLoop = computed<SuggestedPrompt[]>(() => {
        const a = this.activePrompts();
        return a.length ? [...a, ...a] : [];
    });
    trackHint = (i: number) => i; // index key: the two copies are intentionally identical
    /** True while the user hovers or presses the carousel -> motion paused (CSS class). */
    hintPaused = signal(false);
    pauseHints(): void { this.hintPaused.set(true); }
    resumeHints(): void { this.hintPaused.set(false); }

    // ----------------------------------------------- dynamic follow-up suggestions
    /** Message id we last requested suggestions for (avoids duplicate/stale fetches). */
    private lastSuggestionMsgId = -1;
    /**
     * When a NEW assistant turn with reusable chunks arrives, fetch 3 follow-up prompts in
     * the BACKGROUND (separate 'suggestions' call, reusing the turn's chunkIds). Non-blocking:
     * the summary/speech path is untouched. Resets to the static fallback until they arrive.
     */
    private _suggestFx = effect(() => {
        const msgs = this.conv.messages();
        untracked(() => {
            if (!this.ragMode) return;
            let target: ConvMessage | undefined;
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (m.role === 'assistant' && (m.srcQuery || '').trim() && m.sourceIds?.length) { target = m; break; }
            }
            if (!target || target.id === this.lastSuggestionMsgId) return;
            this.lastSuggestionMsgId = target.id;
            // Inline options (category-explore) -> use directly as chips, no LLM fetch.
            const inline = target.suggestions ?? [];
            if (inline.length) {
                const opts: SuggestedPrompt[] = inline.slice(0, 15)
                    .map((s, i) => ({ id: 'ex-' + i, label: s, prompt: s, order: i, enabled: true }));
                this.dynamicSuggestions.set(opts.length ? opts : null);
                return;
            }
            this.dynamicSuggestions.set(null);   // fall back to static chips until fresh ones land
            void this.fetchSuggestions(target);
        });
    });

    /** Background 'suggestions' request reusing the turn's chunkIds (no re-embed). */
    private async fetchSuggestions(m: ConvMessage): Promise<void> {
        const reqAssistant = this.assistantId; // pin the assistant for staleness checks
        try {
            const resp = await this.rag.ask((m.srcQuery || '').trim(), {
                assistantId: reqAssistant,
                namespace: this.assistant()?.ragCollection,
                language: this.lang,
                voice: this.voiceId,
                mode: 'suggestions',
                chunkIds: m.sourceIds,
            });
            // Drop a stale result: a newer turn OR an assistant switch happened while
            // this was in flight -> never overwrite the current assistant's chips.
            if (this.lastSuggestionMsgId !== m.id || this.assistantId !== reqAssistant) return;
            const arr = resp.suggestions ?? [];
            const opts: SuggestedPrompt[] = arr
                .map((s) => (s || '').trim())
                .filter((s) => !!s)
                .slice(0, 3)
                .map((s, i) => ({ id: 'sg-' + i, label: s, prompt: s, order: i, enabled: true }));
            if (opts.length) this.dynamicSuggestions.set(opts); // else keep the static fallback
        } catch { /* keep static fallback on any error */ }
    }

    ngOnDestroy(): void {
        this.routeSub?.unsubscribe();
        // Leaving the page (back, route change, etc.) must always stop TTS/audio,
        // cancel any in-flight turn, and clear state so nothing keeps running or
        // carries over. resetSessionState() also clears the chat/fly timers.
        this.resetSessionState();
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
            const text = stripMarkdown((resp.detail || resp.body || '').trim());
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
        // Stop any in-flight detail speech + avatar animation cleanly (interrupt
        // bumps the generation token so a stale playback can't continue/bleed).
        if (this.detailSpeaking()) this.conv.interrupt();
        this.detailSpeaking.set(false);
        this.detailSpokenId = null;
        this.detailOpen.set(null);
        this.detailText.set('');
        this.detailError.set('');
        this.detailLoading.set(false);
    }

    /** Speak the detail text via TTS + avatar lipsync (drives revealedChars -> karaoke). */
    private playDetail(): void {
        const txt = this.detailText().trim();
        if (!txt) return;
        this.detailSpeaking.set(true);
        // sayEphemeral speaks via TTS + lipsync WITHOUT logging a chat bubble (the detail
        // renders its own karaoke in this overlay; it must NOT add a 'preview' message to the
        // side chat). Resolves on natural end OR when stopped/interrupted.
        this.conv.sayEphemeral(txt, this.opts()).finally(() => {
            // Only clear if this is still the active detail speech (a newer turn /
            // close already flips it). Leaves the highlight at its final position.
            if (this.tts.state() === 'idle') this.detailSpeaking.set(false);
        });
    }

    /** Play/pause toggle for the detail view: pause/resume in place, or (re)start. */
    toggleDetailSpeech(): void {
        const st = this.tts.state();
        if (this.detailSpeaking() && st === 'speaking') { this.conv.pauseSpeech(); return; }
        if (this.detailSpeaking() && st === 'paused') { this.conv.resumeSpeech(); return; }
        this.playDetail(); // idle / finished -> start from the beginning
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

    // Per-session knowledge-mode OVERRIDE (Ajustes selector). Defaults to the
    // assistant's saved mode; changing it overrides only this session (passed to
    // chatRag as knowledgeMode). Does NOT change the assistant's stored default.
    // An effect re-defaults it whenever the assistant changes.
    readonly kmOverride = signal<'rag_only' | 'hybrid' | 'training_only'>('rag_only');
    private _kmDefaultFx = effect(() => {
        const a = this.assistant();
        untracked(() => this.kmOverride.set((a?.knowledgeMode as any) || 'rag_only'));
    });

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
    /** The RESPONSE caption accumulates up to this many lines, THEN a (themed) scrollbar
     *  appears and the newest text stays pinned at the bottom. The yellow user-question
     *  reference (.sub-q) sits ABOVE this and is not counted here. */
    private readonly SUBTITLE_MAX_LINES_DESKTOP = 2;
    /** Line-height (em) of the subtitle text; must match the .subtitle-roll CSS line-height. */
    private readonly SUBTITLE_LINE_EM = 1.35;
    /** Desktop breakpoint (same 1024px used across the page). matchMedia keeps it reactive. */
    private subMql = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
    private subMqlHandler = (e: MediaQueryListEvent) => this.isDesktopWide.set(e.matches);
    /** True on wide/desktop (>=1024px); flips on orientation/size change. */
    isDesktopWide = signal(this.subMql ? this.subMql.matches : false);
    /** Active rolling-caption line limit (1 desktop / 2 portrait). HELD uses content
     *  height via CSS (max-height), so it is not driven by this. */
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
    subStage = signal<'hidden' | 'live' | 'flying' | 'held'>('hidden');
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

    /** The originating user question/prompt for the subtitle, shown in yellow ABOVE the
     *  response as a reference. While a response is active it uses that assistant message's
     *  srcQuery; while a request is PENDING (no assistant message yet -- sending/waiting),
     *  it falls back to the latest user message so the question shows as soon as the prompt
     *  is received (chat / hint / voice), not when the answer arrives. */
    subtitleQuestion = computed<string>(() => {
        const msgs = this.conv.messages();
        const id = this.conv.revealingMsgId() ?? this.conv.speakingMsgId() ?? this.subCurrentId();
        if (id != null) {
            const idx = msgs.findIndex((x) => x.id === id);
            if (idx >= 0) {
                const q = (msgs[idx].srcQuery ?? '').trim();
                if (q) return q;
                for (let i = idx - 1; i >= 0; i--) {
                    if (msgs[i].role === 'user') return (msgs[i].content ?? '').trim();
                }
            }
        }
        // Pending (no active assistant message yet): the latest user message is the question.
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') return (msgs[i].content ?? '').trim();
        }
        return '';
    });

    /** The assistant message currently shown in the subtitle (for the on-screen "Ver mas"). */
    subtitleMsg = computed<ConvMessage | null>(() => {
        const id = this.conv.revealingMsgId() ?? this.conv.speakingMsgId() ?? this.subCurrentId();
        if (id == null) return null;
        return this.conv.messages().find((x) => x.id === id) ?? null;
    });

    /** The subtitle's message ONLY when its detail is openable (has detail + not revealing).
     *  Drives the on-screen "Ver mas" chip on the avatar view. */
    subtitleDetailMsg = computed<ConvMessage | null>(() => {
        const m = this.subtitleMsg();
        if (!m) return null;
        const hasDetail = !!m.detail || !!m.detailAvailable;
        const revealing = this.conv.revealingMsgId() === m.id;
        return (hasDetail && !revealing) ? m : null;
    });

    /**
     * Drives the hint<->subtitle swap from the speaking state + the natural-finish pulse:
     *   (a) speechCompleted pulse while live  -> fly to history (then hide).
     *   (b) state==='speaking'                -> show live subtitle (hints fade out).
     *   (c) left speaking with NO pulse (Stop/interrupt) -> quick hide, hints fade back.
     * untracked() wraps the writes so the effect only re-runs on state/completed changes.
     */
    private _subtitleFx = effect(() => {
        const state = this.conv.state();
        const msgs = this.conv.messages();
        const speaking = state === 'speaking';
        const speakId = this.conv.speakingMsgId();
        const completed = this.conv.speechCompleted();
        // "Asking": a user prompt is registered but no assistant reply is being spoken yet.
        // Driven by the pushed USER MESSAGE (instant on chat-enter / hint / STT final), NOT by
        // conv.state() -- the turn's setState(sending->waiting_llm->speaking) calls run
        // synchronously, so an effect would only ever observe the final 'speaking' (the lead-in
        // filler animation, speakingMsgId=null) and miss the early phases. This also covers that
        // filler phase (state 'speaking' but speakId null) so the question shows immediately.
        let lastNonSys: { role: string } | null = null;
        for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role !== 'system') { lastNonSys = msgs[i]; break; } }
        const asking = lastNonSys?.role === 'user' && state !== 'idle' && state !== 'listening';
        untracked(() => {
            if (completed !== this.lastCompleted) {
                this.lastCompleted = completed;
                if (this.subStage() === 'live') {
                    // Desktop: keep the response on screen (HELD) until the next request.
                    // Mobile/portrait: fly it toward the chat history, then hide.
                    if (this.isDesktopWide()) this.subStage.set('held');
                    else this.startFly();
                }
                return;
            }
            if (speaking && speakId != null) {
                if (this.subStage() !== 'live') { this.clearFlyTimer(); this.subStage.set('live'); }
                this.subCurrentId.set(speakId);
                return;
            }
            if (asking) {
                // Show the YELLOW question reference INSTANTLY (no assistant message yet); the
                // response area stays empty until the answer arrives + body speech starts.
                this.clearFlyTimer();
                this.subCurrentId.set(null);
                this.subStage.set('live');
                return;
            }
            if (!speaking && this.subStage() === 'live') {
                // Stop/interrupt or failed turn with no pending request -> hide.
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

    /** Back arrow -> assistants list. Stop + wipe FIRST so the avatar goes silent at
     *  once and no audio / in-flight response survives the navigation (ngOnDestroy
     *  also resets, but doing it here makes the silence immediate on tap). */
    goBack(): void {
        this.resetSessionState();
        void this.router.navigate(['/assistants']);
    }

    /** Open the account/usage profile (full quota detail + ledger). Stops + clears
     *  the session first, like goBack, so nothing keeps running while away. */
    goProfile(): void {
        this.settingsOpen.set(false);
        this.resetSessionState();
        void this.router.navigate(['/profile']);
    }

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
            this.conv.ragFetcher = (q: string, mode?: 'rag' | 'capabilities' | 'textual_quote') => {
                // Carry EXPLORE category context: if the immediately-preceding assistant turn
                // was a category EXPLORE, resolve this follow-up WITHIN that category's
                // chunk(s) so e.g. "cataratas" maps to the OJO list just shown (5189142).
                let categoryChunkIds: string[] | undefined;
                const msgs = this.conv.messages();
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].role !== 'assistant') continue;
                    if (msgs[i].exploreCategory && msgs[i].sourceIds?.length) categoryChunkIds = msgs[i].sourceIds;
                    break; // only the previous assistant turn carries the context
                }
                return this.rag.ask(q, {
                    assistantId: this.assistantId,
                    // namespace hint from the loaded assistant config; the Function
                    // prefers the assistant doc's ragCollection when it exists.
                    namespace: this.assistant()?.ragCollection,
                    language: this.lang,
                    voice: this.voiceId,
                    // 'capabilities' -> metadata-only answer (no RAG retrieval).
                    mode,
                    // Per-session knowledge-mode override from the Ajustes selector
                    // (server falls back to the assistant default if this matches it).
                    knowledgeMode: this.kmOverride(),
                    categoryChunkIds,
                });
            };
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
        // Load the avatar FIRST (selectAvatar applies the avatar's default voice), THEN apply
        // the assistant's voice override so it WINS. Priority: assistant.voice -> avatar.voice
        // -> global default. If the assistant has no voice, the avatar default (just set) stays.
        if (d.avatarId) await this.selectAvatar(d.avatarId);
        if (d.voice) this.applyDefaultVoice(d.voice);
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
        // (Hint carousel motion is now pure CSS -- no JS timer to start.)
        // React to orientation/size crossing the 1024px breakpoint (subtitle line limit).
        this.subMql?.addEventListener('change', this.subMqlHandler);
        // Load the avatar list from the DB (avatars/{id}) and restore the last selection.
        await this.loadDbAvatars();

        // React to the ?assistant= query param for BOTH the initial load and any
        // in-place switch (the component is reused if Angular keeps the same route
        // config; recreated if we leave to /assistants first -- this handles both).
        // Subscribing (vs reading the one-shot snapshot) means a param change while
        // the component is reused triggers onAssistantParam(), which resets to a
        // clean slate before loading the new assistant. Falls back silently when the
        // param is absent so direct /text-avatar access keeps working.
        this.routeSub = this.route.queryParamMap.subscribe((pm) => {
            void this.onAssistantParam(pm.get('assistant'));
        });
    }

    /** Last ?assistant= value handled, so we only reset/reload on a REAL change. */
    private currentAssistantParam: string | null = null;
    private routeSub?: Subscription;

    /**
     * Handle the ?assistant= param for first load and in-place switches. On any real
     * change it RESETS the whole session (stop speech, cancel in-flight summary/detail/
     * suggestions, wipe history/media/suggestions/subtitles/badge counts) BEFORE
     * loading the new assistant, so nothing stale carries over. The 3D canvas is NOT
     * recreated -- setRagMode swaps the avatar GLB and the scene resizes in place.
     */
    private async onAssistantParam(dep: string | null): Promise<void> {
        if (dep === this.currentAssistantParam) return; // no real change -> no reset
        this.currentAssistantParam = dep;
        this.resetSessionState();
        if (dep) {
            this.assistantId = dep;
            setAssistantId(dep);
            await this.setRagMode(true); // loads deployment (avatar/voice/lang/lead-tail) + wires RAG fetcher
        }
        void this.loadHistoryList(); // refresh the Settings history list for this assistant
    }

    /** Load the signed-in user's saved conversations for the CURRENT assistant
     *  (newest first). No-op (clears the list) when signed out or no assistant. */
    async loadHistoryList(): Promise<void> {
        const u = this.auth.user();
        if (!u || !this.assistantId) { this.history.list.set([]); return; }
        await this.history.loadList(u.uid, this.assistantId);
    }

    /**
     * Clean slate for the page: stop + wipe the singleton conversation/audio
     * (conv.resetSession) and reset THIS component's view state -- dynamic
     * suggestions back to the static chips, subtitle overlay hidden, detail/media
     * overlays closed, chat popup collapsed, and the unread-badge baselines zeroed.
     * Idempotent; safe to call on enter, on assistant switch, and on leave. Never
     * touches the avatar canvas/scene.
     */
    private resetSessionState(): void {
        // Persist any pending edits of the CURRENT session BEFORE we clear messages,
        // then forget the active doc so the NEXT session starts a fresh conversation.
        this.flushHistory();
        this.history.resetCurrent();
        this.lastSavedSig = '';
        // Singleton conversation + TTS/STT + in-flight cancel + badge counters.
        this.conv.resetSession();
        // Dynamic follow-up chips -> fall back to the static carousel.
        this.dynamicSuggestions.set(null);
        this.lastSuggestionMsgId = -1;
        // Unread baselines (chat + media badges) back to zero.
        this.chatSeenCount.set(0);
        this.mediaSeenCount.set(0);
        // Subtitle overlay off + cancel its fly timer.
        this.clearFlyTimer();
        this.subStage.set('hidden');
        this.subCurrentId.set(null);
        // Close any open overlays + stop detail speech state (conv.resetSession()
        // already interrupted TTS/avatar; this clears the local playback flags).
        this.detailSpeaking.set(false);
        this.detailSpokenId = null;
        this.detailOpen.set(null);
        this.detailText.set('');
        this.detailLoading.set(false);
        this.detailError.set('');
        this.mediaViewer.set(null);
        // Collapse the chat popup + clear its idle/fade timers.
        this.clearChatTimers();
        this.chatOpen.set(false);
        this.chatActive.set(false);
    }

    // ---------------------------------------------------------- history persist
    /** trackBy for the history list rows. */
    trackHist = (_: number, c: ConversationSummary) => c.id;

    /** Refresh the history list each time the Settings panel opens (and when the
     *  auth state changes while it is open). */
    private _historyLoadFx = effect(() => {
        const open = this.settingsOpen();
        const u = this.auth.user();
        if (open && u) untracked(() => void this.loadHistoryList());
    });

    /** Load the account quota balance ONCE when the user is known, so the live
     *  counter shows on entry (before the first interaction). Server responses
     *  then reconcile it; multi-tab staleness self-corrects on the next answer. */
    private _quotaLoadFx = effect(() => {
        const u = this.auth.user();
        if (u) untracked(() => void this.rag.loadQuotaForUser(u.uid));
    });

    /** Transient "Te quedan N consultas" warning when a quota threshold is crossed. */
    readonly quotaWarn = signal<string>('');
    private quotaWarnTimer: any = null;
    private _quotaWarnFx = effect(() => {
        const q = this.rag.lastQuota(); // tracked: fires on each new answer
        untracked(() => {
            if (q && q.warnCrossed != null) {
                this.quotaWarn.set(`Te quedan ${q.remaining} consultas`);
                if (this.quotaWarnTimer) clearTimeout(this.quotaWarnTimer);
                this.quotaWarnTimer = setTimeout(() => this.quotaWarn.set(''), 6000);
            }
        });
    });

    /** Debounce timer for incremental Firestore writes. */
    private historySaveTimer: any = null;
    /** Content signature of the last successful save (skips no-op writes + the
     *  redundant write right after a restore). */
    private lastSavedSig = '';
    /** True while restoring a saved conversation -> suppress the persist effect. */
    private restoringHistory = false;

    /** A cheap signature of the persistable transcript (count + last turn). */
    private signatureOf(msgs: ConvMessage[]): string {
        const real = msgs.filter((m) => m.role !== 'system' && (m.content ?? '').trim());
        const last = real[real.length - 1];
        return real.length + ':' + (last ? last.id + ':' + (last.content ?? '').length : '0');
    }

    /**
     * Persist effect: whenever the transcript changes, save it (debounced) to
     * Firestore -- but ONLY when signed in and there is at least one real message.
     * Lazy create on the first message, update in place after. Skips while
     * restoring and skips no-op content (signature unchanged).
     */
    private _persistFx = effect(() => {
        const msgs = this.conv.messages(); // tracked dependency
        untracked(() => this.onTranscriptChanged(msgs));
    });

    private onTranscriptChanged(msgs: ConvMessage[]): void {
        if (this.restoringHistory) return;
        if (!this.auth.user()) return; // not logged in -> ephemeral only
        const hasUserTurn = msgs.some((m) => m.role === 'user' && (m.content ?? '').trim());
        if (!hasUserTurn) return; // never create an empty conversation
        const sig = this.signatureOf(msgs);
        if (sig === this.lastSavedSig) return; // nothing new
        if (this.historySaveTimer) clearTimeout(this.historySaveTimer);
        this.historySaveTimer = setTimeout(() => this.persistNow(), 700);
    }

    /** Capture the current transcript and write it now (used by the debounce and
     *  by flushHistory before a clear). Fire-and-forget; never throws into the UI. */
    private persistNow(): void {
        if (this.historySaveTimer) { clearTimeout(this.historySaveTimer); this.historySaveTimer = null; }
        const u = this.auth.user();
        if (!u) return;
        const msgs = this.conv.messages();
        if (!msgs.some((m) => m.role === 'user' && (m.content ?? '').trim())) return;
        const sig = this.signatureOf(msgs);
        this.lastSavedSig = sig;
        const wasNew = !this.history.currentConversationId();
        void this.history.save({
            uid: u.uid,
            email: u.email ?? null,
            assistantId: this.assistantId,
            assistantName: this.assistantName(),
            avatarId: this.catalog.selectedId() ?? '',
            messages: msgs,
        }).then(() => { if (wasNew) void this.loadHistoryList(); });
    }

    /** Flush a pending debounced save immediately (called before clearing state). */
    private flushHistory(): void {
        if (this.historySaveTimer || this.conv.messages().some((m) => m.role === 'user')) {
            this.persistNow();
        }
    }

    /**
     * Restore a saved conversation into the chat ON DEMAND (never automatic).
     * Saves+clears the current session first, loads the picked doc's messages into
     * the chat log, and makes that doc the active one so CONTINUING the chat appends
     * to it (same conversationId). Does not speak anything or touch the canvas.
     */
    async restoreConversation(c: ConversationSummary): Promise<void> {
        const u = this.auth.user();
        if (!u) return;
        this.resetSessionState();              // persist + stop + clear current session
        const stored = await this.history.restore(u.uid, c.id);
        const msgs = stored.map((s) => this.fromStored(s));
        this.restoringHistory = true;
        this.conv.messages.set(msgs);          // replace chat view with the restored turns
        this.history.setCurrent(c.id);         // continue appending to THIS doc
        this.lastSavedSig = this.signatureOf(msgs);
        this.restoringHistory = false;
        this.settingsOpen.set(false);
        this.openChat();                       // surface the restored transcript
    }

    /** Map a persisted message back to a runtime ConvMessage. Restored assistant
     *  turns are NOT replayable (the compiled audio plan is in-memory only). */
    private fromStored(s: StoredMessage): ConvMessage {
        const m: ConvMessage = { id: s.id, role: s.role, content: s.content ?? '', at: s.at ?? Date.now() };
        if (s.meta != null) m.meta = s.meta;
        if (s.kind != null) m.kind = s.kind;
        if (s.detail != null) m.detail = s.detail;
        if (s.detailAvailable != null) m.detailAvailable = s.detailAvailable;
        if (Array.isArray(s.sourceIds)) m.sourceIds = s.sourceIds;
        if (s.srcQuery != null) m.srcQuery = s.srcQuery;
        if (Array.isArray(s.media)) m.media = s.media as any;
        m.replayable = false;
        return m;
    }

    /** Delete a saved conversation (user-triggered, with a confirm). */
    async deleteConversation(c: ConversationSummary, ev: Event): Promise<void> {
        ev.stopPropagation();
        const u = this.auth.user();
        if (!u) return;
        const ok = typeof window !== 'undefined'
            ? window.confirm('Eliminar esta conversacion? Esta accion no se puede deshacer.')
            : true;
        if (!ok) return;
        try {
            await this.history.remove(u.uid, c.id);
        } catch (e: any) {
            console.warn('[history] delete failed:', e?.message ?? e);
        }
    }

    /** Short relative/absolute timestamp for a history row. */
    historyWhen(ms: number): string {
        if (!ms) return '';
        const d = new Date(ms);
        const now = Date.now();
        const sameDay = new Date(now).toDateString() === d.toDateString();
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return sameDay ? time : d.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + time;
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
