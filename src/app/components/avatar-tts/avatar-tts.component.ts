import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, OnChanges, SimpleChanges, inject, NgZone, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ModelCacheService } from '../../services/model-cache.service';
import { TtsLipsyncService } from '../../services/tts-lipsync.service';
import { GesturePlayerService } from '../../services/gesture-player.service';
import { MOUTH_KEYS } from '../../lib/lipsync/viseme-map';
import { GESTURE_MAP } from '../../lib/gestures/gesture-library';
import {
    buildNormalizedRig,
    conformanceLabel,
    NormalizedRig,
    RigReport,
} from '../../lib/avatars/rig-spec';

/** Canonical gesture morphs the built-in gesture library touches (for conformance). */
const REQUIRED_GESTURE_MORPHS: string[] = Array.from(
    new Set(
        Array.from(GESTURE_MAP.values()).flatMap((g) =>
            g.channels.filter((c) => c.type === 'morph').map((c) => c.target)
        )
    )
);

/** Ready Player Me hosting shut down 2026-01-31; default is a hosted RPM-style sample with ARKit morphs. */
export const DEFAULT_AVATAR_URL = 'https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/brunette.glb';

/**
 * Avatar renderer driven by TTS visemes instead of camera face tracking.
 * Rendering pipeline mirrors avatar-viewer.component.ts (which stays untouched).
 * Idle behavior: breathing + random blinking.
 */
