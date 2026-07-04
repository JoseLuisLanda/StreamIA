import { Injectable, inject, signal } from '@angular/core';
import { ArContentService } from '../../../services/ar-content.service';
import { ArAsset, ArElement } from '../../../lib/ar/ar.models';

/**
 * AR scene orchestration for the /ar-assistant viewer (FASE 1).
 *
 * Loads A-Frame + aframe-extras + AR.js DYNAMICALLY (vendored under
 * /vendor/, decision F1-2) only when the viewer route is entered, builds the
 * <a-scene> imperatively from published ArElements, and exposes a typed event
 * bus: markerFound / markerLost / assetTap.
 *
 * TWO SCENE MODES (AR.js cannot mix marker tracking and location-based in one
 * scene reliably):
 *  - 'marker': QR deep-link flow. One or more <a-marker type="pattern"> from
 *    the elements' patternUrl; assets anchor on the marker. The selected asset
 *    is chosen via showAsset() (media panel).
 *  - 'gps': exploration flow. gps-camera + gps-entity-place entities floating
 *    at each element's coordinates.
 *
 * IMPORTANT THREE ISOLATION: A-Frame ships its own window.THREE global. The
 * app's three@0.182 is imported as ES modules (module-scoped), so they do not
 * collide; loadScripts() logs both versions to make the isolation visible.
 *
 * Cleanup: destroy() removes the scene, stops the webcam stream AR.js opened,
 * and clears state. The avatar canvas (separate layer) is NEVER touched here.
 */
export type ArSceneMode = 'gps' | 'marker';

export interface ArSceneEvent {
  type: 'markerFound' | 'markerLost' | 'assetTap';
  elementId: string;
  assetId?: string;
}

interface PreparedAsset {
  asset: ArAsset;
  url: string;
}

interface PreparedElement {
  element: ArElement;
  assets: PreparedAsset[];
  patternUrlResolved?: string;
}

@Injectable({ providedIn: 'root' })
export class ArSceneService {
  private content = inject(ArContentService);

  readonly scriptsReady = signal(false);
  readonly sceneReady = signal(false);
  readonly mode = signal<ArSceneMode | null>(null);
  /** Element currently tracked (marker in sight) or focused. */
  readonly activeElementId = signal<string | null>(null);
  /** Asset currently projected per element (marker mode selector). */
  readonly selectedAsset = signal<Record<string, string>>({});
  readonly error = signal('');
  readonly prefetch = signal<{ done: number; total: number } | null>(null);
  /** Markers actually mounted in marker mode (0 = nothing to detect). */
  readonly markerCount = signal(0);

  private listeners = new Set<(e: ArSceneEvent) => void>();
  private sceneEl: any = null;
  private hostEl: HTMLElement | null = null;
  private prepared = new Map<string, PreparedElement>();
  private scriptsPromise: Promise<void> | null = null;
  /** OWNED <video> elements per assetId (playback fully controlled by us --
   *  a-video alone autoplays audio with no selection awareness). */
  private videoEls = new Map<string, HTMLVideoElement>();
  private videoOwner = new Map<string, string>(); // assetId -> elementId
  private assetsEl: HTMLElement | null = null;
  /** Pending markerLost grace timers per element (flap suppression). */
  private lostTimers = new Map<string, any>();
  /** True while the avatar narration (TTS) is speaking: videos play MUTED and
   *  recover their audio when the narration ends. */
  private narrationActive = false;
  /** True after destroy(): late async AR.js init must not resurrect anything. */
  private tearingDown = false;

  /** Vendored builds (public/vendor/ -> served at /vendor/). See README. */
  private static readonly SCRIPTS = [
    '/vendor/aframe.min.js',
    '/vendor/aframe-extras.min.js',
    '/vendor/aframe-ar.js',
  ];

  // ------------------------------------------------------------------- events

