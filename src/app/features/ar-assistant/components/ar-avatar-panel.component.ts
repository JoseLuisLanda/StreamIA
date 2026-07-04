import { Component, Input, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AvatarTtsComponent } from '../../../components/avatar-tts/avatar-tts.component';
import { TtsLipsyncService } from '../../../services/tts-lipsync.service';

/**
 * CENTER panel (default): the talking avatar, mockup layout (AlexIA design):
 * avatar PiP bubble bottom-left + karaoke subtitle bubble + contextual chips.
 *
 * The <app-avatar-tts> canvas mounts ONCE here and is never recreated (panel
 * switches only translate this panel off-screen). In FASE 1 it idles (blink/
 * breath from the engine) and runs the marker smoke-test narration the page
 * triggers via TtsLipsyncService; the karaoke reveal binds to revealedChars.
 * FASE 2 wires ConversationService/chatRag onto this same layout.
 */
@Component({
  selector: 'app-ar-avatar-panel',
  standalone: true,
  imports: [CommonModule, AvatarTtsComponent],
  template: `
    <div class="pip" [class.talking]="speaking()">
      <app-avatar-tts [avatarUrl]="avatarUrl" [compact]="true"></app-avatar-tts>
    </div>

    <div class="bubble" *ngIf="subtitle">
      <p class="sub">
        <span class="done">{{ revealed() }}</span><span class="rest">{{ pending() }}</span>
      </p>
    </div>

    <div class="chips" *ngIf="chips.length">
      <button class="chip" *ngFor="let c of chips" disabled title="Disponible en la Fase 2">{{ c }}</button>
    </div>
  `,
  styles: [`
    :host { display: block; position: absolute; inset: 0; pointer-events: none; }
    .pip { position: absolute; left: 14px; bottom: calc(env(safe-area-inset-bottom) + 96px);
      width: 96px; height: 96px; border-radius: 50%; overflow: hidden; pointer-events: auto;
      border: 2px solid rgba(139,92,246,.65); box-shadow: 0 4px 24px rgba(0,0,0,.45);
      background: radial-gradient(circle at 50% 30%, rgba(139,92,246,.35), rgba(10,14,20,.9)); }
    .pip.talking { border-color: #b6e84a; }
    .pip app-avatar-tts { position: absolute; inset: 0; }
    .bubble { position: absolute; left: 120px; right: 14px; bottom: calc(env(safe-area-inset-bottom) + 104px);
      background: rgba(10,14,20,.6); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,.16);
      border-radius: 16px; padding: 10px 14px; pointer-events: auto; }
    .sub { margin: 0; font-size: 13.5px; line-height: 1.45; color: #e6e8ee; font-family: 'Segoe UI', system-ui, sans-serif; }
    .sub .done { color: #ffffff; }
    .sub .rest { color: rgba(230,232,238,.4); }
    .chips { position: absolute; left: 0; right: 0; bottom: calc(env(safe-area-inset-bottom) + 62px);
      display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; pointer-events: auto; }
    .chip { padding: 7px 14px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
      background: rgba(10,14,20,.5); backdrop-filter: blur(8px); color: #6ee7b7;
      border: 1px solid rgba(110,231,183,.5); }
    .chip:disabled { opacity: .7; cursor: default; }
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
  /** Karaoke split driven by the TTS engine's revealedChars signal. */
  readonly revealed = computed(() => this.subtitle.slice(0, Math.min(this.tts.revealedChars(), this.subtitle.length)));
  readonly pending = computed(() => this.subtitle.slice(Math.min(this.tts.revealedChars(), this.subtitle.length)));
}
