import { Component, inject, OnInit, signal, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AvatarTtsComponent, DEFAULT_AVATAR_URL } from '../../components/avatar-tts/avatar-tts.component';
import { GesturePlayerService } from '../../services/gesture-player.service';
import { VoiceConversionService } from '../../services/voice-conversion.service';
import { TtsLipsyncService } from '../../services/tts-lipsync.service';
import { AudioEntry } from '../../lib/motion/motion.models';
import { MotionCompilerService } from '../../services/motion-compiler.service';
import { MotionStoreService } from '../../services/motion-store.service';
import { MotionRecorderService } from '../../services/motion-recorder.service';
import { CustomGestureRegistryService } from '../../services/custom-gesture-registry.service';
import { MotionRecording } from '../../lib/motion/motion.models';
import { GestureDef, GESTURE_LIBRARY } from '../../lib/gestures/gesture-library';

import { RecordingPanelComponent, RecordingResult } from './components/recording-panel.component';
import { GestureListComponent } from './components/gesture-list.component';
import { MotionTimelineComponent } from './components/motion-timeline.component';
import { GestureDetailComponent } from './components/gesture-detail.component';
import { FaceTrackedAvatarComponent } from './components/face-tracked-avatar.component';

@Component({
    selector: 'app-gesture-studio',
    standalone: true,
    imports: [
        CommonModule, FormsModule, RouterLink,
        AvatarTtsComponent,
        FaceTrackedAvatarComponent,
        RecordingPanelComponent,
        GestureListComponent,
        MotionTimelineComponent,
        GestureDetailComponent,
    ],
    template: `
    <div class="studio">

      <!-- ======= TOP BAR ======= -->
      <header class="topbar">
        <div class="brand">
          <span class="logo">🎭</span>
          <span class="name">Gesture <em>Studio</em></span>
        </div>
        <div class="topctl">
          <div class="avatar-url-row">
            <input class="url-input" type="text" [(ngModel)]="avatarUrlInput"
                   placeholder="Avatar GLB URL…" [value]="avatarUrlInput" />
            <button class="pill-btn" (click)="loadAvatar()">Load</button>
          </div>
          <a routerLink="/text-avatar" class="pill-btn ghost">← Avatar Live</a>
          <a routerLink="/" class="pill-btn ghost">Home</a>
        </div>
      </header>
      <!-- need FormsModule for ngModel on input -->

      <!-- ======= MAIN LAYOUT ======= -->
      <main class="layout">

        <!-- LEFT: Gesture library list -->
        <aside class="col-left">
          <div class="panel-head">Library</div>
          <app-gesture-list
            (builtinSelected)="onBuiltinSelected($event)"
            (customSelected)="onCustomSelected($event)">
          </app-gesture-list>
        </aside>

        <!-- CENTER: Avatar viewport + timeline -->
        <section class="col-center">
          <!-- dual class always active: right panel handles its own loading/denied states -->
          <div class="viewport dual">

            <!-- LEFT panel: idle / playback avatar -->
            <div class="avatar-panel left-panel">
              <div class="glow"></div>
              <app-avatar-tts [avatarUrl]="avatarUrl"></app-avatar-tts>
              <div class="panel-label">Playback</div>

              <!-- Countdown overlay -->
              <div class="countdown" *ngIf="countdown() !== null">
                <span>{{ countdown() }}</span>
              </div>

              <!-- Status badge -->
              <div class="status-badge" *ngIf="statusLabel()">
                {{ statusLabel() }}
              </div>

              <!-- Preview controls -->
              <div class="preview-ctrl">
                <button class="ctrl-btn" (click)="previewSelected()" [disabled]="!canPreview()"
                        title="Preview selected gesture">▶ Preview</button>
                <button class="ctrl-btn ghost" (click)="stopPreview()" title="Stop gesture">⏹</button>
              </div>
            </div>

            <!-- RIGHT panel: face-tracked avatar — always visible, auto-inits camera -->
            <div class="avatar-panel right-panel">
              <app-face-tracked-avatar [avatarUrl]="avatarUrl"></app-face-tracked-avatar>
              <div class="panel-label record-label">
                <span class="rec-indicator" *ngIf="recorder.isRecording()">⏺</span>
                {{ recorder.isRecording() ? 'Recording…' : 'Face Tracking' }}
              </div>
            </div>

          </div>

          <!-- Timeline -->
          <div class="timeline-wrap">
            <app-motion-timeline
              [recording]="selectedRecording()"
              (recompiled)="onRecompiled($event)">
            </app-motion-timeline>
          </div>
        </section>

        <!-- RIGHT: Recording panel + Gesture detail -->
        <aside class="col-right">
          <div class="panel-head">Recording</div>
          <app-recording-panel
            (recordingComplete)="onRecordingComplete($event)">
          </app-recording-panel>

          <div class="divider"></div>

          <div class="panel-head">Detail</div>
          <app-gesture-detail
            [recording]="selectedRecording()"
            (saved)="onSaved($event)"
            (deleted)="onDeleted($event)">
          </app-gesture-detail>
        </aside>

      </main>
    </div>
  `,
    styles: [`
    :host { display:block; height:100vh; overflow:hidden; }
    * { box-sizing:border-box; }
    .studio {
      height:100%; display:flex; flex-direction:column;
      background:#0E0F13; color:#E8E9EE;
      font-family:'Segoe UI', system-ui, -apple-system, sans-serif;
      --accent:#8B5CF6; --accent-soft:rgba(139,92,246,.18);
    }

    /* ---- top bar ---- */
    .topbar {
      display:flex; align-items:center; justify-content:space-between;
      padding:10px 18px; flex:none; border-bottom:1px solid rgba(255,255,255,.06); gap:12px;
    }
    .brand { display:flex; align-items:center; gap:10px; font-size:17px; font-weight:700; }
    .brand .logo { width:32px; height:32px; display:grid; place-items:center; background:var(--accent-soft); border-radius:10px; font-size:16px; }
    .brand em { color:var(--accent); font-style:normal; }
    .topctl { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .avatar-url-row { display:flex; gap:6px; align-items:center; }
    .url-input {
      width:260px; background:rgba(255,255,255,.05); color:#E8E9EE;
      border:1px solid rgba(255,255,255,.1); border-radius:8px; padding:6px 10px; font-size:12px;
    }
    .pill-btn {
      padding:6px 13px; border-radius:8px; border:none; font-size:12px; font-weight:600;
      background:var(--accent); color:#fff; cursor:pointer; text-decoration:none; display:inline-block;
      transition:filter .12s;
    }
    .pill-btn:hover { filter:brightness(1.1); }
    .pill-btn.ghost { background:rgba(255,255,255,.06); color:#ddd; border:1px solid rgba(255,255,255,.1); }
    .pill-btn.ghost:hover { background:rgba(255,255,255,.12); }

    /* ---- three-column layout ---- */
    .layout { flex:1; display:grid; grid-template-columns:220px 1fr 280px; gap:0; min-height:0; overflow:hidden; }

    .col-left {
      border-right:1px solid rgba(255,255,255,.06);
      display:flex; flex-direction:column; overflow:hidden;
      padding:12px 14px;
    }
    .col-center { display:flex; flex-direction:column; min-height:0; }
    .col-right {
      border-left:1px solid rgba(255,255,255,.06);
      display:flex; flex-direction:column; overflow-y:auto;
      padding:12px 14px; gap:6px;
    }
    .panel-head { font-size:10.5px; font-weight:700; color:#8B5CF6; text-transform:uppercase; letter-spacing:.8px; margin-bottom:8px; flex:none; }

    /* ---- avatar viewport ---- */
    .viewport {
      flex:1; display:flex; border-bottom:1px solid rgba(255,255,255,.06); min-height:0; overflow:hidden;
    }

    /* Single avatar mode: left panel takes full width */
    .avatar-panel {
      flex:1; position:relative; overflow:hidden;
      background:radial-gradient(ellipse at 50% 30%,#1a1530 0%,#0a0a0f 70%);
    }

    /* Dual mode: a thin divider between panels */
    .viewport.dual .left-panel {
      border-right:1px solid rgba(255,255,255,.08);
    }

    .avatar-panel app-avatar-tts { position:absolute; inset:0; }
    .avatar-panel app-face-tracked-avatar { position:absolute; inset:0; }

    /* Panel label */
    .panel-label {
      position:absolute; bottom:10px; left:50%; transform:translateX(-50%); z-index:3;
      background:rgba(14,15,19,.75); backdrop-filter:blur(6px);
      border:1px solid rgba(255,255,255,.1); color:#8896a9;
      padding:3px 12px; border-radius:999px; font-size:10.5px; font-weight:600;
      letter-spacing:.5px; text-transform:uppercase; white-space:nowrap;
      pointer-events:none;
    }
    .record-label { border-color:rgba(239,68,68,.35); color:#fca5a5; }
    .rec-indicator { color:#ef4444; animation:recblink .7s step-end infinite; }
    @keyframes recblink { 0%,100%{opacity:1} 50%{opacity:0} }

    .glow {
      position:absolute; left:50%; top:38%; width:320px; height:320px;
      transform:translate(-50%,-50%); pointer-events:none; z-index:1;
      background:radial-gradient(circle,rgba(139,92,246,.38) 0%,rgba(139,92,246,.1) 45%,transparent 70%);
      mix-blend-mode:screen;
    }
    .countdown {
      position:absolute; inset:0; display:grid; place-items:center; z-index:10;
      background:rgba(0,0,0,.55); backdrop-filter:blur(4px);
    }
    .countdown span { font-size:80px; font-weight:800; color:#fff; text-shadow:0 0 40px var(--accent); animation:pop .4s ease-out; }
    @keyframes pop { from { transform:scale(1.4); opacity:0; } to { transform:scale(1); opacity:1; } }
    .status-badge {
      position:absolute; bottom:32px; left:50%; transform:translateX(-50%); z-index:3;
      background:rgba(14,15,19,.8); backdrop-filter:blur(8px);
      border:1px solid rgba(139,92,246,.35); color:#ddd;
      padding:6px 18px; border-radius:999px; font-size:13px; white-space:nowrap;
    }
    .preview-ctrl {
      position:absolute; top:10px; right:10px; z-index:3; display:flex; gap:6px;
    }
    .ctrl-btn {
      padding:6px 14px; border-radius:8px; border:none; font-size:12px; font-weight:600;
      background:rgba(139,92,246,.25); color:#c4b0f7; border:1px solid rgba(139,92,246,.4);
      cursor:pointer; transition:all .12s;
    }
    .ctrl-btn:hover:not(:disabled) { background:rgba(139,92,246,.45); }
    .ctrl-btn:disabled { opacity:.35; cursor:default; }
    .ctrl-btn.ghost { background:rgba(255,255,255,.06); color:#aaa; border-color:rgba(255,255,255,.1); }
    .ctrl-btn.ghost:hover { background:rgba(255,255,255,.12); }

    /* ---- timeline strip ---- */
    .timeline-wrap {
      flex:none; padding:12px 16px; border-top:1px solid rgba(255,255,255,.06);
      max-height:260px; overflow:hidden;
    }

    .divider { height:1px; background:rgba(255,255,255,.07); margin:8px 0; flex:none; }

    @media (max-width:1100px) {
      .layout { grid-template-columns:180px 1fr 240px; }
    }
    @media (max-width:800px) {
      .layout { grid-template-columns:1fr; grid-template-rows:auto 1fr auto; }
      .col-left, .col-right { max-height:220px; overflow-y:auto; }
    }
  `]
})
export class GestureStudioComponent implements OnInit {
    private player = inject(GesturePlayerService);
    private compiler = inject(MotionCompilerService);
    private voiceConv = inject(VoiceConversionService);
    private tts = inject(TtsLipsyncService);
    private store = inject(MotionStoreService);
    private registry = inject(CustomGestureRegistryService);
    readonly recorder = inject(MotionRecorderService);

