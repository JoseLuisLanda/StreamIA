import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ArSceneService, ArSceneMode } from './services/ar-scene.service';
import { ArPanelShellComponent } from './components/ar-panel-shell.component';
import { ArMediaPanelComponent, MediaPanelItem } from './components/ar-media-panel.component';
import { ArAvatarPanelComponent } from './components/ar-avatar-panel.component';
import { ArMapPanelComponent } from './components/ar-map-panel.component';
import { ArContentService } from '../../services/ar-content.service';
import { AssistantConfigService } from '../../services/assistant-config.service';
import { AvatarService } from '../../services/avatar.service';
import { TtsLipsyncService, TtsLang } from '../../services/tts-lipsync.service';
import { ArElement } from '../../lib/ar/ar.models';
import { AssistantConfig } from '../../lib/rag/rag.models';

/**
 * /ar-assistant viewer page (FASE 1). Route: authGuard; deep link params:
 *   ?element={id}   -> MARKER mode (QR flow): load that element, prefetch its
 *                      assets, build the .patt marker scene, "point at marker".
 *   ?assistant={id} -> assistant override (else element.assistantId; else first
 *                      arMode assistant).
 * No element param  -> GPS exploration mode with all published GPS elements.
 *
 * Layer stack (bottom -> top): AR scene (camera) -> avatar canvas (inside the
 * center panel) -> panel shell -> status bar. Cleanup on exit releases camera,
 * GPS watch, wake lock and the scene; the avatar canvas dies with the panel
 * (its engine services are root singletons and remain warm).
 *
 * FASE 1 avatar behavior (decision F1-3): TTS smoke test -- on the first
 * markerFound of an element the avatar speaks a fixed narration built from the
 * element's name/context, with lipsync + karaoke subtitle. FASE 2 replaces the
 * fixed phrase with chatRag narration via ConversationService.
 */
