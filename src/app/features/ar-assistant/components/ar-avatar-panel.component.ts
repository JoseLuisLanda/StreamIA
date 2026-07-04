import { Component, Input, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AvatarTtsComponent } from '../../../components/avatar-tts/avatar-tts.component';
import { TtsLipsyncService } from '../../../services/tts-lipsync.service';

/**
 * Avatar + karaoke subtitle + contextual chips (mockup layout v2): a bottom
 * BAR with proper margins -- avatar PiP at the left, subtitle bubble CENTERED
 * in the remaining space (an invisible right spacer mirrors the avatar width
 * so the bubble centers relative to the SCREEN), chips centered underneath.
 *
 * The <app-avatar-tts> canvas mounts ONCE and is never recreated. FASE 2
 * wires ConversationService onto this same layout.
 */
@Component({
  selector: 'app-ar-avatar-panel',
  standalone: true,
  imports: [CommonModule, AvatarTtsComponent],
  template: `
    <div class="bottombar">
      <div class="fig" [class.talking]="speaking()">
        <app-avatar-tts [avatarUrl]="avatarUrl" [compact]="true"></app-avatar-tts>
      </div>
      <div class="bubble" *ngIf="subtitle">
        <p class="sub">
          <span class="done">{{ revealed() }}</span><span class="rest">{{ pending() }}</span>
        </p>
      </div>
    </div>

    <div class="chips" *ngIf="chips.length">
      <button class="chip" *ngFor="let c of chips" disabled title="Disponible en la Fase 2">{{ c }}</button>
    </div>
  `,
  styles: [`
    :host { display: block; position: absolute; inset: 0; pointer-events: none; }
    /* Mockup composition: half-body avatar (TRANSPARENT, no frame) standing
       right BESIDE the subtitle box; the avatar+bubble group is centered. */
    .bottombar { position: absolute; left: 20px; right: 20px; bottom: calc(env(safe-area-inset-bottom) + 104px);
      display: flex; align-items: flex-end; justify-content: center; gap: 10px; pointer-events: none; }
    .fig { flex: none; width: 118px; height: 172px; position: relative; pointer-events: auto;
      background: transparent; }
    .fig.talking { filter: drop-shadow(0 0 14px rgba(182,232,74,.45)); }
    .fig app-avatar-tts { position: absolute; inset: 0; }
    /* The shared avatar-tts component paints a #222 backdrop for the
       text-avatar page; here the camera must show through. ::ng-deep is
       required (view encapsulation blocks styling child internals). */
    .fig ::ng-deep .canvas-container { background: transparent !important; }
    .bubble { pointer-events: auto; max-width: min(640px, calc(100% - 150px)); margin-bottom: 14px;
      background: rgba(10,14,20,.6); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,.16);
      border-radius: 16px; padding: 12px 18px; }
    .sub { margin: 0; font-size: 13.5px; line-height: 1.5; color: #e6e8ee; font-family: 'Segoe UI', system-ui, sans-serif; }
    .sub .done { color: #ffffff; }
    .sub .rest { color: rgba(230,232,238,.4); }
    .chips { position: absolute; left: 20px; right: 20px; bottom: calc(env(safe-area-inset-bottom) + 56px);
      display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; pointer-events: auto; }
    .chip { padding: 7px 16px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
      background: rgba(10,14,20,.5); backdrop-filter: blur(8px); color: #6ee7b7;
      border: 1px solid rgba(110,231,183,.5); font-family: 'Segoe UI', system-ui, sans-serif; }
    .chip:disabled { opacity: .7; cursor: default; }
    @media (max-width: 640px) { .fig { width: 96px; height: 140px; } }
  `],
})
export class ArAvatarPanelComponent {
  @Input() avatarUrl = '';
  /** Full subtitle text of the current narration (karaoke reveal over it). */
  @Input() subtitle = '';
  /** Contextual chips (static placeholders in FASE 1; wired in FASE 2). */
  @Input() chips: string[] = [];

  private tts = inject(TtsLipsyncService);

  readonly speaking = computed(() => this.tts.state() === 'speaking' || this.tts.state() === 'synthesizing');
  readonly revealed = computed(() => this.subtitle.slice(0, Math.min(this.tts.revealedChars(), this.subtitle.length)));
  readonly pending = computed(() => this.subtitle.slice(Math.min(this.tts.revealedChars(), this.subtitle.length)));
}