    avatarUrl = localStorage.getItem('gestureStudio.avatarUrl') || DEFAULT_AVATAR_URL;
    avatarUrlInput = this.avatarUrl;

    readonly selectedRecording = signal<MotionRecording | null>(null);
    readonly countdown = signal<number | null>(null);
    readonly statusLabel = signal<string | null>(null);

    async ngOnInit(): Promise<void> {
        // Registry bootstraps from storage in its constructor.
        // Make sure store is loaded so the gesture-list shows recordings.
        await this.store.load();
    }

    // ---- avatar --------------------------------------------------------------

    loadAvatar(): void {
        const url = this.avatarUrlInput.trim();
        if (!url) return;
        this.avatarUrl = url;
        localStorage.setItem('gestureStudio.avatarUrl', url);
    }

    // ---- list callbacks ------------------------------------------------------

    onBuiltinSelected(def: GestureDef): void {
        // Wrap built-in in a fake MotionRecording so the detail panel shows it read-only
        const fake: MotionRecording = {
            id: def.id,
            label: def.id,
            category: 'mixed',
            duration: 0,
            frameCount: 0,
            fps: 0,
            frames: [],
            compiledGesture: def,
            tags: ['builtin'],
            createdAt: 0,
            updatedAt: 0,
        };
        this.selectedRecording.set(fake);
        // Immediately preview on select
        this.player.trigger(def.id);
        this.showStatus(`Playing: ${def.id}`);
    }

