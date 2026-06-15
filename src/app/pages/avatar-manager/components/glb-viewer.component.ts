import {
  AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy,
  Output, SimpleChanges, ViewChild, inject, signal, NgZone,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
// @ts-ignore - jsm examples are shipped with the three npm package
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildNormalizedRig, RigReport } from '../../../lib/avatars/rig-spec';
import { MOUTH_KEYS } from '../../../lib/lipsync/viseme-map';
import { GESTURE_MAP } from '../../../lib/gestures/gesture-library';
import { AvatarMeshStats } from '../../../lib/avatars/avatar.models';

/** Canonical gesture morphs the built-in gesture library touches (conformance). */
const REQUIRED_GESTURE_MORPHS: string[] = Array.from(
  new Set(
    Array.from(GESTURE_MAP.values()).flatMap((g) =>
      g.channels.filter((c) => c.type === 'morph').map((c) => c.target),
    ),
  ),
);

/**
 * Reusable Three.js GLB preview viewport (orbit/zoom/reset/fullscreen).
 *
 * Reuses the app's GLB loading stack (GLTFLoader) and rig inspection
 * (buildNormalizedRig) so the mesh stats + ARKit conformance shown here match
 * Text-Avatar / Gesture Studio exactly. Emits mesh stats + the RigReport after
 * each load. Pure visual inspection -- no TTS/gesture playback here.
 */