  /** Subscribe to scene events. Returns an unsubscribe function. */
  on(cb: (e: ArSceneEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: ArSceneEvent): void {
    for (const cb of this.listeners) {
      try { cb(e); } catch (err) { console.warn('[ar-scene] listener error', err); }
    }
  }

  // ------------------------------------------------------------------ scripts

  /** Load A-Frame -> extras -> AR.js sequentially, once. */
  loadScripts(): Promise<void> {
    if (this.scriptsPromise) return this.scriptsPromise;
    this.scriptsPromise = (async () => {
      for (const src of ArSceneService.SCRIPTS) {
        await this.loadScript(src);
      }
      this.scriptsReady.set(true);
      const globalThree = (window as any).THREE?.REVISION;
      console.info('[ar-scene] A-Frame THREE r' + globalThree + ' (global) loaded; app three stays module-scoped.');
    })().catch((e) => {
      this.scriptsPromise = null;
      const msg = 'No se pudieron cargar las librerias RA (vendor/). ' + (e?.message ?? e);
      this.error.set(msg);
      throw new Error(msg);
    });
    return this.scriptsPromise;
  }

  private loadScript(src: string): Promise<void> {
    if (document.querySelector(`script[data-ar-vendor="${src}"]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false; // preserve order
      s.dataset['arVendor'] = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('fallo ' + src));
      document.head.appendChild(s);
    });
  }

  // ----------------------------------------------------------------- prefetch

  /**
   * Resolve download URLs for an element's assets (+ pattern) and warm the
   * browser cache (QR flow: download BEFORE pointing at the marker). Videos
   * are not fully downloaded (they stream); their URL is resolved only.
   */
  async prefetchElement(el: ArElement): Promise<void> {
    const jobs = el.assets.length + (el.patternUrl ? 1 : 0);
    let done = 0;
    this.prefetch.set({ done, total: jobs });
    const prepared: PreparedElement = { element: el, assets: [] };

    if (el.patternUrl) {
      prepared.patternUrlResolved = (await this.content.resolveUrl(el.patternUrl)) ?? '';
      this.prefetch.set({ done: ++done, total: jobs });
    }
    for (const asset of el.assets) {
      const url = await this.content.resolveUrl(asset.storagePath);
      if (url) {
        if (asset.type !== 'video') {
          try { await fetch(url, { mode: 'cors', cache: 'force-cache' }); } catch { /* warm-cache best effort */ }
        }
        prepared.assets.push({ asset, url });
      }
      this.prefetch.set({ done: ++done, total: jobs });
    }
    this.prepared.set(el.id, prepared);
    this.prefetch.set(null);
  }

  /** Resolve URLs for many elements (gps mode; no byte prefetch). */
  async prepareElements(els: ArElement[]): Promise<void> {
    for (const el of els) {
      if (this.prepared.has(el.id)) continue;
      const prepared: PreparedElement = { element: el, assets: [] };
      for (const asset of el.assets) {
        const url = await this.content.resolveUrl(asset.storagePath);
        if (url) prepared.assets.push({ asset, url });
      }
      if (el.patternUrl) prepared.patternUrlResolved = (await this.content.resolveUrl(el.patternUrl)) ?? '';
      this.prepared.set(el.id, prepared);
    }
  }

  preparedFor(elementId: string): { asset: ArAsset; url: string }[] {
    return this.prepared.get(elementId)?.assets ?? [];
  }

  // -------------------------------------------------------------------- scene

  /** Build the <a-scene> for the given mode inside host. Destroys any previous scene. */
  async buildScene(host: HTMLElement, mode: ArSceneMode, elements: ArElement[]): Promise<void> {
    await this.loadScripts();
    this.destroyScene();
    this.tearingDown = false;
    this.hostEl = host;
    this.mode.set(mode);
    this.error.set('');

    const scene = document.createElement('a-scene');
    // Owned media assets (videos) live here; timeout=1 so a slow video never
    // blocks the scene 'loaded' event.
    const assetsEl = document.createElement('a-assets');
    assetsEl.setAttribute('timeout', '1');
    scene.appendChild(assetsEl);
    this.assetsEl = assetsEl;
    scene.setAttribute('embedded', '');
    scene.setAttribute('vr-mode-ui', 'enabled: false');
    scene.setAttribute('renderer', 'logarithmicDepthBuffer: true; alpha: true');
    // patternRatio MUST match the generated markers (default 0.8; per-element
    // markerTemplate.patternRatio is authoritative). AR.js takes ONE ratio per
    // scene, so the first pattern element's value wins.
    const ratio = elements.find((e) => e.markerTemplate?.patternRatio)?.markerTemplate?.patternRatio ?? 0.8;
    scene.setAttribute(
      'arjs',
      mode === 'marker'
        ? `sourceType: webcam; detectionMode: mono; patternRatio: ${ratio}; debugUIEnabled: false;`
        : 'sourceType: webcam; debugUIEnabled: false;',
    );

    if (mode === 'marker') {
      let mounted = 0;
      for (const el of elements) {
        if (this.appendMarkerElement(scene, el)) mounted++;
      }
      this.markerCount.set(mounted);
      console.info(`[ar-scene] marker scene: ${mounted} marker(s), patternRatio=${ratio}`);
      const cam = document.createElement('a-entity');
      cam.setAttribute('camera', '');
      cam.setAttribute('cursor', 'rayOrigin: mouse');
      cam.setAttribute('raycaster', 'objects: .ar-asset');
      scene.appendChild(cam);
    } else {
      for (const el of elements) this.appendGpsElement(scene, el);
      const cam = document.createElement('a-camera');
      cam.setAttribute('gps-camera', '');
      cam.setAttribute('rotation-reader', '');
      cam.setAttribute('cursor', 'rayOrigin: mouse');
      cam.setAttribute('raycaster', 'objects: .ar-asset');
      scene.appendChild(cam);
    }

    host.appendChild(scene);
    this.sceneEl = scene;
    await new Promise<void>((resolve) => {
      if ((scene as any).hasLoaded) resolve();
      else scene.addEventListener('loaded', () => resolve(), { once: true });
    });
    // Scene canvas above the camera video, below the UI overlays.
    (scene as any).style.position = 'absolute';
    (scene as any).style.inset = '0';
    (scene as any).style.zIndex = '1';
    this.adoptArVideo();
    this.sceneReady.set(true);
  }

  /**
   * CRITICAL VISIBILITY FIX: AR.js appends its <video id="arjs-video"> to
   * <body> with a NEGATIVE z-index. Our viewer page is a fixed, opaque host
   * stacked ABOVE the body, so the camera feed ends up buried underneath
   * (black screen on desktop and mobile). We ADOPT the video into the scene
   * host (inside our stacking context) and style it as the fullscreen
   * background layer. The MediaStream keeps playing across the reparent.
   * AR.js creates the video asynchronously (after the permission grant), so
   * we retry for a few seconds.
   */
  private adoptArVideo(attempt = 0): void {
    if (this.tearingDown) return;
    const host = this.hostEl;
    if (!host) return;
    const video = document.getElementById('arjs-video') as HTMLVideoElement | null;
    if (!video) {
      if (attempt < 40) setTimeout(() => this.adoptArVideo(attempt + 1), 250);
      return;
    }
    if (video.parentElement !== host) host.insertBefore(video, host.firstChild);
    this.styleArVideo(video);
    // CRITICAL: do NOT override the video's size/margins/object-fit. AR.js
    // sizes the camera video AND the 3D canvas as a MATCHED PAIR (cover via
    // computed size + negative margins); forcing our own cover on the video
    // alone desynchronizes them and the whole 3D projection renders
    // horizontally STRETCHED. We only fix stacking here and ask AR.js to
    // recompute for the current viewport.
    window.dispatchEvent(new Event('resize'));
    console.info('[ar-scene] arjs-video adopted into the scene host');
  }

  private styleArVideo(video: HTMLVideoElement): void {
    video.style.position = 'absolute';
    video.style.zIndex = '0';
    video.setAttribute('playsinline', '');
  }

  /** Marker-mode element: <a-marker type=pattern url=...> + its (hidden)
   *  assets. Returns false when the .patt could not be resolved (caller
   *  surfaces the problem instead of searching forever in silence). */
  private appendMarkerElement(scene: HTMLElement, el: ArElement): boolean {
    const prep = this.prepared.get(el.id);
    if (!prep?.patternUrlResolved) {
      console.warn('[ar-scene] element without resolved .patt skipped:', el.id, el.patternUrl);
      return false;
    }
    // Diagnostic: verify the .patt is fetchable + looks like a pattern file.
    void fetch(prep.patternUrlResolved).then(async (r) => {
      const head = (await r.text()).slice(0, 60).replace(/\n/g, ' ');
      console.info(`[ar-scene] .patt ${el.id}: HTTP ${r.status}, head="${head}..."`);
    }).catch((e) => console.error('[ar-scene] .patt fetch FAILED', el.id, e));

    const marker = document.createElement('a-marker');
    marker.setAttribute('type', 'pattern');
    marker.setAttribute('url', prep.patternUrlResolved);
    marker.setAttribute('emitevents', 'true');
    // Tracking FLAP suppression: raw found/lost fires every frame hiccup
    // (thin border + camera noise), which would pause videos and flip the UI
    // constantly. A markerLost only takes effect if the marker is NOT re-found
    // within LOST_GRACE_MS; a re-found inside the grace window is swallowed.
    const LOST_GRACE_MS = 800;
    marker.addEventListener('markerFound', () => {
      const pending = this.lostTimers.get(el.id);
      if (pending) {
        clearTimeout(pending);
        this.lostTimers.delete(el.id);
        return; // flap: we never announced the loss, so nothing to re-announce
      }
      console.info('[ar-scene] markerFound', el.id);
      this.activeElementId.set(el.id);
      this.syncVideoPlayback(el.id);
      this.emit({ type: 'markerFound', elementId: el.id });
    });
    marker.addEventListener('markerLost', () => {
      if (this.lostTimers.has(el.id)) return;
      const t = setTimeout(() => {
        this.lostTimers.delete(el.id);
        console.info('[ar-scene] markerLost (stable)', el.id);
        if (this.activeElementId() === el.id) this.activeElementId.set(null);
        this.syncVideoPlayback(el.id);
        this.emit({ type: 'markerLost', elementId: el.id });
      }, LOST_GRACE_MS);
      this.lostTimers.set(el.id, t);
    });

    const selected = this.selectedAsset()[el.id] ?? prep.assets[0]?.asset.id;
    for (const pa of prep.assets) {
      const ent = this.buildAssetEntity(el, pa);
      ent.setAttribute('visible', pa.asset.id === selected ? 'true' : 'false');
      marker.appendChild(ent);
    }
    if (selected) this.selectedAsset.update((m) => ({ ...m, [el.id]: selected }));
    scene.appendChild(marker);
    return true;
  }

  /** GPS-mode element: each asset floats at the element's coordinates. */
  private appendGpsElement(scene: HTMLElement, el: ArElement): void {
    const prep = this.prepared.get(el.id);
    if (!el.geo || !prep) return;
    const place = `latitude: ${el.geo.lat}; longitude: ${el.geo.lng};`;
    for (const pa of prep.assets) {
      const ent = this.buildAssetEntity(el, pa);
      ent.setAttribute('gps-entity-place', place);
      // Floating scale boost so distant content is visible while approaching.
      ent.setAttribute('look-at', '[gps-camera]');
      scene.appendChild(ent);
    }
    this.syncVideoPlayback(el.id);
  }

  /** One asset -> A-Frame entity (model/video/image) with animation config. */
  private buildAssetEntity(el: ArElement, pa: PreparedAsset): HTMLElement {
    const a = pa.asset;
    let ent: HTMLElement;
    if (a.type === 'model') {
      ent = document.createElement('a-entity');
      ent.setAttribute('gltf-model', `url(${pa.url})`);
      const anim = a.animation;
      if (anim?.autoplay !== false) {
        const clip = (anim?.clip || '*').trim() || '*';
        ent.setAttribute('animation-mixer', `clip: ${clip}; loop: repeat`);
      }
    } else if (a.type === 'video') {
      // OWNED video element (in <a-assets>): starts PAUSED + MUTED. Playback
      // is driven by selection + tracking via syncVideoPlayback(), so a
      // non-selected video never leaks audio.
      const vid = document.createElement('video');
      vid.id = 'arvid_' + a.id;
      vid.src = pa.url;
      vid.crossOrigin = 'anonymous';
      vid.loop = true;
      vid.muted = true;
      vid.preload = 'auto';
      vid.setAttribute('playsinline', '');
      vid.setAttribute('webkit-playsinline', '');
      this.assetsEl?.appendChild(vid);
      this.videoEls.set(a.id, vid);
      this.videoOwner.set(a.id, el.id);
      ent = document.createElement('a-video');
      ent.setAttribute('src', '#arvid_' + a.id);
      ent.setAttribute('width', '1.6');
      ent.setAttribute('height', '0.9');
      // Real aspect ratio once metadata arrives (fixed 16:9 stretches others).
      const ventRef = ent;
      vid.addEventListener('loadedmetadata', () => {
        this.applyPlaneAspect(ventRef, vid.videoWidth, vid.videoHeight, 1.6, a.id);
      }, { once: true });
      if (vid.readyState >= 1) this.applyPlaneAspect(ventRef, vid.videoWidth, vid.videoHeight, 1.6, a.id);
    } else {
      ent = document.createElement('a-image');
      ent.setAttribute('src', pa.url);
      ent.setAttribute('crossorigin', 'anonymous');
      ent.setAttribute('width', '1.2');
      ent.setAttribute('height', '1.2');
      // Real aspect ratio via an off-DOM probe (same URL -> browser cache).
      const ientRef = ent;
      const probe = new Image();
      probe.crossOrigin = 'anonymous';
      probe.onload = () => this.applyPlaneAspect(ientRef, probe.naturalWidth, probe.naturalHeight, 1.2, a.id);
      probe.onerror = () => console.warn('[ar-scene] aspect probe failed for image', a.id);
      probe.src = pa.url;
    }
    const s = typeof a.scale === 'number' && a.scale > 0 ? a.scale : 1;
    ent.setAttribute('scale', `${s} ${s} ${s}`);
    const p = a.position ?? { x: 0, y: 0, z: 0 };
    ent.setAttribute('position', `${p.x} ${p.y} ${p.z}`);
    // Marker-space convention: -90 on X lays content flush with the printed
    // marker; the extra 180 about the plane normal makes it read upright on a
    // vertically pasted label. NOTE for future debugging: earlier flip
    // confusion came from comparing builds on DIFFERENT deploys (localhost vs
    // prod) and from first-generation rotationally-ambiguous patterns. Test
    // orientation changes on ONE build, with a kit that has the contrast
    // block printed.
    ent.setAttribute('rotation', a.type === 'model' ? '90 180 0' : '-90 0 180');

    ent.classList.add('ar-asset');
    this.wireTap(ent, el.id, a.id);

    // Trajectory (orbit / line) via the built-in animation component. The
    // OUTERMOST node carries the data attributes so showAsset() can toggle
    // visibility of the whole unit (pivot included).
    const path = a.animation?.path;
    let outer: HTMLElement = ent;
    if (path === 'orbit') {
      const pivot = document.createElement('a-entity');
      pivot.setAttribute('animation', 'property: rotation; to: 0 360 0; loop: true; dur: 12000; easing: linear');
      ent.setAttribute('position', `${(p.x || 0) + 0.6} ${p.y} ${p.z}`);
      pivot.appendChild(ent);
      outer = pivot;
    } else if (path === 'line') {
      ent.setAttribute(
        'animation',
        `property: position; from: ${p.x - 0.6} ${p.y} ${p.z}; to: ${p.x + 0.6} ${p.y} ${p.z}; dir: alternate; loop: true; dur: 6000; easing: easeInOutSine`,
      );
    }
    outer.dataset['elementId'] = el.id;
    outer.dataset['assetId'] = a.id;
    return outer;
  }

  /**
   * Size a plane entity to the media's REAL aspect ratio, capping the LONGEST
   * side at maxSide (so portrait videos don't tower over the marker). Applied
   * both as primitive attributes AND as an explicit geometry component --
   * the latter always updates the mesh at runtime.
   */
  private applyPlaneAspect(node: HTMLElement, natW: number, natH: number, maxSide: number, assetId: string): void {
    if (!natW || !natH) return;
    const r = natW / natH;
    const w = r >= 1 ? maxSide : maxSide * r;
    const h = r >= 1 ? maxSide / r : maxSide;
    node.setAttribute('width', w.toFixed(3));
    node.setAttribute('height', h.toFixed(3));
    node.setAttribute('geometry', `primitive: plane; width: ${w.toFixed(3)}; height: ${h.toFixed(3)}`);
    console.info(`[ar-scene] aspect ${assetId}: ${natW}x${natH} -> plane ${w.toFixed(2)} x ${h.toFixed(2)}`);
  }

  private wireTap(ent: HTMLElement, elementId: string, assetId: string): void {
    ent.addEventListener('click', () => this.emit({ type: 'assetTap', elementId, assetId }));
  }

  /** Narration (TTS) started/ended -> re-apply the video audio policy. */
  setNarrationActive(on: boolean): void {
    if (this.narrationActive === on) return;
    this.narrationActive = on;
    for (const elementId of new Set(this.videoOwner.values())) {
      this.syncVideoPlayback(elementId);
    }
  }

  /** Marker mode: project ONE asset of the element (media-panel selector). */
  showAsset(elementId: string, assetId: string): void {
    console.info('[ar-scene] showAsset', elementId, '->', assetId);
    this.selectedAsset.update((m) => ({ ...m, [elementId]: assetId }));
    if (this.sceneEl) {
      this.sceneEl
        .querySelectorAll(`[data-element-id="${elementId}"]`)
        .forEach((node: any) => {
          node.setAttribute('visible', node.dataset['assetId'] === assetId ? 'true' : 'false');
        });
    }
    this.syncVideoPlayback(elementId);
  }

  /**
   * Video playback policy: a video plays (with sound; muted fallback if the
   * browser blocks it) ONLY while it is the SELECTED asset of a TRACKED
   * element (marker in sight) or of a gps element. Everything else pauses.
   */
  private syncVideoPlayback(elementId: string): void {
    const selected = this.selectedAsset()[elementId];
    const tracking = this.mode() === 'gps' || this.activeElementId() === elementId;
    for (const [assetId, owner] of this.videoOwner) {
      if (owner !== elementId) continue;
      const vid = this.videoEls.get(assetId);
      if (!vid) continue;
      if (this.mode() === 'gps') {
        // GPS mode shows every asset at its anchor: videos loop MUTED
        // (ambient); sound belongs to explicit interactions (FASE 4).
        vid.muted = true;
        vid.play().catch(() => {});
        continue;
      }
      if (tracking && selected === assetId) {
        // AUDIO POLICY: while the avatar narrates, the video runs MUTED and
        // recovers sound when the narration ends (setNarrationActive). An
        // explicit user selection stops the narration first (page side).
        vid.muted = this.narrationActive;
        vid.play().catch(() => {
          vid.muted = true; // autoplay-with-sound blocked -> at least show it
          vid.play().catch(() => {});
        });
      } else {
        vid.pause();
        vid.muted = true;
      }
    }
  }

  // ------------------------------------------------------------------ cleanup

  /** Remove the scene and stop the webcam AR.js opened. */
  destroyScene(): void {
    if (this.sceneEl) {
      try {
        const video: HTMLVideoElement | null = document.querySelector('#arjs-video');
        const stream = video?.srcObject as MediaStream | null;
        stream?.getTracks().forEach((t) => t.stop());
        video?.remove();
      } catch { /* best effort */ }
      try { this.sceneEl.parentNode?.removeChild(this.sceneEl); } catch { /* detached */ }
      this.sceneEl = null;
    }
    for (const t of this.lostTimers.values()) clearTimeout(t);
    this.lostTimers.clear();
    for (const vid of this.videoEls.values()) {
      try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch { /* released */ }
    }
    this.videoEls.clear();
    this.videoOwner.clear();
    this.assetsEl = null;
    this.hostEl = null;
    this.sceneReady.set(false);
    this.activeElementId.set(null);
  }

  /** Full teardown on route exit (prepared cache kept per session). */
  destroy(): void {
    this.tearingDown = true;
    this.destroyScene();
    this.listeners.clear();
    this.mode.set(null);
    this.prefetch.set(null);
    // CAMERA WATCHDOG: if the route is left while AR.js is still initializing
    // (e.g. browser BACK during load), AR.js opens the webcam AFTER this
    // teardown and the stream leaks -- the camera stays busy and the next
    // visit fails with "Timeout starting video source". Sweep for a few
    // seconds and kill any late-created #arjs-video.
    let tries = 0;
    const sweep = () => {
      if (!this.tearingDown) return; // a new scene took over
      const v = document.getElementById('arjs-video') as HTMLVideoElement | null;
      if (v) {
        try {
          (v.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
          v.remove();
          console.info('[ar-scene] watchdog: late camera stream stopped');
        } catch { /* best effort */ }
      }
      if (++tries < 16) setTimeout(sweep, 500);
    };
    sweep();
  }
}
