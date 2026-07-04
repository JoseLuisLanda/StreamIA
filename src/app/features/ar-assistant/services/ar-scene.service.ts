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

  private listeners = new Set<(e: ArSceneEvent) => void>();
  private sceneEl: any = null;
  private hostEl: HTMLElement | null = null;
  private prepared = new Map<string, PreparedElement>();
  private scriptsPromise: Promise<void> | null = null;

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
    this.hostEl = host;
    this.mode.set(mode);
    this.error.set('');

    const scene = document.createElement('a-scene');
    scene.setAttribute('embedded', '');
    scene.setAttribute('vr-mode-ui', 'enabled: false');
    scene.setAttribute('renderer', 'logarithmicDepthBuffer: true; alpha: true');
    // patternRatio MUST match the generated markers (thin frame default 0.9;
    // per-element markerTemplate.patternRatio is authoritative). AR.js takes
    // ONE ratio per scene, so the first pattern element's value wins.
    const ratio = elements.find((e) => e.markerTemplate?.patternRatio)?.markerTemplate?.patternRatio ?? 0.9;
    scene.setAttribute(
      'arjs',
      mode === 'marker'
        ? `sourceType: webcam; detectionMode: mono; patternRatio: ${ratio}; debugUIEnabled: false;`
        : 'sourceType: webcam; debugUIEnabled: false;',
    );

    if (mode === 'marker') {
      for (const el of elements) this.appendMarkerElement(scene, el);
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
    this.sceneReady.set(true);
  }

  /** Marker-mode element: <a-marker type=pattern url=...> + its (hidden) assets. */
  private appendMarkerElement(scene: HTMLElement, el: ArElement): void {
    const prep = this.prepared.get(el.id);
    if (!prep?.patternUrlResolved) {
      console.warn('[ar-scene] element without resolved .patt skipped:', el.id);
      return;
    }
    const marker = document.createElement('a-marker');
    marker.setAttribute('type', 'pattern');
    marker.setAttribute('url', prep.patternUrlResolved);
    marker.setAttribute('emitevents', 'true');
    marker.addEventListener('markerFound', () => {
      this.activeElementId.set(el.id);
      this.emit({ type: 'markerFound', elementId: el.id });
    });
    marker.addEventListener('markerLost', () => {
      if (this.activeElementId() === el.id) this.activeElementId.set(null);
      this.emit({ type: 'markerLost', elementId: el.id });
    });

    const selected = this.selectedAsset()[el.id] ?? prep.assets[0]?.asset.id;
    for (const pa of prep.assets) {
      const ent = this.buildAssetEntity(el, pa);
      ent.setAttribute('visible', pa.asset.id === selected ? 'true' : 'false');
      marker.appendChild(ent);
    }
    if (selected) this.selectedAsset.update((m) => ({ ...m, [el.id]: selected }));
    scene.appendChild(marker);
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
      ent = document.createElement('a-video');
      ent.setAttribute('src', pa.url);
      ent.setAttribute('crossorigin', 'anonymous');
      ent.setAttribute('autoplay', 'true');
      ent.setAttribute('loop', 'true');
      ent.setAttribute('width', '1.6');
      ent.setAttribute('height', '0.9');
    } else {
      ent = document.createElement('a-image');
      ent.setAttribute('src', pa.url);
      ent.setAttribute('crossorigin', 'anonymous');
      ent.setAttribute('width', '1');
      ent.setAttribute('height', '1');
    }
    const s = typeof a.scale === 'number' && a.scale > 0 ? a.scale : 1;
    ent.setAttribute('scale', `${s} ${s} ${s}`);
    const p = a.position ?? { x: 0, y: 0, z: 0 };
    ent.setAttribute('position', `${p.x} ${p.y} ${p.z}`);
    if (a.type === 'model') ent.setAttribute('rotation', '-90 0 0'); // AR.js marker plane convention

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

  private wireTap(ent: HTMLElement, elementId: string, assetId: string): void {
    ent.addEventListener('click', () => this.emit({ type: 'assetTap', elementId, assetId }));
  }

  /** Marker mode: project ONE asset of the element (media-panel selector). */
  showAsset(elementId: string, assetId: string): void {
    this.selectedAsset.update((m) => ({ ...m, [elementId]: assetId }));
    if (!this.sceneEl) return;
    this.sceneEl
      .querySelectorAll(`[data-element-id="${elementId}"]`)
      .forEach((node: any) => {
        node.setAttribute('visible', node.dataset['assetId'] === assetId ? 'true' : 'false');
      });
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
    this.hostEl = null;
    this.sceneReady.set(false);
    this.activeElementId.set(null);
  }

  /** Full teardown on route exit (prepared cache kept per session). */
  destroy(): void {
    this.destroyScene();
    this.listeners.clear();
    this.mode.set(null);
    this.prefetch.set(null);
  }
}