@Component({
    selector: 'app-avatar-tts',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div #canvasContainer class="canvas-container">
      <div class="overlay" *ngIf="loadStatus() !== 'ready'">
        <span *ngIf="loadStatus() === 'loading'">Loading avatar...</span>
        <span class="err" *ngIf="loadStatus() === 'error'">{{ loadError() }}</span>
      </div>
    </div>`,
    styles: [`
    :host { display: block; width: 100%; height: 100%; }
    .canvas-container { width: 100%; height: 100%; overflow: hidden; background-color: #222; position: relative; }
    .overlay {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: #ccc; font-size: 14px; z-index: 2; pointer-events: none; padding: 20px; text-align: center;
    }
    .err { color: #ff9c9c; }
  `]
})
export class AvatarTtsComponent implements AfterViewInit, OnDestroy, OnChanges {
    @ViewChild('canvasContainer') canvasContainer!: ElementRef<HTMLDivElement>;
    @Input() avatarUrl: string = DEFAULT_AVATAR_URL;
    /** Compact framing for the small detail "Ver mas" PiP: pulls the camera back so the
        head AND shoulders fit. false = normal full-screen framing. Bound to pipActive(). */
    @Input() compact: boolean = false;
    /** Emitted after a model loads + is inspected — drives the picker conformance badge. */
    @Output() rigReport = new EventEmitter<RigReport>();

    /* Camera framing presets (camera-only; the ResizeObserver still owns aspect+size).
       MAIN = full-screen head-and-shoulders (default, unchanged).
       COMPACT = pulled back (larger z) + lowered target so head+shoulders fit the small PiP.
       Tune fov / the z distance / y here. */
    private readonly FRAMING_MAIN = { fov: 20, x: 0, y: -0.12, z: 1.12 };
    /* Pulled back so the head + full shoulders + chest/torso fit the (taller, sunk) detail
       PiP without side-slicing. y is raised vs the body center so there is HEADROOM above
       the crown (the head can never clip the top edge) and the avatar sits lower in frame,
       letting the sunk box clip the waist at the BOTTOM. Tune: z = distance (size), y =
       higher -> more headroom + avatar lower in frame; pair with --detail-pip-sink. */
    private readonly FRAMING_COMPACT = { fov: 22, x: 0, y: -0.50, z: 3.40 };

    /* Automatic bounding-box framing (frameModel). Every loaded GLB is normalized to a
       constant world HEIGHT and positioned so the TOP OF THE HEAD lands at a consistent
       Y derived from the MAIN camera preset, leaving FRAMING_HEADROOM above the crown.
       This makes head+chest framing identical for any avatar (no per-avatar offsets) and
       removes the old hardcoded model.position.set(0,-1.75,0). The model placement always
       targets FRAMING_MAIN; the detail PiP composition is achieved purely by moving the
       CAMERA (applyFraming/FRAMING_COMPACT), so the two stay independent. */
    private readonly FRAMING_TARGET_HEIGHT = 1.8; // world height every avatar is scaled to (height-only normalization)
    private readonly FRAMING_HEADROOM = 0.07;      // fraction of the frame height kept above the crown

    private modelCache = inject(ModelCacheService);
    private tts = inject(TtsLipsyncService);
    public gestures = inject(GesturePlayerService); // public: allows programmatic trigger from parents
    private ngZone = inject(NgZone);
    public isLoading = true;
    public loadStatus = signal<'loading' | 'ready' | 'error'>('loading');
    public loadError = signal<string>('');

    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private renderer!: THREE.WebGLRenderer;
    private requestID = 0;

    private headMesh: THREE.Object3D[] = [];
    private nodes: Record<string, THREE.Object3D> = {};
    private currentModel: THREE.Object3D | null = null;

    // canonical→actual blendshape/bone normalization for the loaded avatar
    private rig: NormalizedRig | null = null;

    private breathingTime = 0;
    private lastFrameTime = performance.now();

    // smoothed mouth state, owned exclusively by lipsync (MOUTH_KEYS only)
    private mouthState: Record<string, number> = {};
    // smoothed gesture morph state, owned by the gesture player (brows/eyes/etc.)
    private gestureMorphState: Record<string, number> = {};
    // gesture morph keys ever touched (so released channels decay to 0)
    private gestureKeys = new Set<string>();
    // final combined influences written to the mesh each frame
    private morphState: Record<string, number> = {};

    // blinking
    private nextBlinkAt = performance.now() + 2000;
    private blinkStart = 0;
    private readonly BLINK_MS = 160;

    private resizeObserver!: ResizeObserver;

    ngAfterViewInit() {
        this.initThree();
        this.loadAvatar(this.avatarUrl);
        this.ngZone.runOutsideAngular(() => this.animate());
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['avatarUrl'] && !changes['avatarUrl'].firstChange && this.scene) {
            this.loadAvatar(this.avatarUrl);
        }
        // Switch camera framing when entering/leaving the compact detail PiP (camera-only;
        // no canvas recreation). Guarded: camera exists only after initThree.
        if (changes['compact'] && this.camera) {
            this.applyFraming();
        }
    }

    /** Apply the current framing preset to the (single, shared) camera. */
    private applyFraming(): void {
        if (!this.camera) return;
        const f = this.compact ? this.FRAMING_COMPACT : this.FRAMING_MAIN;
        this.camera.fov = f.fov;
        this.camera.position.set(f.x, f.y, f.z);
        this.camera.updateProjectionMatrix();
    }

    /**
     * Automatic bounding-box framing -- runs on EVERY model load/switch so any avatar
     * (current or future) gets the same close HEAD-AND-CHEST composition, with NO per-avatar
     * constants. HEIGHT-ONLY normalization:
     *   1) Scale the model so its world height == FRAMING_TARGET_HEIGHT (tall/short variance
     *      gone -> consistent zoom for everyone).
     *   2) Center it on x/z and translate it so the TOP OF THE HEAD (bbox.max.y) sits at the
     *      FRAMING_HEADROOM line just below the frame top -> the crown is never clipped and
     *      head+upper-chest fill the frame the same way every time.
     * Width is intentionally NOT fitted: wide avatars (e.g. wings) extend beyond the sides /
     * get cropped, which is the accepted trade-off for a consistent close framing.
     * The target Y is computed from FRAMING_MAIN ONLY (never the live/compact camera), so the
     * detail PiP -- a pulled-back CAMERA (FRAMING_COMPACT) viewing this same model -- keeps its
     * own composition. No canvas/WebGL recreation: we only set scale/position.
     */
    private frameModel(model: THREE.Object3D): void {
        const box = new THREE.Box3();
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();

        // 1) Normalize height so every avatar fills the frame consistently.
        model.scale.setScalar(1);
        model.position.set(0, 0, 0);
        model.updateMatrixWorld(true);
        box.setFromObject(model);
        box.getSize(size);
        if (size.y > 1e-4) model.scale.setScalar(this.FRAMING_TARGET_HEIGHT / size.y);

        // 2) Recompute the scaled box, then place head-top at the framed Y, centered on x/z.
        model.updateMatrixWorld(true);
        box.setFromObject(model);
        box.getCenter(center);

        const main = this.FRAMING_MAIN;
        const halfV = Math.tan(THREE.MathUtils.degToRad(main.fov) / 2) * main.z; // subject plane z=0
        const headTopY = (main.y + halfV) - this.FRAMING_HEADROOM * (halfV * 2);

        model.position.x += 0 - center.x;        // center horizontally
        model.position.z += 0 - center.z;        // center in depth
        model.position.y += headTopY - box.max.y; // crown to the framed top (with headroom)
        model.updateMatrixWorld(true);
    }

    ngOnDestroy() {
        cancelAnimationFrame(this.requestID);
        this.resizeObserver?.disconnect();
        this.renderer?.dispose();
    }

    // ------------------------------------------------------------- three.js

    private initThree() {
        const el = this.canvasContainer.nativeElement;
        const width = el.clientWidth, height = el.clientHeight;

        this.scene = new THREE.Scene();
        // FOV/position come from a framing preset (MAIN vs COMPACT). applyFraming() sets
        // them based on the current `compact` input. The aspect is still driven by the
        // ResizeObserver (onWindowResize) -- canvas resizes, never recreated.
        this.camera = new THREE.PerspectiveCamera(this.FRAMING_MAIN.fov, width / height, 0.1, 1000);
        this.applyFraming();

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        el.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(5, 10, 7);
        this.scene.add(dirLight);
        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
        hemiLight.position.set(0, 20, 0);
        this.scene.add(hemiLight);

        // Use ResizeObserver so the camera/renderer updates whenever the
        // *container* changes size (e.g. single→dual viewport split), not
        // just when the browser window is resized.
        this.resizeObserver = new ResizeObserver(() => this.onWindowResize());
        this.resizeObserver.observe(el);
    }

    private normalizeAvatarUrl(url: string): string {
        let u = url.trim();
        if (!u) return u;
        // RPM-specific URL params only apply to readyplayer.me-hosted avatars
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

    private async loadAvatar(url: string) {
        this.isLoading = true;
        this.loadStatus.set('loading');
        const loader = new GLTFLoader();
        const normalized = this.normalizeAvatarUrl(url);
        console.log('[avatar-tts] loading avatar:', normalized);
        try {
            let data = await this.modelCache.getCachedModel(normalized);
            if (!data) {
                const res = await fetch(normalized);
                if (!res.ok) throw new Error(`Avatar download failed: HTTP ${res.status} for ${normalized}`);
                data = await res.arrayBuffer();
                await this.modelCache.cacheModel(normalized, data);
            }
            loader.parse(data, '', (gltf: any) => this.processLoadedModel(gltf),
                (err: any) => {
                    console.error('[avatar-tts] Error parsing model:', err);
                    this.fail('Could not parse avatar GLB: ' + (err?.message ?? err));
                });
        } catch (e: any) {
            console.error('[avatar-tts] Error loading avatar:', e);
            this.fail(e?.message ?? String(e));
        }
    }

    private fail(msg: string) {
        this.isLoading = false;
        this.ngZone.run(() => { this.loadStatus.set('error'); this.loadError.set(msg); });
    }

    private processLoadedModel(gltf: any) {
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            this.currentModel.traverse((node: THREE.Object3D) => {
                const mesh = node as THREE.Mesh;
                if (mesh.geometry) mesh.geometry.dispose();
                const mat = mesh.material;
                if (Array.isArray(mat)) mat.forEach(m => m.dispose());
                else if (mat) mat.dispose();
            });
        }
        const model = gltf.scene;
        this.currentModel = model;
        this.scene.add(model);
        this.frameModel(model); // auto bbox framing (replaces the old fixed -1.75 offset)

        this.headMesh = [];
        this.nodes = {};
        const morphMeshes: { name: string; dict: Record<string, number> }[] = [];
        model.traverse((node: THREE.Object3D) => {
            this.nodes[node.name] = node;
            const m = node as any;
            // Any mesh carrying blendshapes is a candidate for facial animation,
            // regardless of naming convention (RPM Wolf3D_*, CC4, Mixamo, custom…).
            if (m.morphTargetDictionary && m.morphTargetInfluences) {
                this.headMesh.push(node);
                morphMeshes.push({ name: node.name, dict: m.morphTargetDictionary });
            }
        });

        // Build the canonical→actual normalization map + conformance report.
        this.rig = buildNormalizedRig({
            morphMeshes,
            nodes: this.nodes,
            requiredMouthKeys: MOUTH_KEYS,
            requiredGestureMorphs: REQUIRED_GESTURE_MORPHS,
        });
        const r = this.rig.report;
        console.log(
            `[avatar-tts] model loaded — ${conformanceLabel(r.conformance)}\n` +
            `  morph meshes: ${r.morphMeshes.join(', ') || '(none)'}\n` +
            `  total morphs: ${r.totalMorphs} | matched ARKit: ${r.matchedArkit.length}/52 | remapped: ${r.remappedCount}\n` +
            `  bones: ${JSON.stringify(r.bones)}\n` +
            (r.missingArkit.length ? `  missing ARKit: ${r.missingArkit.join(', ')}\n` : '') +
            (r.warnings.length ? `  warnings:\n   - ${r.warnings.join('\n   - ')}` : '  ✓ no warnings')
        );
        this.ngZone.run(() => this.rigReport.emit(r));

        this.isLoading = false;
        this.ngZone.run(() => this.loadStatus.set('ready'));
        if (this.headMesh.length === 0) {
            this.fail('Model loaded but it has no blendshapes/morph targets — facial animation and lipsync are unavailable for this avatar.');
        }
    }

    private onWindowResize() {
        if (!this.camera || !this.renderer) return;
        const el = this.canvasContainer.nativeElement;
        this.camera.aspect = el.clientWidth / el.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(el.clientWidth, el.clientHeight);
    }

    // ------------------------------------------------------------ animation

    private animate() {
        this.requestID = requestAnimationFrame(this.animate.bind(this));
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
        this.lastFrameTime = now;
        this.breathingTime += dt;

        // --- mouth: targets from TTS service, exponential smoothing (lipsync owns these) ---
        const targets = this.tts.getMouthWeights();
        // snappy attack, slightly slower release feels more natural
        const sUp = 1 - Math.exp(-dt * 30);
        const sDown = 1 - Math.exp(-dt * 18);
        for (const key of MOUTH_KEYS) {
            const target = targets[key] ?? 0;
            const cur = this.mouthState[key] ?? 0;
            this.mouthState[key] = cur + (target - cur) * (target > cur ? sUp : sDown);
        }

        // --- gestures (brows/eyes + head offsets), smoothed in their own state ---
        const g = this.gestures.sample();
        for (const key of Object.keys(g.morphs)) this.gestureKeys.add(key);
        for (const key of this.gestureKeys) {
            const target = g.morphs[key] ?? 0;
            const cur = this.gestureMorphState[key] ?? 0;
            this.gestureMorphState[key] = cur + (target - cur) * sUp;
        }

        // --- blinking ---
        let blink = 0;
        if (now >= this.nextBlinkAt) {
            if (this.blinkStart === 0) this.blinkStart = now;
            const p = (now - this.blinkStart) / this.BLINK_MS;
            if (p >= 1) {
                this.blinkStart = 0;
                this.nextBlinkAt = now + 1800 + Math.random() * 3500;
            } else {
                blink = Math.sin(p * Math.PI); // 0->1->0
            }
        }

        // --- combine: mouth (lipsync) + gestures (additive) + blink (max on eyelids) ---
        // Rebuilt fresh each frame so gestures can never zero-out the mouth and vice versa.
        const combined: Record<string, number> = {};
        for (const key of MOUTH_KEYS) combined[key] = this.mouthState[key] ?? 0;
        for (const key of this.gestureKeys) {
            combined[key] = (combined[key] ?? 0) + (this.gestureMorphState[key] ?? 0);
        }
        combined['eyeBlinkLeft'] = Math.max(combined['eyeBlinkLeft'] ?? 0, blink);
        combined['eyeBlinkRight'] = Math.max(combined['eyeBlinkRight'] ?? 0, blink);
        for (const key of Object.keys(combined)) {
            combined[key] = Math.max(0, Math.min(1, combined[key]));
        }
        this.morphState = combined;

        // --- apply morphs (canonical ARKit key → this avatar's actual morph name) ---
        if (this.headMesh.length > 0) {
            const morphMap = this.rig?.morphMap;
            for (const mesh of this.headMesh) {
                const m = mesh as any;
                if (!m.morphTargetDictionary || !m.morphTargetInfluences) continue;
                for (const key of Object.keys(this.morphState)) {
                    const actual = morphMap?.get(key) ?? key;
                    const idx = m.morphTargetDictionary[actual];
                    if (idx !== undefined && idx >= 0) {
                        m.morphTargetInfluences[idx] = this.morphState[key];
                    }
                }
            }
        }

        // --- breathing (same pattern as avatar-viewer); bones resolved per-avatar ---
        const breathCycle = Math.sin(this.breathingTime * 0.6);
        const breathIntensity = 0.05;
        const bones = this.rig?.boneNodes;
        const spine = bones?.['Spine'] ?? this.nodes['Spine'];
        const spine1 = bones?.['Spine1'] ?? this.nodes['Spine1'];
        const spine2 = bones?.['Spine2'] ?? this.nodes['Spine2'];
        const headBone = bones?.['Head'] ?? this.nodes['Head'];
        const neckBone = bones?.['Neck'] ?? this.nodes['Neck'];
        if (spine) spine.rotation.x = breathCycle * breathIntensity * 0.2;
        if (spine1) spine1.rotation.x = breathCycle * breathIntensity * 0.2;
        if (spine2) spine2.rotation.x = breathCycle * breathIntensity;

        // subtle head sway while speaking + additive gesture rotation (nod/shake/tilt)
        if (headBone) {
            const speaking = this.tts.state() === 'speaking';
            const sway = speaking ? Math.sin(this.breathingTime * 1.7) * 0.02 : 0;
            headBone.rotation.set(
                sway + g.head.x,
                Math.sin(this.breathingTime * 0.9) * (speaking ? 0.03 : 0.01) + g.head.y,
                g.head.z
            );
        }
        if (neckBone) neckBone.rotation.set(0.3, 0, 0);

        this.renderer.render(this.scene, this.camera);
    }
}
