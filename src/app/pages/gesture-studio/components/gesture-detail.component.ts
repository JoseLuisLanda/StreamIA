import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject, signal, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MotionRecording, RecordingCategory, VoiceAttachment, AudioEntry } from '../../../lib/motion/motion.models';
import { GestureDef, GESTURE_LIBRARY, EasingType } from '../../../lib/gestures/gesture-library';
import { GesturePlayerService } from '../../../services/gesture-player.service';
import { MotionStoreService } from '../../../services/motion-store.service';
import { CustomGestureRegistryService } from '../../../services/custom-gesture-registry.service';
import { MotionCompilerService } from '../../../services/motion-compiler.service';
import { VoiceConversionService } from '../../../services/voice-conversion.service';
import { PIPER_VOICES, TtsLang } from '../../../services/tts-lipsync.service';

const EASING_OPTIONS: EasingType[] = ['none', 'ease-in-cubic', 'ease-in-out-cubic', 'ease-out-cubic', 'ease-out-quad'];

@Component({
    selector: 'app-gesture-detail',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <div class="detail-wrap" *ngIf="recording; else noSel">

      <!-- Label & category -->
      <div class="field-row">
        <label class="field-label">Label
          <input class="field-input" type="text" [(ngModel)]="editLabel"
                 placeholder="e.g. sigh_v2" maxlength="40" />
        </label>
        <label class="field-label">Category
          <select class="field-select" [(ngModel)]="editCategory">
            <option value="head">head</option>
            <option value="expression">expression</option>
            <option value="mixed">mixed</option>
          </select>
        </label>
      </div>

      <!-- Allow mouth toggle -->
      <label class="chk">
        <input type="checkbox" [(ngModel)]="editAllowMouth" />
        Allow mouth channels (expression clips)
      </label>

      <!-- Easing -->
      <div class="field-row" *ngIf="recording.compiledGesture">
        <label class="field-label">Entry easing
          <select class="field-select" [(ngModel)]="editEntryEasing" (ngModelChange)="applyEasing()">
            <option *ngFor="let e of easings" [value]="e">{{ e }}</option>
          </select>
        </label>
        <label class="field-label">Exit easing
          <select class="field-select" [(ngModel)]="editExitEasing" (ngModelChange)="applyEasing()">
            <option *ngFor="let e of easings" [value]="e">{{ e }}</option>
          </select>
        </label>
      </div>

      <!-- Repetitions & returnDuration -->
      <div class="field-row" *ngIf="recording.compiledGesture">
        <label class="field-label">Repetitions
          <input class="field-input sm" type="number" min="1" max="10" [(ngModel)]="editRepetitions" />
        </label>
        <label class="field-label">Return duration (s)
          <input class="field-input sm" type="number" min="0.1" max="2" step="0.05" [(ngModel)]="editReturnDuration" />
        </label>
      </div>

      <!-- Stats row -->
      <div class="stats-row" *ngIf="recording.compiledGesture">
        <span class="stat">{{ recording.compiledGesture.channels.length }} channels</span>
        <span class="stat">{{ recording.frameCount }} raw frames</span>
        <span class="stat">{{ recording!.duration.toFixed(1) }}s recorded</span>
        <span class="stat cat">{{ recording.category }}</span>
      </div>
      <div class="stats-row" *ngIf="!recording.compiledGesture">
        <span class="stat warn">⚠ Not compiled yet — click Compile & Save</span>
      </div>

      <!-- Action buttons -->
      <div class="actions">
        <button class="btn preview" *ngIf="recording.compiledGesture" (click)="preview()">▶ Preview</button>
        <button class="btn save" (click)="save()" [disabled]="saving()">
          {{ saving() ? '…' : recording.compiledGesture ? '✔ Update Library' : '⚡ Compile & Save' }}
        </button>
        <button class="btn fork" *ngIf="isBuiltIn" (click)="fork()" title="Fork this built-in as a custom copy">
          Fork
        </button>
      </div>
      <div class="actions" *ngIf="recording.compiledGesture">
        <button class="btn ghost" (click)="exportJson()">↓ Export JSON</button>
        <button class="btn ghost" (click)="copySnippet()">{{ '{' }} {{ '}' }} TS Snippet</button>
        <button class="btn danger" (click)="deleteRec()" [disabled]="isBuiltIn">🗑 Delete</button>
      </div>

      <div class="toast-msg ok" *ngIf="toastMsg() === 'ok'">✔ Saved to library</div>
      <div class="toast-msg info" *ngIf="toastMsg() === 'copied'">Copied to clipboard!</div>
      <div class="toast-msg err" *ngIf="toastMsg() === 'err'">Save failed — check console</div>
    </div>


      <!-- ── Voice / Audio management ── -->
      <ng-container *ngIf="!isBuiltIn && recording as rec">
        <div class="section-sep"></div>
        <div class="voice-head">🎙 Voice</div>

        <!-- Existing attachment info -->
        <ng-container *ngIf="rec.voiceAttachment as va">
          <div class="voice-row" *ngIf="va.ttsAudioDurationSec">
            <span class="voice-label">TTS:</span>
            <span class="voice-val">{{ va.ttsAudioDurationSec.toFixed(2) }}s (gesture: {{ rec.duration.toFixed(2) }}s)</span>
          </div>
          <div class="voice-row" *ngIf="va.voiceId">
            <span class="voice-label">Voice:</span>
            <span class="voice-val">{{ va.voiceId }}</span>
          </div>
        </ng-container>

        <!-- Editable transcript -->
        <label class="field-label">
          Transcript
          <textarea class="field-ta" [(ngModel)]="audioTranscript" rows="2"
                    placeholder="Text for TTS synthesis — edit and Regenerate"></textarea>
        </label>

        <!-- Voice picker -->
        <label class="field-label">
          Voice
          <select class="field-select" [(ngModel)]="audioVoiceId">
            <optgroup *ngFor="let lang of voiceLangs" [label]="lang === 'es' ? 'Español' : 'English'">
              <option *ngFor="let v of voicesList[lang]" [value]="v.id">{{ v.label }}</option>
            </optgroup>
          </select>
        </label>

        <!-- Action row -->
        <div class="audio-actions">
          <button class="btn audio-btn regen" (click)="regenerateAudio()"
                  [disabled]="voiceConv.converting() || !audioTranscript.trim()"
                  title="Re-run TTS with current transcript">
            {{ voiceConv.converting() ? 'Converting…' : '🔄 Regenerate' }}
          </button>
          <button class="btn audio-btn upload" (click)="fileInput.click()"
                  title="Attach a local audio file">
            📂 Upload
          </button>
          <button class="btn audio-btn del-audio" (click)="deleteAudio()"
                  *ngIf="rec.voiceAttachment"
                  title="Remove audio, keep motion">
            🗑 Del Audio
          </button>
        </div>
        <!-- Hidden file input for upload -->
        <input #fileInput type="file" accept="audio/*" style="display:none"
               (change)="onAudioFileSelected($event)" />

        <div class="toast-msg ok" *ngIf="audioToast() === 'ok'">✔ Audio updated</div>
        <div class="toast-msg err" *ngIf="audioToast() === 'err'">Audio update failed — check console</div>
        <div class="toast-msg info" *ngIf="audioToast() === 'deleted'">Audio removed</div>
      </ng-container>

    <ng-template #noSel>
      <div class="no-sel">Select a gesture from the list to edit or preview it.</div>
    </ng-template>
  `,
    styles: [`
    .detail-wrap { display:flex; flex-direction:column; gap:10px; }
    .field-row { display:flex; gap:10px; flex-wrap:wrap; }
    .field-label { display:flex; flex-direction:column; gap:4px; font-size:11.5px; color:#99a; flex:1; min-width:120px; }
    .field-input { background:rgba(255,255,255,.06); color:#E8E9EE; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 10px; font-size:12.5px; width:100%; }
    .field-input.sm { max-width:90px; }
    .field-select { background:#1c1d25; color:#E8E9EE; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 8px; font-size:12px; width:100%; }
    .chk { display:flex; align-items:center; gap:8px; font-size:12px; color:#ccc; cursor:pointer; }
    .stats-row { display:flex; flex-wrap:wrap; gap:8px; }
    .stat { font-size:10.5px; background:rgba(255,255,255,.06); padding:2px 8px; border-radius:999px; color:#99a; border:1px solid rgba(255,255,255,.08); }
    .stat.cat { color:#a78bfa; border-color:rgba(139,92,246,.35); }
    .stat.warn { color:#f59e0b; border-color:#f59e0b44; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .btn { padding:8px 14px; border-radius:9px; border:none; font-size:12.5px; font-weight:600; cursor:pointer; transition:all .12s; }
    .btn:disabled { opacity:.4; cursor:default; }
    .preview { background:rgba(139,92,246,.25); color:#c4b0f7; border:1px solid rgba(139,92,246,.4); }
    .preview:hover:not(:disabled) { background:rgba(139,92,246,.4); }
    .save { background:linear-gradient(135deg,#7c3aed,#4f46e5); color:#fff; }
    .save:hover:not(:disabled) { filter:brightness(1.1); }
    .fork { background:rgba(96,165,250,.15); color:#93c5fd; border:1px solid rgba(96,165,250,.3); }
    .ghost { background:rgba(255,255,255,.06); color:#ddd; border:1px solid rgba(255,255,255,.1); }
    .ghost:hover:not(:disabled) { background:rgba(255,255,255,.12); }
    .danger { background:rgba(239,68,68,.14); color:#fca5a5; border:1px solid rgba(239,68,68,.3); }
    .danger:hover:not(:disabled) { background:rgba(239,68,68,.28); }
    .toast-msg { font-size:12px; padding:6px 12px; border-radius:8px; }
    .toast-msg.ok { background:rgba(52,211,153,.12); color:#34d399; border:1px solid #34d39930; }
    .toast-msg.info { background:rgba(139,92,246,.12); color:#a78bfa; border:1px solid rgba(139,92,246,.3); }
    .toast-msg.err { background:rgba(239,68,68,.12); color:#fca5a5; border:1px solid rgba(239,68,68,.3); }
    .no-sel { font-size:12.5px; color:#55607a; padding:20px 0; text-align:center; }
    .section-sep { height:1px; background:rgba(255,255,255,.06); margin:4px 0; }
    .voice-section { display:flex; flex-direction:column; gap:5px; }
    .voice-head { font-size:11px; font-weight:700; color:#67e8f9; text-transform:uppercase; letter-spacing:.8px; }
    .voice-row { display:flex; gap:6px; flex-wrap:wrap; }
    .voice-label { font-size:11px; color:#667; min-width:90px; }
    .voice-val { font-size:11.5px; color:#ccc; word-break:break-word; flex:1; }
    .voice-warn { font-size:11px; color:#f59e0b; }
    .voice-head { font-size:11px; font-weight:700; color:#67e8f9; text-transform:uppercase; letter-spacing:.8px; margin-bottom:4px; }
    .field-ta { background:rgba(255,255,255,.06); color:#E8E9EE; border:1px solid rgba(255,255,255,.12); border-radius:8px; padding:7px 10px; font-size:12px; width:100%; resize:vertical; }
    .audio-actions { display:flex; gap:6px; flex-wrap:wrap; }
    .audio-btn { padding:7px 10px; border-radius:9px; border:none; font-size:11.5px; font-weight:600; cursor:pointer; transition:all .12s; }
    .audio-btn:disabled { opacity:.4; cursor:default; }
    .regen { background:rgba(14,116,144,.25); color:#67e8f9; border:1px solid rgba(14,116,144,.4); }
    .regen:hover:not(:disabled) { background:rgba(14,116,144,.45); }
    .upload { background:rgba(99,102,241,.2); color:#a5b4fc; border:1px solid rgba(99,102,241,.35); }
    .upload:hover:not(:disabled) { background:rgba(99,102,241,.38); }
    .del-audio { background:rgba(239,68,68,.12); color:#fca5a5; border:1px solid rgba(239,68,68,.25); }
    .del-audio:hover:not(:disabled) { background:rgba(239,68,68,.25); }
  `]
})
export class GestureDetailComponent implements OnChanges {
    @Input() recording: MotionRecording | null = null;
    @Output() deleted = new EventEmitter<string>();
    @Output() saved = new EventEmitter<MotionRecording>();

    @ViewChild('fileInput') fileInputRef!: ElementRef<HTMLInputElement>;

    private player  = inject(GesturePlayerService);
    private store   = inject(MotionStoreService);
    private registry = inject(CustomGestureRegistryService);
    private compiler = inject(MotionCompilerService);
    readonly voiceConv = inject(VoiceConversionService);

    readonly easings    = EASING_OPTIONS;
    readonly voiceLangs: TtsLang[] = ['es', 'en'];
    readonly voicesList = PIPER_VOICES;

    editLabel = '';
    editCategory: RecordingCategory = 'mixed';
    editAllowMouth = false;
    editEntryEasing: EasingType = 'ease-in-out-cubic';
    editExitEasing: EasingType = 'ease-out-quad';
    editRepetitions = 1;
    editReturnDuration = 0.3;

    // Audio management state
    audioTranscript = '';
    audioVoiceId    = PIPER_VOICES.es[0].id;

    saving    = signal(false);
    toastMsg  = signal<'ok' | 'err' | 'copied' | null>(null);
    audioToast = signal<'ok' | 'err' | 'deleted' | null>(null);

    get isBuiltIn(): boolean {
        return this.registry.isBuiltIn(this.recording?.compiledGesture?.id ?? '');
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['recording'] && this.recording) {
            this.editLabel = this.recording.label;
            this.editCategory = this.recording.category;
            const g = this.recording.compiledGesture;
            this.editAllowMouth = g?.allowMouth ?? false;
            this.editEntryEasing = g?.entryEasing ?? 'ease-in-out-cubic';
            this.editExitEasing = g?.exitEasing ?? 'ease-out-quad';
            this.editRepetitions = g?.defaultRepetitions ?? 1;
            this.editReturnDuration = g?.returnDuration ?? 0.3;
            this.toastMsg.set(null);
            this.audioToast.set(null);
            // Pre-fill audio management fields from existing attachment
            const va = this.recording.voiceAttachment;
            this.audioTranscript = va?.transcript ?? '';
            this.audioVoiceId    = va?.voiceId ?? PIPER_VOICES.es[0].id;
        }
    }

    applyEasing(): void {
        if (!this.recording?.compiledGesture) return;
        this.recording.compiledGesture.entryEasing = this.editEntryEasing;
        this.recording.compiledGesture.exitEasing = this.editExitEasing;
    }

    preview(): void {
        const id = this.recording?.compiledGesture?.id;
        if (id) this.player.trigger(id);
    }

    async save(): Promise<void> {
        if (!this.recording) return;
        this.saving.set(true);
        this.toastMsg.set(null);
        try {
            // Compile or recompile if no compiled gesture
            let gesture = this.recording.compiledGesture;
            const gestureId = `custom_${this.editLabel.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || 'gesture'}`;

            if (!gesture || gesture.id !== gestureId) {
                // Compile fresh
                gesture = this.compiler.compile(
                    this.recording.frames,
                    this.editLabel || 'gesture',
                    { allowMouth: this.editAllowMouth }
                );
            }

            // Apply UI overrides
            gesture.entryEasing = this.editEntryEasing;
            gesture.exitEasing = this.editExitEasing;
            gesture.defaultRepetitions = Math.max(1, Math.floor(this.editRepetitions));
            gesture.returnDuration = Math.max(0.1, this.editReturnDuration);
            gesture.allowMouth = this.editAllowMouth || undefined;

            const updated: MotionRecording = {
                ...this.recording,
                label: this.editLabel,
                category: this.editCategory,
                compiledGesture: gesture,
                updatedAt: Date.now(),
            };

            await this.store.save(updated);
            this.registry.register(gesture);
            this.toastMsg.set('ok');
            this.saved.emit(updated);
            setTimeout(() => this.toastMsg.set(null), 2500);
        } catch (e) {
            console.error('[gesture-detail] save failed:', e);
            this.toastMsg.set('err');
        } finally {
            this.saving.set(false);
        }
    }

    async deleteRec(): Promise<void> {
        if (!this.recording || this.isBuiltIn) return;
        const id = this.recording.compiledGesture?.id;
        if (id) this.registry.unregister(id);
        await this.store.delete(this.recording.id);
        this.deleted.emit(this.recording.id);
    }

    exportJson(): void {
        if (!this.recording) return;
        const json = this.store.exportJson(this.recording);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.recording.label || 'gesture'}.gesture.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    async copySnippet(): Promise<void> {
        if (!this.recording) return;
        const snippet = this.store.toTypescriptSnippet(this.recording);
        try {
            await navigator.clipboard.writeText(snippet);
            this.toastMsg.set('copied');
            setTimeout(() => this.toastMsg.set(null), 2000);
        } catch {
            console.warn('[gesture-detail] clipboard write failed');
        }
    }

    // ─── Audio management ────────────────────────────────────────────────────

    /** Re-run TTS with the current (possibly edited) transcript → replace stored audio. */
    async regenerateAudio(): Promise<void> {
        if (!this.recording || !this.audioTranscript.trim()) return;
        this.audioToast.set(null);
        try {
            const lang: TtsLang = this.audioVoiceId.startsWith('es') ? 'es' : 'en';
            const result = await this.voiceConv.convertPiper(
                this.audioTranscript.trim(), this.audioVoiceId, lang);

            const audioEntry: AudioEntry = {
                id: this.recording.id,
                ttsAudioData: result.ttsAudioData,
            };
            await this.store.saveAudio(audioEntry);

            const attachment = this.voiceConv.buildAttachment(
                result, this.audioTranscript.trim(), this.audioVoiceId);
            const updated: MotionRecording = {
                ...this.recording,
                voiceAttachment: attachment,
                updatedAt: Date.now(),
            };
            await this.store.save(updated);
            this.audioToast.set('ok');
            this.saved.emit(updated);
            setTimeout(() => this.audioToast.set(null), 2500);
        } catch (e) {
            console.error('[gesture-detail] regenerateAudio failed:', e);
            this.audioToast.set('err');
        }
    }

    /**
     * Upload a local audio file and attach it to this gesture.
     * Lipsync frames are derived from the current transcript using textToVisemes()
     * scaled to the uploaded audio duration — no cloud call needed.
     */
    async onAudioFileSelected(event: Event): Promise<void> {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file || !this.recording) return;
        this.audioToast.set(null);

        try {
            const arrayBuffer = await file.arrayBuffer();
            // Decode to get actual duration
            const audioCtx = new AudioContext();
            const decoded  = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
            const durationSec = decoded.duration;
            await audioCtx.close();

            // Derive lipsync from transcript (or empty → no mouth movement)
            const { textToVisemes, scaleTimeline } = await import('../../../lib/lipsync/text-to-visemes');
            const lang: TtsLang = this.audioVoiceId.startsWith('es') ? 'es' : 'en';
            const events = this.audioTranscript.trim()
                ? textToVisemes(this.audioTranscript.trim(), lang)
                : [];
            const lipsyncFrames = events.length ? scaleTimeline(events, 0, durationSec) : [];

            const audioEntry: AudioEntry = { id: this.recording.id, ttsAudioData: arrayBuffer };
            await this.store.saveAudio(audioEntry);

            const attachment: VoiceAttachment = {
                transcript: this.audioTranscript.trim() || undefined,
                transcriptConfirmed: this.audioTranscript.trim().length > 0,
                ttsAudioDurationSec: durationSec,
                lipsyncFrames,
                voiceId: this.audioVoiceId,
                provider: 'piper',
                rawAudioMimeType: file.type || 'audio/*',
            };
            const updated: MotionRecording = {
                ...this.recording,
                voiceAttachment: attachment,
                updatedAt: Date.now(),
            };
            await this.store.save(updated);
            this.audioToast.set('ok');
            this.saved.emit(updated);
            setTimeout(() => this.audioToast.set(null), 2500);
        } catch (e) {
            console.error('[gesture-detail] onAudioFileSelected failed:', e);
            this.audioToast.set('err');
        } finally {
            // Reset the file input so the same file can be re-selected later
            if (this.fileInputRef) this.fileInputRef.nativeElement.value = '';
        }
    }

    /** Remove audio from this gesture, keeping all motion keyframes intact. */
    async deleteAudio(): Promise<void> {
        if (!this.recording) return;
        this.audioToast.set(null);
        try {
            await this.store.deleteAudio(this.recording.id);
            const { voiceAttachment: _va, ...rest } = this.recording;
            const updated: MotionRecording = { ...rest, updatedAt: Date.now() };
            await this.store.save(updated);
            this.audioToast.set('deleted');
            this.saved.emit(updated);
            setTimeout(() => this.audioToast.set(null), 2500);
        } catch (e) {
            console.error('[gesture-detail] deleteAudio failed:', e);
            this.audioToast.set('err');
        }
    }

    async fork(): Promise<void> {
        if (!this.recording?.compiledGesture) return;
        const forked: MotionRecording = {
            ...this.recording,
            id: crypto.randomUUID(),
            label: `${this.editLabel}_fork`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            compiledGesture: {
                ...this.recording.compiledGesture,
                id: `custom_${this.editLabel}_fork`,
            },
        };
        await this.store.save(forked);
        this.saved.emit(forked);
    }
}
