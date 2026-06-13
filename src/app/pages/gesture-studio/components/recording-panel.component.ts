import {
    Component, Output, EventEmitter,
    OnDestroy, inject, NgZone, signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { MotionRecorderService } from '../../../services/motion-recorder.service';
import { VoiceConversionService } from '../../../services/voice-conversion.service';
import { MotionFrame, RecordChannelConfig, DEFAULT_CHANNEL_CONFIG, VoiceAttachment } from '../../../lib/motion/motion.models';
import { PIPER_VOICES, TtsLang } from '../../../services/tts-lipsync.service';
import { VisemeFrame } from '../../../lib/lipsync/text-to-visemes';
import { Subscription } from 'rxjs';

export interface RecordingResult {
    frames: MotionFrame[];
    duration: number;
    channels: RecordChannelConfig;
    voiceAttachment?: VoiceAttachment;
    rawAudioData?: ArrayBuffer;
    /** Piper-synthesized TTS WAV — saved in audioStore by gesture-studio. */
    ttsAudioData?: ArrayBuffer;
}

@Component({
    selector: 'app-recording-panel',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <div class="panel">
      <div class="section-head">Recording</div>

      <!-- Duration -->
      <label class="field-label">Duration: <strong>{{ durationSec }}s</strong></label>
      <input class="range" type="range" min="1" max="15" step="1"
             [(ngModel)]="durationSec" [disabled]="recorder.isRecording()" />

      <!-- Channel toggles -->
      <div class="section-head" style="margin-top:12px">Channels</div>
      <label class="chk" [class.disabled]="recorder.isRecording()">
        <input type="checkbox" [(ngModel)]="channels.brows" [disabled]="recorder.isRecording()" />
        Brows
      </label>
      <label class="chk" [class.disabled]="recorder.isRecording()">
        <input type="checkbox" [(ngModel)]="channels.eyes" [disabled]="recorder.isRecording()" />
        Eyes &amp; Cheeks
      </label>
      <label class="chk" [class.disabled]="recorder.isRecording()">
        <input type="checkbox" [(ngModel)]="channels.head" [disabled]="recorder.isRecording()" />
        Head (bone)
      </label>
      <label class="chk warn-chk" [class.disabled]="recorder.isRecording()">
        <input type="checkbox" [(ngModel)]="channels.mouth" [disabled]="recorder.isRecording()" />
        Mouth ⚠️
      </label>
      <p class="note" *ngIf="channels.mouth">Mouth morphs conflict with lipsync — only plays when TTS is silent.</p>
      <label class="chk voice-chk" [class.disabled]="recorder.isRecording()">
        <input type="checkbox" [(ngModel)]="channels.voice" [disabled]="recorder.isRecording()"
               (ngModelChange)="onVoiceToggle($event)" />
        🎙 Voice
      </label>
      <p class="note" *ngIf="channels.voice && !hasSpeechRecognition">Browser STT unavailable — transcript must be typed manually.</p>

      <!-- Camera / mic status -->
      <div class="section-head" style="margin-top:12px">Face Tracking</div>
      <div class="cam-row">
        <div class="status-dot" [class.on]="recorder.cameraReady()" [class.off]="!recorder.cameraReady()"></div>
        <span>{{ recorder.cameraReady() ? 'Camera ready' : 'Initializing camera…' }}</span>
      </div>
      <div class="cam-row" *ngIf="channels.voice">
        <div class="status-dot" [class.on]="micReady()" [class.off]="!micReady()"></div>
        <span>{{ micReady() ? 'Mic ready' : (micDenied() ? 'Mic denied' : 'Enabling mic…') }}</span>
      </div>

      <!-- Record / Stop -->
      <div class="section-head" style="margin-top:14px">Capture</div>
      <button class="btn record" *ngIf="!recorder.isRecording()"
              (click)="startRecording()"
              [disabled]="!recorder.cameraReady() && !devMode">
        ⏺ Record {{ durationSec }}s
      </button>

      <ng-container *ngIf="recorder.isRecording()">
        <div class="progress-wrap">
          <div class="progress-bar" [style.width.%]="progressPct()"></div>
        </div>
        <div class="elapsed-label">{{ recorder.elapsed().toFixed(1) }} / {{ durationSec }}.0 s
          &nbsp;·&nbsp; {{ recorder.frameCount() }} frames
          <span *ngIf="channels.voice"> &nbsp;🎙</span>
        </div>
        <button class="btn ghost stop" (click)="stopRecording()">⏹ Stop Early</button>
      </ng-container>

      <!-- ---- Voice post-processing section ---- -->
      <ng-container *ngIf="pendingRawAudio && !recorder.isRecording()">
        <div class="section-head" style="margin-top:14px">🎙 Voice Conversion</div>

        <!-- Raw audio playback -->
        <audio *ngIf="rawAudioUrl" controls [src]="rawAudioUrl" class="audio-player"></audio>

        <!-- Transcript input -->
        <label class="field-label" style="margin-top:6px">
          Transcript
          <span class="hint" *ngIf="sttRunning()"> (transcribing…)</span>
          <span class="hint" *ngIf="!sttRunning() && voiceTranscript"> (edit if needed)</span>
          <textarea class="field-ta" [(ngModel)]="voiceTranscript" rows="2"
                    placeholder="Spoken text auto-populates here — or type manually"></textarea>
        </label>

        <!-- Voice picker -->
        <label class="field-label">
          TTS voice
          <select class="field-select" [(ngModel)]="selectedVoiceId">
            <optgroup *ngFor="let lang of voiceLangs" [label]="lang === 'es' ? 'Español' : 'English'">
              <option *ngFor="let v of voices[lang]" [value]="v.id">{{ v.label }}</option>
            </optgroup>
          </select>
        </label>

        <button class="btn convert"
                (click)="convertVoice()"
                [disabled]="voiceConv.converting() || !voiceTranscript.trim() || sttRunning()">
          {{ voiceConv.converting() ? ('Converting… ' + ((voiceConv.progress() * 100) | number:'1.0-0') + '%') : '🔄 Convert Voice' }}
        </button>

        <div class="voice-err" *ngIf="conversionError">⚠ {{ conversionError }}</div>

        <!-- Converted result + save/discard actions -->
        <ng-container *ngIf="ttsResult">
          <div class="voice-ok">✅ Converted: {{ ttsResult.ttsAudioDurationSec.toFixed(1) }}s</div>
          <audio controls [src]="ttsAudioUrl" class="audio-player"></audio>
          <div class="action-row">
            <button class="btn save-voice" (click)="emitWithVoice()">✔ Save with Voice</button>
            <button class="btn ghost discard" (click)="discardVoice()">✕ Discard Voice</button>
          </div>
        </ng-container>

        <!-- No conversion yet — just discard option -->
        <button class="btn ghost" style="margin-top:6px" *ngIf="!ttsResult" (click)="discardVoice()">
          ✕ Save without Voice
        </button>
      </ng-container>

      <!-- Dev mode -->
      <label class="chk" style="margin-top:12px; color:#666">
        <input type="checkbox" [(ngModel)]="devMode" />
        Dev mode (no camera)
      </label>
    </div>
  `,
    styles: [`
    .panel { display:flex; flex-direction:column; gap:6px; }
    .section-head { font-size:11px; font-weight:700; color:#8B5CF6; text-transform:uppercase; letter-spacing:.8px; margin-top:6px; }
    .field-label { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:#99a; }
    .hint { font-size:10px; color:#67e8f9; display:inline; }
    .range { width:100%; accent-color:#8B5CF6; cursor:pointer; }
    .chk { display:flex; align-items:center; gap:8px; font-size:12.5px; color:#ccc; cursor:pointer; }
    .chk.disabled { opacity:.5; cursor:default; }
    .warn-chk { color:#d9a440; }
    .voice-chk { color:#a5f3fc; }
    .note { font-size:11px; color:#c89020; margin:0; }
    .cam-row { display:flex; align-items:center; gap:8px; font-size:12.5px; color:#ccc; }
    .status-dot { width:9px; height:9px; border-radius:50%; flex:none; }
    .status-dot.on { background:#34d399; box-shadow:0 0 6px #34d39988; }
    .status-dot.off { background:#555; }
    .field-ta { background:rgba(255,255,255,.06); color:#E8E9EE; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 10px; font-size:12px; width:100%; resize:vertical; }
    .field-select { background:#1c1d25; color:#E8E9EE; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 8px; font-size:12px; width:100%; }
    .audio-player { width:100%; margin-top:4px; }
    .voice-ok { font-size:12px; color:#34d399; background:rgba(52,211,153,.1); padding:4px 10px; border-radius:7px; border:1px solid #34d39930; }
    .voice-err { font-size:11.5px; color:#fca5a5; background:rgba(239,68,68,.1); padding:4px 10px; border-radius:7px; }
    .action-row { display:flex; gap:6px; }
    .btn {
      flex:1; padding:9px 0; border-radius:10px; border:none; font-size:13px;
      font-weight:600; cursor:pointer; transition: all .15s;
    }
    .btn:disabled { opacity:.4; cursor:default; }
    .record { background:linear-gradient(135deg,#7c3aed,#4f46e5); color:#fff; }
    .record:hover:not(:disabled) { filter:brightness(1.12); }
    .convert { background:linear-gradient(135deg,#0e7490,#0369a1); color:#fff; }
    .convert:hover:not(:disabled) { filter:brightness(1.12); }
    .save-voice { background:linear-gradient(135deg,#059669,#047857); color:#fff; font-size:12px; }
    .save-voice:hover { filter:brightness(1.1); }
    .ghost { background:rgba(255,255,255,.06); color:#ddd; border:1px solid rgba(255,255,255,.1); font-size:12px; }
    .ghost:hover:not(:disabled) { background:rgba(255,255,255,.12); }
    .discard { color:#f87171; border-color:#7a1d1d; }
    .stop { color:#f87171; border-color:#7a1d1d; }
    .progress-wrap { width:100%; height:8px; background:rgba(255,255,255,.1); border-radius:4px; overflow:hidden; }
    .progress-bar { height:100%; background:linear-gradient(90deg,#7c3aed,#a855f7); border-radius:4px; transition:width .1s linear; }
    .elapsed-label { font-size:11.5px; color:#99a; text-align:center; }
  `]
})
export class RecordingPanelComponent implements OnDestroy {
    @Output() recordingComplete = new EventEmitter<RecordingResult>();
    /** Fires as soon as motion frames arrive (voice path: BEFORE Save/Discard).
     *  gesture-studio uses this to show a compiled draft in the Detail panel
     *  while the user is reviewing/converting voice. */
    @Output() recordingCaptured = new EventEmitter<{ frames: MotionFrame[]; duration: number; channels: RecordChannelConfig }>();

    readonly recorder = inject(MotionRecorderService);
    readonly voiceConv = inject(VoiceConversionService);
    private sanitizer = inject(DomSanitizer);
    private ngZone = inject(NgZone);

    durationSec = 5;
    devMode = false;
    channels: RecordChannelConfig = { ...DEFAULT_CHANNEL_CONFIG, voice: true };

    // Mic state
    readonly micReady = signal(false);
    readonly micDenied = signal(false);
    // STT state
    readonly sttRunning = signal(false);
    readonly hasSpeechRecognition = !!(
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    );

    // Voice UI
    voiceTranscript = '';
    selectedVoiceId = PIPER_VOICES.es[0].id;
    conversionError = '';
    voiceLangs: TtsLang[] = ['es', 'en'];
    voices = PIPER_VOICES;

    // Pending result after recording stops
    pendingRawAudio: ArrayBuffer | null = null;
    pendingRawMimeType = '';
    rawAudioUrl: SafeResourceUrl | null = null;
    ttsAudioUrl: SafeResourceUrl | null = null;
    ttsResult: { ttsAudioData: ArrayBuffer; ttsAudioDurationSec: number; lipsyncFrames: VisemeFrame[] } | null = null;

    private rawBlobUrl = '';
    private ttsBlobUrl = '';
    private pendingFrames: MotionFrame[] = [];
    private pendingDuration = 0;
    private pendingChannels: RecordChannelConfig = { ...DEFAULT_CHANNEL_CONFIG };

    // SpeechRecognition instance
    private recognition: any = null;
    private liveTranscriptParts: string[] = [];

    private sub: Subscription;

    constructor() {
        this.sub = this.recorder.recordingComplete$.subscribe(result => {
            // MediaRecorder.onstop fires outside Angular zone → must re-enter zone so
            // *ngIf bindings on pendingRawAudio and audio [src] bindings re-evaluate.
            this.ngZone.run(() => {
                this.pendingFrames = result.frames;
                this.pendingDuration = result.duration;
                this.pendingChannels = result.channels;

                if (result.channels.voice && result.rawAudioData) {
                    this.pendingRawAudio = result.rawAudioData;
                    this.pendingRawMimeType = result.rawAudioMimeType ?? 'audio/webm';
                    this.revokeBlobUrls();

                    // bypassSecurityTrustResourceUrl is required for <audio src> bindings;
                    // bypassSecurityTrustUrl is for href/style and gets sanitized for media.
                    const blob = new Blob([result.rawAudioData], { type: this.pendingRawMimeType });
                    this.rawBlobUrl = URL.createObjectURL(blob);
                    this.rawAudioUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.rawBlobUrl);
                    this.ttsAudioUrl = null;
                    this.ttsResult = null;
                    this.conversionError = '';
                    // Notify parent so it can compile a draft and show Detail panel immediately
                    // (before the user clicks Save/Discard — gesture-studio uses this to
                    // set selectedRecording so the Detail column is not empty during conversion)
                    this.recordingCaptured.emit({ frames: result.frames, duration: result.duration, channels: result.channels });
                    // STT ran concurrently; transcript already populated via onSttResult
                } else {
                    // No voice — emit immediately
                    this.recordingComplete.emit({
                        frames: result.frames,
                        duration: result.duration,
                        channels: result.channels,
                    });
                }
            });
        });
    }

    ngOnDestroy() {
        this.sub.unsubscribe();
        this.stopStt();
        this.revokeBlobUrls();
    }

    async onVoiceToggle(enabled: boolean): Promise<void> {
        if (!enabled) return;
        if (this.micReady()) return;
        const ok = await this.recorder.enableMic();
        this.ngZone.run(() => {
            this.micReady.set(ok);
            this.micDenied.set(!ok);
            if (!ok) this.channels.voice = false;
        });
    }

    progressPct(): number {
        return Math.min(100, (this.recorder.elapsed() / this.durationSec) * 100);
    }

    async startRecording(): Promise<void> {
        // Lazily acquire mic on first Record click when Voice is pre-checked.
        // We don't auto-prompt on page load (needs user gesture); this click IS one.
        if (this.channels.voice && !this.micReady()) {
            const ok = await this.recorder.enableMic();
            this.ngZone.run(() => {
                this.micReady.set(ok);
                this.micDenied.set(!ok);
                if (!ok) {
                    // Downgrade to motion-only if mic was denied
                    this.channels.voice = false;
                }
            });
        }

        this.clearPending();
        this.voiceTranscript = '';
        this.liveTranscriptParts = [];

        // Start STT concurrently with recording (within this user-gesture handler
        // so browser autoplay policy allows AudioContext resume later)
        if (this.channels.voice && this.hasSpeechRecognition) {
            this.startStt();
        }

        this.recorder.startRecording(this.durationSec, { ...this.channels });
    }

    stopRecording(): void {
        this.stopStt();
        this.recorder.stopRecording();
    }

    // ---- STT (Web Speech API) -----------------------------------------------

    /** Detect lang from selected voice ID prefix (e.g. 'es_MX-...' → 'es-MX') */
    private sttLang(): string {
        if (this.selectedVoiceId.startsWith('es_MX')) return 'es-MX';
        if (this.selectedVoiceId.startsWith('es_ES')) return 'es-ES';
        if (this.selectedVoiceId.startsWith('en_US')) return 'en-US';
        return 'es-MX'; // default
    }

    private startStt(): void {
        const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRec) return;

        this.stopStt(); // clear any previous instance
        this.recognition = new SpeechRec();
        this.recognition.lang = this.sttLang();
        this.recognition.continuous = true;
        this.recognition.interimResults = false; // final results only
        this.sttRunning.set(true);
        this.liveTranscriptParts = [];

        this.recognition.onresult = (e: any) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) {
                    this.liveTranscriptParts.push(e.results[i][0].transcript.trim());
                }
            }
            // Update textarea live
            this.ngZone.run(() => {
                this.voiceTranscript = this.liveTranscriptParts.join(' ');
            });
        };

        this.recognition.onerror = (e: any) => {
            console.warn('[STT] error:', e.error);
            this.ngZone.run(() => this.sttRunning.set(false));
        };

        this.recognition.onend = () => {
            this.ngZone.run(() => {
                this.sttRunning.set(false);
                this.voiceTranscript = this.liveTranscriptParts.join(' ');
            });
        };

        try {
            this.recognition.start();
        } catch (e) {
            console.warn('[STT] start failed:', e);
            this.sttRunning.set(false);
        }
    }

    private stopStt(): void {
        if (this.recognition) {
            try { this.recognition.stop(); } catch { /* ignore */ }
            this.recognition = null;
        }
        this.sttRunning.set(false);
    }

    // ---- TTS conversion -----------------------------------------------------

    async convertVoice(): Promise<void> {
        this.conversionError = '';
        const lang: TtsLang = this.selectedVoiceId.startsWith('es') ? 'es' : 'en';
        try {
            const result = await this.voiceConv.convertPiper(
                this.voiceTranscript, this.selectedVoiceId, lang);
            // PiperClient.synthesizeWav resolves outside Angular zone (Worker/AudioContext),
            // so assignments after await won't trigger change detection unless we re-enter.
            this.ngZone.run(() => {
                this.ttsResult = result;
                if (this.ttsBlobUrl) URL.revokeObjectURL(this.ttsBlobUrl);
                const ttsBlob = new Blob([result.ttsAudioData], { type: 'audio/wav' });
                this.ttsBlobUrl = URL.createObjectURL(ttsBlob);
                this.ttsAudioUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.ttsBlobUrl);
            });
        } catch (e: any) {
            this.ngZone.run(() => {
                this.conversionError = (e as any)?.message ?? String(e);
            });
        }
    }

    /** Emit recording result including voice attachment and TTS audio bytes for storage. */
    emitWithVoice(): void {
        if (!this.ttsResult) return;
        const attachment = this.voiceConv.buildAttachment(
            this.ttsResult, this.voiceTranscript, this.selectedVoiceId, this.pendingRawMimeType);
        this.recordingComplete.emit({
            frames: this.pendingFrames,
            duration: this.pendingDuration,
            channels: this.pendingChannels,
            voiceAttachment: attachment,
            rawAudioData: this.pendingRawAudio ?? undefined,
            ttsAudioData: this.ttsResult.ttsAudioData,  // ← stored in audioStore by gesture-studio
        });
        this.clearPending();
    }

    discardVoice(): void {
        this.recordingComplete.emit({
            frames: this.pendingFrames,
            duration: this.pendingDuration,
            channels: this.pendingChannels,
        });
        this.clearPending();
    }

    private clearPending(): void {
        this.pendingRawAudio = null;
        this.ttsResult = null;
        this.revokeBlobUrls();
        this.rawAudioUrl = null;
        this.ttsAudioUrl = null;
    }

    private revokeBlobUrls(): void {
        if (this.rawBlobUrl) { URL.revokeObjectURL(this.rawBlobUrl); this.rawBlobUrl = ''; }
        if (this.ttsBlobUrl) { URL.revokeObjectURL(this.ttsBlobUrl); this.ttsBlobUrl = ''; }
    }
}
