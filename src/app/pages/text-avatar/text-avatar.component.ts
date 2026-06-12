import { Component, ElementRef, ViewChild, AfterViewChecked, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AvatarTtsComponent, DEFAULT_AVATAR_URL } from '../../components/avatar-tts/avatar-tts.component';
import { TtsLipsyncService, TtsProvider, TtsLang, PIPER_VOICES } from '../../services/tts-lipsync.service';
import { SpeechRecognitionService } from '../../services/speech-recognition.service';
import { LlmService, LlmProviderId, LLM_PROVIDER_LABELS } from '../../services/llm.service';
import { ConversationService, ConvMessage } from '../../services/conversation.service';
import { parseGestureMarkup } from '../../lib/gestures/gesture-markup';
import { GESTURE_MAP } from '../../lib/gestures/gesture-library';

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
    imports: [CommonModule, FormsModule, AvatarTtsComponent],
    template: `
    <div class="app">

      <!-- ============================== TOP BAR ============================== -->
      <header class="topbar">
        <div class="brand">
          <span class="logo">🧑‍🎤</span>
          <span class="name">Avatar <em>Live</em></span>
        </div>
        <div class="topctl">
          <div class="pill provider-pill" [title]="'Proveedor LLM'">
            <span class="dot" [class.ok]="!lastError()" [class.err]="lastError()"></span>
            <select [ngModel]="llm.settings().provider" (ngModelChange)="setLlmProvider($event)">
              <option *ngFor="let p of providerIds" [value]="p">{{ providerLabels[p] }}</option>
            </select>
          </div>
          <button class="pill lang" (click)="toggleLang()" title="Idioma">
            <b [class.on]="lang === 'es'">ES</b><span>/</span><b [class.on]="lang === 'en'">EN</b>
          </button>
          <div class="pill" title="Voz">
            <select [(ngModel)]="voiceId">
              <option *ngFor="let v of piperVoices[lang]" [value]="v.id">{{ v.label }}</option>
            </select>
          </div>
          <button class="iconbtn" (click)="settingsOpen = !settingsOpen" title="Ajustes">⚙️</button>
        </div>
      </header>

      <!-- ============================== MAIN ============================== -->
      <main class="main">
        <!-- center stage -->
        <section class="stage">
          <div class="viewport">
            <div class="glow"></div>
            <app-avatar-tts [avatarUrl]="avatarUrl"></app-avatar-tts>

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

            <div class="toast warn" *ngIf="tts.gestureWarnings().length">
              <div *ngFor="let w of tts.gestureWarnings()">⚠️ {{ w }}</div>
            </div>
            <div class="toast err" *ngIf="tts.error()">⚠️ {{ tts.error() }}</div>
          </div>

          <div class="microw">
            <button class="ctl small" (click)="conv.interrupt()"
                    [disabled]="conv.state() === 'idle'" title="Detener / interrumpir">⏹</button>
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
        </section>

        <!-- right: conversation feed -->
        <aside class="chat">
          <div class="chat-head">
            <h2>Conversación</h2>
            <button class="iconbtn" (click)="conv.clear()" [disabled]="!conv.messages().length" title="Limpiar conversación">🧹</button>
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

          <div class="chat-input">
            <textarea rows="1" [(ngModel)]="convText" maxlength="1000"
                      (keydown.enter)="onConvEnter($event)"
                      [disabled]="conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                      placeholder="Escribe un mensaje…"></textarea>
            <button class="send" (click)="sendTyped()"
                    [disabled]="!convText.trim() || conv.state() === 'waiting_llm' || conv.state() === 'sending'"
                    title="Enviar (Enter)">➤</button>
          </div>
        </aside>
      </main>

      <!-- ============================== SETTINGS SLIDE-OVER ============================== -->
      <div class="backdrop" *ngIf="settingsOpen" (click)="settingsOpen = false"></div>
      <div class="slideover" [class.open]="settingsOpen">
        <div class="so-head">
          <h2>Ajustes</h2>
          <button class="iconbtn" (click)="settingsOpen = false">✕</button>
        </div>

        <h4>Proveedor LLM — {{ providerLabels[llm.settings().provider] }}</h4>
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

        <h4>Avatar</h4>
        <label>Avatar GLB URL (con blendshapes ARKit)
          <input type="text" [(ngModel)]="avatarUrlInput" placeholder="https://... .glb o /assets/models/avatar.glb" />
        </label>
        <button class="ghost" (click)="loadAvatar()" [disabled]="!avatarUrlInput.trim()">🧑 Cargar avatar</button>
        <p class="note">Ready Player Me cerró su hosting (2026-01-31); usa un GLB propio (Firebase o assets).</p>
      </div>
    </div>
  `,
    styles: [`
    :host { display: block; height: 100vh; }
    * { box-sizing: border-box; }
    .app {
      height: 100%; display: flex; flex-direction: column;
      background: #0E0F13; color: #E8E9EE;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      --accent: #8B5CF6; --accent-soft: rgba(139, 92, 246, .18);
    }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 18px; flex: none; border-bottom: 1px solid rgba(255,255,255,.06);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; letter-spacing: .3px; }
    .brand .logo { width: 32px; height: 32px; display: grid; place-items: center; background: var(--accent-soft); border-radius: 10px; font-size: 16px; }
    .brand em { color: var(--accent); font-style: normal; }
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
      width: 34px; height: 34px; border-radius: 10px; border: 1px solid rgba(255,255,255,.08);
      background: rgba(255,255,255,.05); color: #E8E9EE; cursor: pointer; font-size: 15px;
      display: grid; place-items: center; transition: background .15s;
    }
    .iconbtn:hover:not(:disabled) { background: rgba(255,255,255,.1); }
    .iconbtn:disabled { opacity: .35; cursor: default; }

    .main { flex: 1; display: flex; gap: 16px; padding: 16px; min-height: 0; }
    .stage { flex: 1.9; display: flex; flex-direction: column; min-width: 0; gap: 12px; }
    .viewport {
      flex: 1; position: relative; border-radius: 20px; overflow: hidden;
      background: radial-gradient(ellipse at 50% 30%, #1a1530 0%, #0a0a0f 70%);
      border: 1px solid rgba(255,255,255,.06); min-height: 0;
    }
    .viewport app-avatar-tts { position: absolute; inset: 0; }
    .viewport ::ng-deep .canvas-container { background-color: transparent !important; }
    .glow {
      position: absolute; left: 50%; top: 38%; width: 480px; height: 480px;
      transform: translate(-50%, -50%); pointer-events: none; z-index: 1;
      background: radial-gradient(circle, rgba(139,92,246,.45) 0%, rgba(139,92,246,.12) 45%, transparent 70%);
      mix-blend-mode: screen;
    }
    .statuspill {
      position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 3;
      display: flex; align-items: center; gap: 8px;
      background: rgba(14,15,19,.75); backdrop-filter: blur(8px);
      border: 1px solid rgba(139,92,246,.35); color: #ddd;
      padding: 8px 18px; border-radius: 999px; font-size: 13.5px; white-space: nowrap;
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
    .toast { position: absolute; left: 14px; right: 14px; z-index: 3; padding: 9px 14px; border-radius: 10px; font-size: 12.5px; }
    .toast.warn { top: 14px; background: rgba(160,120,20,.85); }
    .toast.err { top: 14px; background: rgba(160,30,30,.88); }

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
      width: 46px; height: 46px; border-radius: 50%; border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.05); color: #ccc; font-size: 16px; cursor: pointer;
      display: grid; place-items: center; transition: background .15s;
    }
    .ctl:hover:not(:disabled) { background: rgba(255,255,255,.12); }
    .ctl:disabled { opacity: .35; cursor: default; }
    .ctl.active { background: #b33939; border-color: #b33939; color: #fff; }
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
    .drawer-actions { display: flex; gap: 8px; align-items: center; }
    .counter { margin-left: auto; font-size: 11px; color: #666; }
    .ghost {
      padding: 8px 16px; border-radius: 10px; cursor: pointer; font-size: 13px;
      background: rgba(255,255,255,.06); color: #ddd; border: 1px solid rgba(255,255,255,.1);
      transition: background .15s;
    }
    .ghost:hover:not(:disabled) { background: rgba(255,255,255,.12); }
    .ghost:disabled { opacity: .4; cursor: default; }

    .chat {
      flex: 1; min-width: 300px; max-width: 420px; display: flex; flex-direction: column;
      background: rgba(255,255,255,.035); backdrop-filter: blur(14px);
      border: 1px solid rgba(255,255,255,.07); border-radius: 20px; overflow: hidden;
    }
    .chat-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.06); flex: none; }
    .chat-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .feed { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .empty { margin: auto; color: #667; font-size: 14px; }
    .bubble { max-width: 92%; padding: 9px 13px; border-radius: 14px; font-size: 13.5px; line-height: 1.55; }
    .bubble.user { align-self: flex-end; background: rgba(139,92,246,.16); border: 1px solid rgba(139,92,246,.25); border-bottom-right-radius: 4px; color: #e6defc; }
    .bubble.user.interimb { opacity: .55; font-style: italic; }
    .bubble.bot { align-self: flex-start; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); border-bottom-left-radius: 4px; color: #dfe2ea; }
    .bubble.bot.streaming { opacity: .65; }
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
    .chat-input {
      flex: none; display: flex; gap: 8px; align-items: flex-end;
      padding: 10px 12px; border-top: 1px solid rgba(255,255,255,.06);
    }
    .chat-input textarea {
      flex: 1; resize: none; min-height: 36px; max-height: 100px;
      background: rgba(255,255,255,.05); color: #E8E9EE; border: 1px solid rgba(255,255,255,.1);
      border-radius: 12px; padding: 8px 12px; font-size: 13px; line-height: 1.4;
    }
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
    code { background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; font-size: 11px; }

    @media (max-width: 900px) {
      .main { flex-direction: column; }
      .chat { max-width: none; min-height: 220px; }
    }
  `]
})
export class TextAvatarComponent implements AfterViewChecked {
    public tts = inject(TtsLipsyncService);
    public stt = inject(SpeechRecognitionService);
    public llm = inject(LlmService);
    public conv = inject(ConversationService);

