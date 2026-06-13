import {
    Component, ElementRef, ViewChild, Input,
    AfterViewInit, OnDestroy, OnChanges, SimpleChanges,
    inject, NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FaceTrackingService } from '../../../services/face-tracking.service';
import { ModelCacheService } from '../../../services/model-cache.service';
import { MotionRecorderService } from '../../../services/motion-recorder.service';

@Component({
    selector: 'app-face-tracked-avatar',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div #container class="ft-container">
      <!-- Hidden video element — owned by this component for auto camera init -->
      <video #videoEl style="display:none" playsinline autoplay muted></video>

      <canvas #canvas class="ft-canvas"></canvas>

      <!-- Overlay: initialising / waiting for face -->
      <div class="ft-overlay" *ngIf="!faceDetected">
        <div class="ft-overlay-inner">
          <div class="ft-icon">
            {{ cameraState === 'requesting' ? '📷' : isLoading ? '⏳' : '👤' }}
          </div>
          <div class="ft-msg">
            {{ cameraState === 'requesting' ? 'Requesting camera…'
             : cameraState === 'denied'    ? 'Camera access denied'
             : isLoading                   ? 'Loading avatar…'
             :                              'Look at camera' }}
          </div>
          <div class="ft-sub" *ngIf="cameraState === 'ready' && !isLoading">
            Face tracking active — move into frame
          </div>
          <div class="ft-sub err" *ngIf="cameraState === 'denied'">
            Enable camera access in browser settings and reload.
          </div>
        </div>
      </div>

      <!-- Live badge -->
      <div class="ft-live-badge" *ngIf="faceDetected">
        <span class="ft-live-dot"></span> TRACKING
      </div>
    </div>
  `,
    styles: [`
    :host { display:block; width:100%; height:100%; }

    .ft-container {
      width:100%; height:100%;
      position:relative;
      background:radial-gradient(ellipse at 50% 30%, #1a1025 0%, #070810 70%);
      overflow:hidden;
    }

    .ft-canvas {
      display:block;
      width:100%;
      height:100%;
    }

    .ft-overlay {
      position:absolute; inset:0;
      display:grid; place-items:center;
      background:rgba(7,8,16,.65);
      backdrop-filter:blur(6px);
      pointer-events:none;
      z-index:5;
    }
    .ft-overlay-inner { text-align:center; }
    .ft-icon { font-size:44px; margin-bottom:8px; opacity:.7; }
    .ft-msg { font-size:14px; font-weight:600; color:#cbd5e1; }
    .ft-sub { font-size:11px; color:#64748b; margin-top:4px; }
    .ft-sub.err { color:#f87171; }

    .ft-live-badge {
      position:absolute; top:10px; left:50%; transform:translateX(-50%);
      background:rgba(10,10,16,.75); backdrop-filter:blur(4px);
      border:1px solid rgba(52,211,153,.35);
      color:#34d399; font-size:10px; font-weight:700;
      letter-spacing:.9px; padding:3px 10px; border-radius:999px;
      display:flex; align-items:center; gap:6px;
      pointer-events:none; z-index:4;
    }
    .ft-live-dot {
      width:7px; height:7px; border-radius:50%;
      background:#34d399; box-shadow:0 0 6px #34d39988;
      animation: ftpulse 1.2s ease-in-out infinite;
    }
    @keyframes ftpulse {
      0%,100% { opacity:1; transform:scale(1); }
      50%      { opacity:.5; transform:scale(.85); }
    }
  `]
})
export class FaceTrackedAvatarComponent implements AfterViewInit, OnDestroy, OnChanges {
    @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;
    @ViewChild('canvas')    canvasRef!: ElementRef<HTMLCanvasElement>;
    @ViewChild('videoEl')   videoRef!: ElementRef<HTMLVideoElement>;

    /** Same avatar URL used by the left (playback) avatar */
    @Input() avatarUrl: string = '';

    private faceTracking = inject(FaceTrackingService);
    private recorder    = inject(MotionRecorderService);
    private modelCache  = inject(ModelCacheService);
    private ngZone      = inject(NgZone);

    // Three.js
    private renderer!: THREE.WebGLRenderer;
    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private rafId = 0;

    // Avatar
    private headMesh: THREE.Object3D[] = [];
    private nodes: Record<string, THREE.Object3D> = {};
    private currentModel: THREE.Object3D | null = null;

    // Breathing
    private breathingTime = 0;

    // Resize
    private resizeObserver!: ResizeObserver;

    // Public state (template bindings)
    isLoading = true;
    faceDetected = false;
    cameraState: 'requesting' | 'ready' | 'denied' = 'requesting';

    async ngAfterViewInit(): Promise<void> {
        this.initThree();
        if (this.avatarUrl) {
            this.loadAvatar(this.avatarUrl);
        }
        this.ngZone.runOutsideAngular(() => { this.animate(); });

        // Auto-initialize camera — no button press required
        await this.initCamera();
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['avatarUrl'] && !changes['avatarUrl'].firstChange && this.avatarUrl) {
            this.loadAvatar(this.avatarUrl);
        }
    }

    ngOnDestroy(): void {
        cancelAnimationFrame(this.rafId);
        this.resizeObserver?.disconnect();
        this.renderer?.dispose();
    }

    // ------------------------------------------------------------------ Camera init

    private async initCamera(): Promise<void> {
        this.ngZone.run(() => { this.cameraState = 'requesting'; });
        try {
            await this.recorder.enableCamera(this.videoRef.nativeElement);
            this.ngZone.run(() => { this.cameraState = 'ready'; });
        } catch (e) {
            console.warn('[FaceTrackedAvatar] camera init failed:', e);
            this.ngZone.run(() => { this.cameraState = 'denied'; });
        }
    }

    // ------------------------------------------------------------------ Three.js

    private initThree(): void {
        const canvas = this.canvasRef.nativeElement;
        const container = this.containerRef.nativeElement;
        const w = container.clientWidth || 400;
        const h = container.clientHeight || 500;

        this.scene = new THREE.Scene();

        // Match the same camera framing as AvatarTtsComponent (head-and-shoulders)
        this.camera = new THREE.PerspectiveCamera(25, w / h, 0.1, 1000);
        this.camera.position.set(0, -0.15, 1.25);

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambient);
        const dir = new THREE.DirectionalLight(0xffffff, 1);
        dir.position.set(5, 10, 7);
        dir.castShadow = true;
        this.scene.add(dir);
        const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
        hemi.position.set(0, 20, 0);
        this.scene.add(hemi);

        // ResizeObserver fires whenever the container element changes size —
        // this covers both window resize and viewport splits (single → dual panel).
        this.resizeObserver = new ResizeObserver(() => {
            if (!this.camera || !this.renderer) return;
            const cw = container.clientWidth;
            const ch = container.clientHeight;
            if (!cw || !ch) return;
            this.camera.aspect = cw / ch;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(cw, ch);
        });
        this.resizeObserver.observe(container);
    }

    // ------------------------------------------------------------------ Avatar loading

    private normalizeUrl(url: string): string {
        let u = url.trim();
        if (u.includes('readyplayer.me')) {
            if (!/\.glb(\?|$)/i.test(u)) {
                const q = u.indexOf('?');
                u = q >= 0 ? `${u.slice(0, q)}.glb${u.slice(q)}` : `${u}.glb`;
            }
            if (!u.includes('morphTargets')) {
                u += (u.includes('?') ? '&' : '?') + 'morphTargets=ARKit&textureAtlas=1024';
            }
        }
        return u;
    }

    private async loadAvatar(url: string): Promise<void> {
        this.isLoading = true;
        const normUrl = this.normalizeUrl(url);
        const loader = new GLTFLoader();
        try {
            const cached = await this.modelCache.getCachedModel(normUrl);
            if (cached) {
                loader.parse(cached, '', (gltf: any) => this.onModelLoaded(gltf),
                    (_err: any) => this.downloadModel(normUrl, loader));
            } else {
                this.downloadModel(normUrl, loader);
            }
        } catch (e) {
            console.error('[FaceTrackedAvatar] loadAvatar error:', e);
            this.isLoading = false;
        }
    }

    private downloadModel(url: string, loader: any): void {
        fetch(url)
            .then(r => r.arrayBuffer())
            .then(ab => {
                this.modelCache.cacheModel(url, ab);
                loader.parse(ab, '', (gltf: any) => this.onModelLoaded(gltf),
                    (err: any) => { console.error('[FaceTrackedAvatar] parse error', err); this.isLoading = false; });
            })
            .catch(e => { console.error('[FaceTrackedAvatar] download error', e); this.isLoading = false; });
    }

    private onModelLoaded(gltf: any): void {
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            this.currentModel.traverse((n: THREE.Object3D) => {
                const mesh = n as THREE.Mesh;
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) {
                    const mat = mesh.material;
                    if (Array.isArray(mat)) mat.forEach(m => m.dispose());
                    else mat.dispose();
                }
            });
        }

        const model = gltf.scene;
        model.scale.set(1, 1, 1);
        model.position.set(0, -1.75, 0);
        this.currentModel = model;
        this.scene.add(model);

        this.headMesh = [];
        this.nodes = {};
        model.traverse((n: THREE.Object3D) => {
            this.nodes[n.name] = n;
            if (['Wolf3D_Head', 'Wolf3D_Teeth', 'Wolf3D_Beard', 'Wolf3D_Avatar', 'Wolf3D_Head_Custom'].includes(n.name)) {
                this.headMesh.push(n);
            }
        });

        this.isLoading = false;
    }

    // ------------------------------------------------------------------ Render loop

    private animate(): void {
        this.rafId = requestAnimationFrame(this.animate.bind(this));

        this.breathingTime += 0.02;

        const blendshapes = this.faceTracking.blendshapes();
        const rotation    = this.faceTracking.rotation();

        // Update face-detected flag (run in zone only on state change)
        const tracking = blendshapes.length > 0;
        if (tracking !== this.faceDetected) {
            this.ngZone.run(() => { this.faceDetected = tracking; });
        }

        // Apply all ARKit blendshapes directly from MediaPipe
        if (blendshapes.length > 0 && this.headMesh.length > 0) {
            blendshapes.forEach((element: any) => {
                this.headMesh.forEach((mesh: THREE.Object3D) => {
                    const m = mesh as any;
                    if (m.morphTargetDictionary && m.morphTargetInfluences) {
                        const index = m.morphTargetDictionary[element.categoryName];
                        if (index !== undefined && index >= 0) {
                            m.morphTargetInfluences[index] = element.score;
                        }
                    }
                });
            });
        }

        // Apply head rotation from face tracking
        const parts = this.nodes;
        const breathCycle = Math.sin(this.breathingTime * 0.6);
        const breathIntensity = 0.05;

        if (rotation) {
            if (parts['Head']) parts['Head'].rotation.set(rotation.x, -rotation.y, -rotation.z);
            if (parts['Neck']) parts['Neck'].rotation.set(rotation.x / 5 + 0.3, -rotation.y / 5, -rotation.z / 5);
        }

        // Idle breathing (spine)
        if (parts['Spine'])  parts['Spine'].rotation.x  = breathCycle * breathIntensity * 0.2;
        if (parts['Spine1']) parts['Spine1'].rotation.x = breathCycle * breathIntensity * 0.2;
        if (parts['Spine2']) parts['Spine2'].rotation.x = breathCycle * breathIntensity;

        this.renderer.render(this.scene, this.camera);
    }
}
