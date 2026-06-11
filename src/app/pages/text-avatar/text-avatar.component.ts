import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AvatarTtsComponent, DEFAULT_AVATAR_URL } from '../../components/avatar-tts/avatar-tts.component';
import { TtsLipsyncService, TtsProvider, TtsLang, PIPER_VOICES } from '../../services/tts-lipsync.service';

@Component({
    selector: 'app-text-avatar',
    standalone: true,
    imports: [CommonModule, FormsModule, AvatarTtsComponent],
    template: `
    <div class="layout">
      <div class="stage">
        <app-avatar-tts [avatarUrl]="avatarUrl"></app-avatar-tts>

        <div class="status" *ngIf="tts.state() !== 'idle'">
          <span [ngSwitch]="tts.state()">
            <span *ngSwitchCase="'loading-engine'">⏳ Loading TTS engine…</span>
            <span *ngSwitchCase="'synthesizing'">
              🎙️ Synthesizing…
              <span *ngIf="tts.downloadProgress() !== null">
                (downloading voice {{ (tts.downloadProgress()! * 100).toFixed(0) }}%)
              </span>
            </span>
            <span *ngSwitchCase="'speaking'">🔊 Speaking — viseme: {{ tts.currentViseme() }}</span>
          </span>
        </div>

        <div class="error" *ngIf="tts.error()">⚠️ {{ tts.error() }}</div>
        <div class="warn" *ngIf="tts.gestureWarnings().length">
          <div *ngFor="let w of tts.gestureWarnings()">⚠️ {{ w }}</div>
        </div>
      </div>

      <div class="panel">
        <h3>🗣️ Text → Avatar Speech</h3>

        <textarea
          [(ngModel)]="text"
          (keydown.enter)="onEnter($event)"
          rows="6"
          maxlength="2000"
          placeholder="Escribe el texto que dirá el avatar… (Enter para hablar) — arrastra la esquina inferior para agrandar"></textarea>
        <div class="counter">{{ text.length }}/2000</div>

        <div class="row">
          <label>
            Provider
            <select [(ngModel)]="provider" (ngModelChange)="onProviderOrLangChange()">
              <option value="piper">Piper (local, neural)</option>
              <option value="webspeech">Web Speech (OS voices)</option>
            </select>
          </label>

          <label>
            Language
            <select [(ngModel)]="lang" (ngModelChange)="onProviderOrLangChange()">
              <option value="es">Español</option>
              <option value="en">English</option>
            </select>
          </label>

          <label *ngIf="provider === 'piper'">
            Voice
            <select [(ngModel)]="voiceId">
              <option *ngFor="let v of piperVoices[lang]" [value]="v.id">{{ v.label }}</option>
            </select>
          </label>
        </div>

        <div class="row buttons">
          <button class="speak" (click)="speak()" [disabled]="!text.trim()">
            {{ tts.state() === 'idle' ? '▶️ Speak' : '🔄 Speak (replace)' }}
          </button>
          <button class="stop" (click)="stop()" [disabled]="tts.state() === 'idle'">⏹️ Stop</button>
        </div>
        <button class="stop demo" (click)="fillDemo()">🎭 Demo: gestures + speech</button>
        <p class="hint">
          Markup: <code>[yes]:[repetitions]:[speed]</code> (e.g. <code>[no]:[2]:[slow]</code>); the
          second number is how many full cycles to play. Commas pause, ellipses pause longer,
          and <code>jaja</code>/<code>jeje</code>/<code>haha</code> become a laugh clip.
        </p>

        <p class="hint" *ngIf="provider === 'piper'">
          First use downloads the voice model (~20–60 MB) and caches it locally.
          After that it works fully offline.
        </p>
        <p class="hint" *ngIf="provider === 'webspeech'">
          Uses operating-system voices. Lipsync timing is estimated and less precise.
        </p>

        <label class="avatar-field">
          Avatar GLB URL (needs ARKit blendshapes)
          <input type="text" [(ngModel)]="avatarUrlInput" placeholder="https://... .glb or /assets/models/avatar.glb" />
        </label>
        <button class="stop" (click)="loadAvatar()" [disabled]="!avatarUrlInput.trim()">🧑 Load avatar</button>
        <p class="hint">
          Note: Ready Player Me hosting shut down on 2026-01-31 — models.readyplayer.me URLs no longer work.
          Use a self-hosted GLB (e.g. from your Firebase storage or src/assets).
        </p>
      </div>
    </div>
  `,
    styles: [`
    :host { display: block; height: 100vh; }
    .layout { display: flex; height: 100%; background: #111; color: #eee; }
    .stage { flex: 1; position: relative; min-width: 0; }
    .panel {
      width: 340px; padding: 20px; background: #1b1b1f;
      display: flex; flex-direction: column; gap: 12px; overflow-y: auto;
    }
    h3 { margin: 0 0 4px; font-weight: 600; }
    textarea {
      width: 100%; box-sizing: border-box; resize: vertical;
      min-height: 130px; max-height: 70vh;
      background: #26262c; color: #eee; border: 1px solid #3a3a42;
      border-radius: 8px; padding: 10px; font-size: 15px; line-height: 1.5;
    }
    .counter { font-size: 11px; color: #888; text-align: right; margin-top: -8px; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #aaa; flex: 1; }
    input[type=text] {
      background: #26262c; color: #eee; border: 1px solid #3a3a42;
      border-radius: 6px; padding: 8px; width: 100%; box-sizing: border-box; font-size: 12px;
    }
    .avatar-field { margin-top: 8px; }
    select {
      background: #26262c; color: #eee; border: 1px solid #3a3a42;
      border-radius: 6px; padding: 6px;
    }
    .buttons { margin-top: 4px; }
    button {
      flex: 1; padding: 10px 14px; border: none; border-radius: 8px;
      font-size: 14px; cursor: pointer; transition: opacity .15s;
    }
    button:disabled { opacity: .4; cursor: default; }
    .speak { background: #4f7cff; color: white; }
    .stop { background: #3a3a42; color: #eee; }
    .hint { font-size: 12px; color: #888; line-height: 1.4; }
    .status {
      position: absolute; top: 14px; left: 14px; z-index: 2;
      background: rgba(0,0,0,.6); padding: 8px 14px; border-radius: 20px; font-size: 13px;
    }
    .warn {
      position: absolute; bottom: 14px; left: 14px; right: 14px; z-index: 2;
      background: rgba(160,120,20,.85); padding: 8px 14px; border-radius: 8px; font-size: 12px;
    }
    code { background: #26262c; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
    .demo { margin-top: 2px; }
    .error {
      position: absolute; bottom: 14px; left: 14px; right: 14px; z-index: 2;
      background: rgba(160,30,30,.85); padding: 10px 14px; border-radius: 8px; font-size: 13px;
    }
    @media (max-width: 760px) {
      .layout { flex-direction: column; }
      .panel { width: auto; }
    }
  `]
})
export class TextAvatarComponent {
    public tts = inject(TtsLipsyncService);