@Component({
  selector: 'app-ar-assistant-page',
  standalone: true,
  imports: [CommonModule, ArPanelShellComponent, ArMediaPanelComponent, ArAvatarPanelComponent, ArMapPanelComponent],
  template: `
    <div class="stage">
      <!-- Layer 1: AR scene (camera background) -->
      <div #sceneHost id="ar-scene-host" class="scene-host"></div>

      <!-- Status bar -->
      <header class="statusbar">
        <button class="back" (click)="exit()" title="Salir">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <span class="aname">{{ assistant()?.name || 'AR' }}</span>
        <span class="chip mode">{{ scene.mode() === 'marker' ? 'Marcador' : 'Exploracion' }}</span>
        <span class="chip state" [class.on]="scene.activeElementId()">{{ stateLabel() }}</span>
      </header>

      <!-- Overlays by phase -->
      <div class="phase" *ngIf="phase() === 'loading'"><span class="spin"></span><p>Preparando visor...</p></div>

      <div class="phase" *ngIf="phase() === 'downloading'">
        <span class="spin"></span>
        <p>Descargando contenido de "{{ element()?.name }}"...</p>
        <p class="mini" *ngIf="scene.prefetch() as pf">{{ pf.done }} / {{ pf.total }}</p>
      </div>

      <div class="phase soft" *ngIf="phase() === 'point'">
        <div class="pointcard">
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z M20 14v0 M14 20h0 M20 20v0"/></svg>
          <b>Contenido listo</b>
          <p>Apunta la camara a la imagen del marcador para ver "{{ element()?.name }}".</p>
        </div>
      </div>

      <div class="phase" *ngIf="phase() === 'error'">
        <p class="err">{{ error() }}</p>
        <button class="btn" (click)="exit()">Volver</button>
      </div>

      <!-- Layer 3: panel carousel (media | avatar | map) -->
      <app-ar-panel-shell *ngIf="phase() === 'live' || phase() === 'point'">
        <app-ar-media-panel panel-media
          [title]="activeElementName()"
          [items]="mediaItems()"
          (pick)="onPickAsset($event)"></app-ar-media-panel>

        <app-ar-avatar-panel panel-avatar
          [avatarUrl]="avatarUrl()"
          [subtitle]="subtitle()"
          [chips]="chips()"></app-ar-avatar-panel>

        <app-ar-map-panel panel-map
          [elements]="gpsElements()"
          (elementFocus)="onMapFocus($event)"></app-ar-map-panel>
      </app-ar-panel-shell>
    </div>
  `,
  styles: [`
    :host { display: block; position: fixed; inset: 0; background: #000; z-index: 10; }
    .stage { position: absolute; inset: 0; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif; }
    .scene-host { position: absolute; inset: 0; }
    /* AR.js injects a fixed <video>; keep our layers above it. */
    .statusbar { position: absolute; top: max(10px, env(safe-area-inset-top)); left: 10px; right: 10px; z-index: 40;
      display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 14px;
      background: rgba(10,14,20,.5); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,.15);
      color: #e6e8ee; pointer-events: auto; }
    .back { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; cursor: pointer;
      background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.15); color: #e6e8ee; }
    .aname { font-weight: 700; font-size: 14.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip { font-size: 10.5px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(255,255,255,.25); color: #cbd0da; }
    .chip.state.on { border-color: rgba(110,231,183,.6); color: #6ee7b7; }
    .phase { position: absolute; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 12px; color: #e6e8ee; background: rgba(0,0,0,.55); text-align: center; padding: 24px; }
    .phase.soft { background: transparent; pointer-events: none; justify-content: flex-start; padding-top: 90px; z-index: 35; }
    .phase p { margin: 0; font-size: 14px; }
    .mini { font-size: 12px; color: #9aa; }
    .err { color: #ff9c9c; max-width: 420px; line-height: 1.5; }
    .btn { padding: 10px 18px; border-radius: 10px; cursor: pointer; background: #8b5cf6; border: 1px solid #8b5cf6; color: #fff; font-size: 14px; }
    .spin { width: 28px; height: 28px; border: 3px solid rgba(255,255,255,.2); border-top-color: #8b5cf6; border-radius: 50%; animation: sp 1s linear infinite; }
    @keyframes sp { to { transform: rotate(360deg); } }
    .pointcard { pointer-events: auto; display: flex; flex-direction: column; align-items: center; gap: 6px;
      background: rgba(10,14,20,.65); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,.18);
      border-radius: 16px; padding: 16px 20px; max-width: 320px; color: #e6e8ee; }
    .pointcard b { font-size: 15px; }
    .pointcard p { font-size: 12.5px; color: #b8bfcc; line-height: 1.5; }
    .pointcard svg { color: #8b5cf6; }
  `],
})
export class ArAssistantPageComponent implements OnInit, OnDestroy {
  readonly scene = inject(ArSceneService);
  private content = inject(ArContentService);
  private assistants = inject(AssistantConfigService);
  private avatars = inject(AvatarService);
  private tts = inject(TtsLipsyncService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly phase = signal<'loading' | 'downloading' | 'point' | 'live' | 'error'>('loading');
  readonly error = signal('');
  readonly element = signal<ArElement | null>(null);       // deep-linked (marker mode)
  readonly gpsElements = signal<ArElement[]>([]);          // published GPS elements
  readonly assistant = signal<AssistantConfig | null>(null);
  readonly avatarUrl = signal('');
  readonly subtitle = signal('');
  readonly chips = signal<string[]>([]);

  /** Element whose media the left panel shows: marker deep link > tracked > map focus. */
  readonly focusedElementId = signal<string | null>(null);

  private offScene: (() => void) | null = null;
  private wakeLock: any = null;
  private narratedOnce = new Set<string>();

  readonly stateLabel = computed(() =>
    this.scene.activeElementId() ? 'Contenido detectado' : (this.phase() === 'point' ? 'Buscando marcador' : 'Explorando'),
  );

  readonly activeElementName = computed(() => {
    const id = this.currentFocus();
    if (!id) return '';
    return this.element()?.id === id
      ? this.element()!.name
      : this.gpsElements().find((e) => e.id === id)?.name ?? '';
  });

  readonly mediaItems = computed<MediaPanelItem[]>(() => {
    const id = this.currentFocus();
    if (!id) return [];
    const sel = this.scene.selectedAsset()[id];
    return this.scene.preparedFor(id).map((pa) => ({ asset: pa.asset, url: pa.url, selected: pa.asset.id === sel }));
  });

  private currentFocus(): string | null {
    return this.scene.activeElementId() ?? this.focusedElementId() ?? this.element()?.id ?? null;
  }

  async ngOnInit(): Promise<void> {
    const qp = this.route.snapshot.queryParamMap;
    const elementId = qp.get('element');
    const assistantParam = qp.get('assistant');
    void this.requestWakeLock();

    try {
      await this.scene.loadScripts();
      if (elementId) await this.initMarkerMode(elementId, assistantParam);
      else await this.initGpsMode(assistantParam);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
      this.phase.set('error');
      return;
    }

    // Scene event bus -> narration smoke test + media focus.
    this.offScene = this.scene.on((ev) => {
      if (ev.type === 'markerFound') {
        this.focusedElementId.set(ev.elementId);
        this.phase.set('live');
        this.smokeNarrate(ev.elementId);
      } else if (ev.type === 'markerLost') {
        // Graceful: narration in progress finishes (never cut mid-sentence).
        if (this.scene.mode() === 'marker') this.phase.set('point');
      } else if (ev.type === 'assetTap') {
        this.focusedElementId.set(ev.elementId);
      }
    });
  }

  private async initMarkerMode(elementId: string, assistantParam: string | null): Promise<void> {
    const el = await this.content.getElement(elementId);
    if (!el || !el.enabled) throw new Error('El contenido no existe o no esta publicado.');
    this.element.set(el);
    await this.loadAssistant(assistantParam || el.assistantId);

    this.phase.set('downloading');
    await this.scene.prefetchElement(el);

    const host = document.getElementById('ar-scene-host')!;
    await this.scene.buildScene(host, 'marker' as ArSceneMode, [el]);
    // Also surface published GPS elements on the map panel for context.
    this.gpsElements.set((await this.content.listPublished()).filter((e) => e.markerType === 'gps' && !!e.geo));
    this.phase.set('point');
  }

  private async initGpsMode(assistantParam: string | null): Promise<void> {
    const published = await this.content.listPublished();
    const gps = published.filter((e) => e.markerType === 'gps' && !!e.geo);
    this.gpsElements.set(gps);
    await this.loadAssistant(assistantParam);

    await this.scene.prepareElements(gps);
    const host = document.getElementById('ar-scene-host')!;
    await this.scene.buildScene(host, 'gps' as ArSceneMode, gps);
    this.phase.set('live');
  }

  private async loadAssistant(assistantId: string | null): Promise<void> {
    let cfg: AssistantConfig | null = null;
    if (assistantId) cfg = await this.assistants.load(assistantId);
    if (!cfg) {
      const all = await this.assistants.listAssistants();
      cfg = all.find((a) => a.arMode) ?? all[0] ?? null;
    }
    if (!cfg) return;
    if (!cfg.arMode) console.warn('[ar-assistant] assistant sin arMode activo:', cfg.id);
    this.assistant.set(cfg);
    this.chips.set(['Precios?', 'Amenidades?', 'Ver video']);
    try {
      this.avatarUrl.set(await this.avatars.resolveModelUrl(cfg.avatarId));
    } catch (e) {
      console.warn('[ar-assistant] avatar no resuelto:', e);
    }
  }

  /** FASE 1 smoke test: fixed narration with lipsync + karaoke on first sight. */
  private smokeNarrate(elementId: string): void {
    if (this.narratedOnce.has(elementId)) return;
    const el = this.element()?.id === elementId
      ? this.element()!
      : this.gpsElements().find((e) => e.id === elementId);
    if (!el) return;
    this.narratedOnce.add(elementId);
    const cfg = this.assistant();
    const text = (el.narrationContext || '').trim()
      || `He detectado un objeto 3D en tu entorno. Este es ${el.name}. ${el.description || ''}`.trim();
    this.subtitle.set(text);
    void this.tts.speak(text, {
      provider: 'piper',
      lang: ((cfg?.language === 'en' ? 'en' : 'es') as TtsLang),
      voiceId: cfg?.voice || undefined,
      singlePass: true,
    }).catch((e) => console.warn('[ar-assistant] narracion fallo:', e));
  }

  onPickAsset(assetId: string): void {
    const id = this.currentFocus();
    if (id) this.scene.showAsset(id, assetId);
  }

  onMapFocus(elementId: string): void {
    this.focusedElementId.set(elementId);
  }

  private async requestWakeLock(): Promise<void> {
    try {
      this.wakeLock = await (navigator as any).wakeLock?.request?.('screen');
    } catch { /* unsupported / denied -> non-fatal */ }
  }

  exit(): void {
    void this.router.navigate(['/assistants']);
  }

  ngOnDestroy(): void {
    this.offScene?.();
    this.tts.stop();
    this.scene.destroy();
    try { this.wakeLock?.release?.(); } catch { /* released */ }
    this.wakeLock = null;
  }
}
