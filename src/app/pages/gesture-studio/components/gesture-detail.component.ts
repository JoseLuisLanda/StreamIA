import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MotionRecording, RecordingCategory, VoiceAttachment } from '../../../lib/motion/motion.models';
import { GestureDef, GESTURE_LIBRARY, EasingType } from '../../../lib/gestures/gesture-library';
import { GesturePlayerService } from '../../../services/gesture-player.service';
import { MotionStoreService } from '../../../services/motion-store.service';
import { CustomGestureRegistryService } from '../../../services/custom-gesture-registry.service';
import { MotionCompilerService } from '../../../services/motion-compiler.service';

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


      <!-- Voice attachment summary -->
      <ng-container *ngIf="recording && recording.voiceAttachment">
        <div class="section-sep"></div>
        <div class="voice-section">
          <div class="voice-head">🎙 Voice</div>
          <div class="voice-row" *ngIf="recording.voiceAttachment.transcript">
            <span class="voice-label">Transcript:</span>
            <span class="voice-val">{{ recording.voiceAttachment.transcript }}</span>
          </div>
          <div class="voice-row" *ngIf="recording.voiceAttachment.ttsAudioDurationSec">
            <span class="voice-label">TTS duration:</span>
            <span class="voice-val">{{ recording.voiceAttachment.ttsAudioDurationSec.toFixed(2) }}s
              (gesture: {{ recording.duration.toFixed(2) }}s)</span>
          </div>
          <div class="voice-row" *ngIf="recording.voiceAttachment.voiceId">
            <span class="voice-label">Voice:</span>
            <span class="voice-val">{{ recording.voiceAttachment.voiceId }}</span>
          </div>
          <div class="voice-row" *ngIf="!recording.voiceAttachment.transcriptConfirmed">
            <span class="voice-warn">⚠ Transcript not confirmed — re-synthesize to attach audio</span>
          </div>
        </div>
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
  `]
})
export class GestureDetailComponent implements OnChanges {
    @Input() recording: MotionRecording | null = null;
    @Output() deleted = new EventEmitter<string>();
    @Output() saved = new EventEmitter<MotionRecording>();

    private player = inject(GesturePlayerService);
    private store = inject(MotionStoreService);
    private registry = inject(CustomGestureRegistryService);
    private compiler = inject(MotionCompilerService);

    readonly easings = EASING_OPTIONS;

    editLabel = '';
    editCategory: RecordingCategory = 'mixed';
    editAllowMouth = false;
    editEntryEasing: EasingType = 'ease-in-out-cubic';
    editExitEasing: EasingType = 'ease-out-quad';
    editRepetitions = 1;
    editReturnDuration = 0.3;

    saving = signal(false);
    toastMsg = signal<'ok' | 'err' | 'copied' | null>(null);

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