    text = '';
    provider: TtsProvider = 'piper';
    lang: TtsLang = 'es';
    voiceId = PIPER_VOICES.es[0].id;
    piperVoices = PIPER_VOICES;
    avatarUrl = localStorage.getItem('textAvatar.avatarUrl') || DEFAULT_AVATAR_URL;
    avatarUrlInput = this.avatarUrl;

    loadAvatar() {
        const url = this.avatarUrlInput.trim();
        if (!url) return;
        this.avatarUrl = url;
        localStorage.setItem('textAvatar.avatarUrl', url);
    }

    onEnter(event: Event) {
        const e = event as KeyboardEvent;
        if (e.shiftKey) return; // Shift+Enter = newline
        e.preventDefault();
        this.speak();
    }

    onProviderOrLangChange() {
        const list = PIPER_VOICES[this.lang];
        if (!list.some(v => v.id === this.voiceId)) this.voiceId = list[0].id;
    }

    async speak() {
        const text = this.text.trim();
        if (!text) return;
        // speak() interrupts any current playback internally (new input replaces old)
        await this.tts.speak(text, { provider: this.provider, lang: this.lang, voiceId: this.voiceId });
    }

    stop() {
        this.tts.stop();
    }

    /** Demo string exercising pauses, expressions, and gesture timing (manual testing). */
    fillDemo() {
        this.text = this.lang === 'es'
            ? 'Bueno, déjame pensar... [sigh] esto es difícil, pero [laugh] jaja está bien. Claro que sí [yes]:[3]:[slow] aunque pensándolo [no]:[2]:[fast] mejor hagámoslo...'
            : 'Okay, let me think... [sigh] this is difficult, but [laugh] haha it is fine. Of course yes [yes]:[3]:[slow] though on second thought [no]:[2]:[fast] let us just do it...';
    }
}