@Component({
  selector: 'app-glb-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="viewer" #host>
      <div #canvasWrap class="canvas-wrap"></div>

      <div class="vp-overlay" *ngIf="state() !== 'ready'">
        <span class="spin" *ngIf="state() === 'loading'"></span>
        <span *ngIf="state() === 'loading'">Rendering preview...</span>
        <span *ngIf="state() === 'empty'">No model loaded</span>
        <span class="err" *ngIf="state() === 'error'">{{ error() }}</span>
      </div>

      <div class="vp-label" *ngIf="state() === 'ready' || state() === 'empty'">
        <div class="vp-title">Main 3D Viewport</div>
        <div class="vp-sub">Real-time GLB Mesh Preview</div>
      </div>

      <div class="vp-controls">
        <button type="button" title="Zoom in" (click)="zoomIn()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3M11 8v6M8 11h6"/></svg>
        </button>
        <button type="button" title="Reset view" (click)="resetView()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <button type="button" title="Fullscreen" (click)="toggleFullscreen()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .viewer { position: relative; width: 100%; height: 100%; min-height: 320px; border-radius: 14px;
      overflow: hidden; background: radial-gradient(ellipse at 50% 35%, #161a2b 0%, #0b0e16 75%);
      border: 1px solid rgba(255,255,255,.08); }
    .canvas-wrap { position: absolute; inset: 0; }
    .canvas-wrap canvas { display: block; width: 100% !important; height: 100% !important; }
    .vp-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 10px;
      align-items: center; justify-content: center; color: #8b93a3; font-size: 13px; }
    .vp-overlay .err { color: #ff9c9c; max-width: 80%; text-align: center; }
    .spin { width: 26px; height: 26px; border: 3px solid rgba(255,255,255,.15); border-top-color: #8b5cf6;
      border-radius: 50%; animation: gvspin 1s linear infinite; }
    @keyframes gvspin { to { transform: rotate(360deg); } }
    .vp-label { position: absolute; left: 0; right: 0; bottom: 14px; text-align: center; pointer-events: none; }
    .vp-title { font-size: 17px; font-weight: 700; color: #e6e8ee; }
    .vp-sub { font-size: 12px; color: #8b93a3; }
    .vp-controls { position: absolute; right: 12px; bottom: 12px; display: flex; gap: 8px; }
    .vp-controls button { width: 34px; height: 34px; display: grid; place-items: center; cursor: pointer;
      border-radius: 9px; background: rgba(20,24,35,.75); border: 1px solid rgba(255,255,255,.12); color: #c4b0f7; }
    .vp-controls button:hover { background: rgba(139,92,246,.25); color: #fff; }
  `]
})
export class GlbViewerComponent implements AfterViewInit, OnChanges, OnDestroy {
  /** GLB download URL to render (null/empty = empty state). */
  @Input() url: string | null = null;

  @Output() meshStats = new EventEmitter<AvatarMeshStats>();
  @Output() rigReport = new EventEmitter<RigReport>();

  @ViewChild('host') host!: ElementRef<HTMLDivElement>;
  @ViewChild('canvasWrap') canvasWrap!: ElementRef<HTMLDivElement>;

  readonly state = signal<'empty' | 'loading' | 'ready' | 'error'>('empty');
  readonly error = signal('');

  private zone = inject(NgZone);
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls: any;
  private model: THREE.Object3D | null = null;
  private raf = 0;
  private ro?: ResizeObserver;
  private initialized = false;

  ngAfterViewInit(): void {
    this.initThree();
    this.initialized = true;
    if (this.url) void this.load(this.url);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['url'] && this.initialized) {
      if (this.url) void this.load(this.url);
      else { this.clearModel(); this.state.set('empty'); }
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.clearModel();
    this.controls?.dispose?.();
    this.renderer?.dispose?.();
  }

  // ------------------------------------------------------------------ three

  private initThree(): void {
    const el = this.canvasWrap.nativeElement;
    const w = el.clientWidth || 600;
    const h = el.clientHeight || 360;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, w / h, 0.05, 100);
    this.camera.position.set(0, 1.5, 3);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    el.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8b5cf6, 0.6);
    rim.position.set(-3, 2, -2);
    this.scene.add(rim);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 12;
    this.controls.target.set(0, 1.3, 0);

    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(el);

    this.zone.runOutsideAngular(() => {
      const tick = () => {
        this.controls?.update();
        this.renderer.render(this.scene, this.camera);
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    });
  }

  private onResize(): void {
    const el = this.canvasWrap.nativeElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private clearModel(): void {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((node: THREE.Object3D) => {
      const mesh = node as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as any;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.model = null;
  }

  private async load(url: string): Promise<void> {
    this.state.set('loading');
    this.error.set('');
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      this.clearModel();
      this.model = gltf.scene;
      this.scene.add(this.model);
      this.frameModel(this.model);
      this.inspect(this.model);
      this.state.set('ready');
    } catch (e: any) {
      this.error.set(e?.message ?? 'Failed to load GLB.');
      this.state.set('error');
    }
  }

  /** Center + scale the camera/controls to frame the model. */
  private frameModel(model: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = maxDim / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.controls.target.copy(center);
    this.camera.position.set(center.x, center.y + size.y * 0.1, center.z + dist * 1.6);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Read mesh stats + ARKit conformance from the loaded scene (reuses rig-spec). */
  private inspect(model: THREE.Object3D): void {
    let vertices = 0;
    let triangles = 0;
    let skinned = false;
    const nodes: Record<string, THREE.Object3D> = {};
    const morphMeshes: { name: string; dict: Record<string, number> }[] = [];

    model.traverse((node: THREE.Object3D) => {
      nodes[node.name] = node;
      if ((node as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
      const mesh = node as THREE.Mesh;
      const geom = mesh.geometry as THREE.BufferGeometry | undefined;
      if (geom && geom.attributes && geom.attributes['position']) {
        const posCount = geom.attributes['position'].count;
        vertices += posCount;
        triangles += geom.index ? geom.index.count / 3 : posCount / 3;
      }
      const m = node as any;
      if (m.morphTargetDictionary && m.morphTargetInfluences) {
        morphMeshes.push({ name: node.name, dict: m.morphTargetDictionary });
      }
    });

    const stats: AvatarMeshStats = {
      vertices,
      polygons: Math.round(triangles),
      skeletonType: skinned ? 'Humanoid (skinned)' : 'Static (no skeleton)',
    };
    this.meshStats.emit(stats);

    const rig = buildNormalizedRig({
      morphMeshes,
      nodes,
      requiredMouthKeys: MOUTH_KEYS,
      requiredGestureMorphs: REQUIRED_GESTURE_MORPHS,
    });
    this.rigReport.emit(rig.report);
  }

  // --------------------------------------------------------------- controls

  zoomIn(): void {
    if (!this.camera || !this.controls) return;
    const dir = new THREE.Vector3().subVectors(this.controls.target, this.camera.position).multiplyScalar(0.2);
    this.camera.position.add(dir);
    this.controls.update();
  }

  resetView(): void {
    if (this.model) this.frameModel(this.model);
  }

  toggleFullscreen(): void {
    const el = this.host?.nativeElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }
}