    onCustomSelected(rec: MotionRecording): void {
        this.selectedRecording.set(rec);
        if (rec.compiledGesture) {
            this.player.trigger(rec.compiledGesture.id);
            this.showStatus(`Playing: ${rec.label}`);
        }
    }

    // ---- recording pipeline --------------------------------------------------

    async onRecordingComplete(result: RecordingResult): Promise<void> {
        if (result.frames.length < 2) {
            this.showStatus('Recording too short (< 2 frames) — try again');
            return;
        }
        const tempLabel = `gesture_${Date.now().toString(36)}`;
        const compiled = this.compiler.compile(result.frames, tempLabel, {
            allowMouth: result.channels.mouth,
        });

        if (!compiled.channels.length) {
            this.showStatus('No active channels detected — try moving more');
            return;
        }

        const rec: MotionRecording = {
            id: crypto.randomUUID(),
            label: tempLabel,
            category: this.compiler.detectCategory(compiled.channels),
            duration: result.duration,
            frameCount: result.frames.length,
            fps: result.frames.length / Math.max(0.1, result.duration),
            frames: result.frames,
            compiledGesture: compiled,
            tags: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            voiceAttachment: result.voiceAttachment,
        };

        // Persist audio blobs in audioStore (separate from the recording metadata)
        if (result.rawAudioData || result.ttsAudioData) {
            const audioEntry: AudioEntry = {
                id: rec.id,
                rawAudioData: result.rawAudioData,
                rawAudioMimeType: result.voiceAttachment?.rawAudioMimeType,
                ttsAudioData: result.ttsAudioData,   // ← now properly stored
            };
            await this.store.saveAudio(audioEntry).catch(e => console.warn('[gesture-studio] audio save failed:', e));
        }

        await this.store.save(rec);
        this.registry.register(compiled);

        // store.save() already updated the store.recordings signal
        this.selectedRecording.set(rec);

        // Preview: play gesture + voice if TTS is available
        if (result.ttsAudioData && result.voiceAttachment?.lipsyncFrames?.length) {
            await this.playGestureWithVoice(rec);
            this.showStatus(`Compiled: ${compiled.channels.length} channels — voice preview playing`);
        } else {
            this.player.trigger(compiled.id);
            this.showStatus(`Compiled: ${compiled.channels.length} channels — preview playing`);
        }
    }