    @ViewChild('feedEl') feedEl?: ElementRef<HTMLDivElement>;
    private stickToBottom = true;
    private lastMsgCount = 0;

    // manual text mode
    text = '';
    textMode = false;

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

    private opts() {
        return { provider: this.provider, lang: this.lang, voiceId: this.voiceId };
    }

    micPress() {
        // listening -> finish turn; speaking/thinking -> interrupt + listen; idle -> listen
        this.conv.startListening(this.opts());
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
        this.conv.sendText(t, this.opts());
    }

    onConvEnter(event: Event) {
        const e = event as KeyboardEvent;
        if (e.shiftKey) return; // Shift+Enter = newline
        e.preventDefault();
        this.sendTyped();
    }

    replay(msgId: number) {
        void this.conv.replayMessage(msgId, this.opts());
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
        if (!el) return;
        const count = this.conv.messages().length + (this.conv.streaming() ? 1 : 0) + (this.stt.interim() ? 1 : 0);
        if (count !== this.lastMsgCount && this.stickToBottom) {
            el.scrollTop = el.scrollHeight;
        }
        this.lastMsgCount = count;
    }

    // ------------------------------------------------------------ manual mode

    loadAvatar() {
        const url = this.avatarUrlInput.trim();
        if (!url) return;
        this.avatarUrl = url;
        localStorage.setItem('textAvatar.avatarUrl', url);
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
