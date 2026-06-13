import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MotionRecording } from '../../../lib/motion/motion.models';
import { GestureDef, GestureChannel, GestureKeyframe } from '../../../lib/gestures/gesture-library';
import { MotionCompilerService } from '../../../services/motion-compiler.service';

@Component({
    selector: 'app-motion-timeline',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
    <div class="tl-wrap">
      <!-- Controls row -->
      <div class="tl-bar">
        <span class="tl-title">Timeline — keyframes per channel</span>
        <div class="tl-controls">
          <label class="tl-label">ε (detail)
            <input class="small-range" type="range" min="0.005" max="0.08" step="0.005"
                   [(ngModel)]="epsilon" (ngModelChange)="recompile()" />
            <code>{{ epsilon.toFixed(3) }}</code>
          </label>
          <button class="btn ghost sm" (click)="recompile()" [disabled]="!recording">↻ Recompile</button>
        </div>
      </div>

      <!-- No recording selected -->
      <div class="tl-empty" *ngIf="!recording">
        Select or record a gesture to see its timeline.
      </div>

      <!-- No compiled gesture -->
      <div class="tl-empty" *ngIf="recording && !compiled">
        No compiled gesture — click Save to Library in the detail panel first.
      </div>

      <!-- Channel table -->
      <div class="tl-scroll" *ngIf="compiled">
        <table class="kf-table">
          <thead>
            <tr>
              <th class="ch-name">Channel</th>
              <th class="ch-type">Type</th>
              <th class="ch-kf">Keyframes (t → v)</th>
              <th class="ch-peak">Peak |v|</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let ch of compiled.channels" [class.bone-row]="ch.type === 'bone'">
              <td class="ch-name-cell">
                <span class="type-dot" [class.morph]="ch.type === 'morph'" [class.bone]="ch.type === 'bone'"></span>
                {{ ch.target }}
              </td>
              <td class="ch-type-cell">{{ ch.type }}</td>
              <td class="ch-kf-cell">
                <span class="kf-chip" *ngFor="let kf of ch.keyframes">
                  {{ kf.t.toFixed(2) }}→{{ kf.v.toFixed(3) }}
                </span>
              </td>
              <td class="ch-peak-cell">{{ peak(ch) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="tl-stats">
          {{ compiled.channels.length }} channels ·
          {{ totalKeyframes() }} keyframes total ·
          {{ recording!.frameCount }} raw frames →
          {{ compression() }}% reduction
        </div>
      </div>
    </div>
  `,
    styles: [`
    .tl-wrap { display:flex; flex-direction:column; gap:8px; min-height:0; }
    .tl-bar { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
    .tl-title { font-size:11.5px; font-weight:700; color:#8B5CF6; text-transform:uppercase; letter-spacing:.7px; }
    .tl-controls { display:flex; align-items:center; gap:12px; }
    .tl-label { display:flex; align-items:center; gap:6px; font-size:11px; color:#99a; }
    .small-range { width:100px; accent-color:#8B5CF6; }
    code { font-size:11px; color:#a78bfa; background:rgba(139,92,246,.12); padding:1px 5px; border-radius:4px; }
    .btn { padding:5px 10px; border-radius:8px; cursor:pointer; font-size:11.5px; transition:all .12s; }
    .ghost { background:rgba(255,255,255,.06); color:#ddd; border:1px solid rgba(255,255,255,.1); }
    .ghost:hover:not(:disabled) { background:rgba(255,255,255,.12); }
    .ghost:disabled { opacity:.4; cursor:default; }
    .sm { padding:4px 9px; }
    .tl-empty { font-size:12px; color:#55607a; padding:20px 0; text-align:center; }
    .tl-scroll { overflow-x:auto; overflow-y:auto; max-height:220px; }
    .kf-table { width:100%; border-collapse:collapse; font-size:11.5px; }
    .kf-table th { text-align:left; color:#66708c; font-weight:600; padding:4px 8px; border-bottom:1px solid rgba(255,255,255,.07); font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; }
    .kf-table td { padding:5px 8px; border-bottom:1px solid rgba(255,255,255,.04); color:#d0d5e0; vertical-align:top; }
    .kf-table tr:hover td { background:rgba(255,255,255,.025); }
    .kf-table tr.bone-row td { color:#93c5fd; }
    .ch-name { min-width:160px; }
    .ch-name-cell { display:flex; align-items:center; gap:6px; font-family:monospace; font-size:11px; }
    .type-dot { width:7px; height:7px; border-radius:50%; flex:none; }
    .type-dot.morph { background:#a78bfa; }
    .type-dot.bone { background:#60a5fa; }
    .ch-kf-cell { max-width:320px; }
    .kf-chip {
      display:inline-block; margin:2px 3px 2px 0; padding:1px 6px;
      background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.1);
      border-radius:4px; font-family:monospace; font-size:10px; color:#c4b0f7; white-space:nowrap;
    }
    .ch-peak-cell { font-family:monospace; font-size:11px; color:#f59e0b; }
    .tl-stats { font-size:10.5px; color:#55607a; margin-top:6px; }
  `]
})
export class MotionTimelineComponent implements OnChanges {
    @Input() recording: MotionRecording | null = null;
    @Output() recompiled = new EventEmitter<GestureDef>();

    private compiler = inject(MotionCompilerService);

    compiled: GestureDef | null = null;
    epsilon = 0.015;

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['recording']) {
            this.compiled = this.recording?.compiledGesture ?? null;
        }
    }

    recompile(): void {
        if (!this.recording || this.recording.frames.length < 2) return;
        const def = this.compiler.compile(
            this.recording.frames,
            this.recording.label || 'gesture',
            { rdpEpsilon: this.epsilon, allowMouth: this.recording.compiledGesture?.allowMouth ?? false }
        );
        this.compiled = def;
        this.recompiled.emit(def);
    }

    peak(ch: GestureChannel): string {
        const p = ch.keyframes.reduce((m, k) => Math.max(m, Math.abs(k.v)), 0);
        return p.toFixed(3);
    }

    totalKeyframes(): number {
        return this.compiled?.channels.reduce((s, ch) => s + ch.keyframes.length, 0) ?? 0;
    }

    compression(): string {
        if (!this.recording || this.recording.frameCount === 0) return '0';
        const raw = this.recording.frameCount * (this.compiled?.channels.length ?? 1);
        const compressed = this.totalKeyframes();
        return raw > 0 ? (((raw - compressed) / raw) * 100).toFixed(0) : '0';
    }
}