    // ---- timeline / detail callbacks ----------------------------------------

    onRecompiled(def: GestureDef): void {
        const rec = this.selectedRecording();
        if (!rec) return;
        const updated: MotionRecording = { ...rec, compiledGesture: def, updatedAt: Date.now() };
        this.selectedRecording.set(updated);
        this.registry.register(def);
        this.player.trigger(def.id);
    }

    onSaved(rec: MotionRecording): void {
        this.selectedRecording.set(rec);
        this.showStatus(`Saved: ${rec.label}`);
    }

    onDeleted(id: string): void {
        if (this.selectedRecording()?.id === id) {
            this.selectedRecording.set(null);
        }
        this.showStatus('Deleted');
    }

    // ---- preview controls ----------------------------------------------------

    previewSelected(): void {
        const rec = this.selectedRecording();
        const id = rec?.compiledGesture?.id;
        if (!id) return;

        if (rec?.voiceAttachment?.lipsyncFrames?.length) {
            // Voice-attached gesture: play audio + lipsync + motion in sync
            this.playGestureWithVoice(rec).catch(e => {
                console.warn('[gesture-studio] voice playback failed, falling back:', e);
                this.player.trigger(id);
            });
            this.showStatus(`Playing: ${rec!.label} (with voice)`);
        } else {
            this.player.trigger(id);
            this.showStatus(`Playing: ${rec!.label}`);
        }
    }

    stopPreview(): void {
        this.player.clear();
        this.statusLabel.set(null);
    }

    canPreview(): boolean {
        return !!this.selectedRecording()?.compiledGesture;
    }

    hasVoice(): boolean {
        const att = this.selectedRecording()?.voiceAttachment;
        return !!(att?.lipsyncFrames?.length);
    }

    // ---- helpers ------------------------------------------------------------


    /** Play a gesture with its attached TTS voice (if any), synchronized. */
    async playGestureWithVoice(rec: MotionRecording): Promise<void> {
        const def = rec.compiledGesture;
        if (!def) return;

        const attachment = rec.voiceAttachment;
        if (attachment?.lipsyncFrames?.length) {
            // Load audio blobs from store
            const entry = await this.store.loadAudio(rec.id);
            if (entry?.ttsAudioData) {
                // Scale gesture duration to TTS audio duration
                if (attachment.ttsAudioDurationSec) {
                    def.cycleDurationSec = attachment.ttsAudioDurationSec;
                }
                // Start lipsync track (plays audio + drives mouth via getMouthWeights)
                await this.tts.playVisemeTrack(entry.ttsAudioData, attachment.lipsyncFrames);
            }
        }
        this.player.trigger(def.id);
    }

    private showStatus(msg: string, durationMs = 3500): void {
        this.statusLabel.set(msg);
        setTimeout(() => this.statusLabel.set(null), durationMs);
    }
}
