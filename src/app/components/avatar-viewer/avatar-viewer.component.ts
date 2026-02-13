import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, OnChanges, SimpleChanges, inject, NgZone, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FaceTrackingService } from '../../services/face-tracking.service';
import { ModelCacheService } from '../../services/model-cache.service';

@Component({
    selector: 'app-avatar-viewer',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div #canvasContainer class="canvas-container">
        <!-- Background Video -->
        <video *ngIf="isVideo(backgroundImage)" 
               [src]="backgroundImage" 
               autoplay loop muted playsinline 
               class="background-media is-video">
        </video>
        
        <!-- Background Image -->
        <div *ngIf="!isVideo(backgroundImage) && backgroundImage" 
             class="background-media is-image" 
             [style.backgroundImage]="'url(' + backgroundImage + ')'">
        </div>
    </div>
  `,
    styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    .canvas-container {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #222;
      position: relative;
    }
    .background-media {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        z-index: 0;
    }
    .background-media.is-image {
        background-size: cover;
        background-position: center;
        background-repeat: no-repeat;
        transition: background-image 0.5s ease-in-out;
    }
    
    /* Ensure canvas is on top */
    ::ng-deep canvas {
        position: relative;
        z-index: 1;
    }
  `]
})
export class AvatarViewerComponent implements AfterViewInit, OnDestroy, OnChanges {
    @ViewChild('canvasContainer') canvasContainer!: ElementRef<HTMLDivElement>;

    // Inputs
    @Input() avatarUrl: string = 'https://models.readyplayer.me/6984a7a905b43df7aaeb9df1.glb';
    @Input() backgroundImage: string | null = null;
    @Input() avatarSize: 'small' | 'medium' | 'large' = 'medium';
    @Input() avatarPosition: 'left' | 'center' | 'right' = 'center';

    // Size to scale mapping (uniform scale for the model)
    private sizeScaleMap = {
        small: 0.8,   // Smaller avatar
        medium: 1.0,  // Default size
        large: 1.4    // Larger avatar (fills more of the screen)
    };

    // Position mapping (X axis offset)
    private positionXMap = {
        left: -0.6,
        center: 0,
        right: 0.6
    };

    private trackService = inject(FaceTrackingService);
    private modelCache = inject(ModelCacheService);
    private ngZone = inject(NgZone);
    public isLoading = true;
    private isInitialized = false;

    // Three.js refs
    private scene!: THREE.Scene;
    private camera!: THREE.PerspectiveCamera;
    private renderer!: THREE.WebGLRenderer;
    private requestID: number = 0;

    // Model refs
    private headMesh: THREE.Object3D[] = [];
    private nodes: Record<string, THREE.Object3D> = {};
    private currentModel: THREE.Object3D | null = null;

    // Breathing animation
    private breathingTime: number = 0;


    ngAfterViewInit() {
        this.initThree();
        this.loadAvatar(this.avatarUrl);
        this.isInitialized = true;

        // Start render loop outside Angular Zone to avoid Change Detection on every frame
        this.ngZone.runOutsideAngular(() => {
            this.animate();
        });
    }

    ngOnChanges(changes: SimpleChanges): void {
        // Handle URL change
        if (changes['avatarUrl'] && !changes['avatarUrl'].firstChange) {
            this.loadAvatar(this.avatarUrl);
        }

        // Handle size or position changes
        if ((changes['avatarSize'] && !changes['avatarSize'].firstChange) ||
            (changes['avatarPosition'] && !changes['avatarPosition'].firstChange)) {
            if (this.currentModel) {
                this.updateModelTransform();
            }
        }
    }

    private updateModelTransform() {
        if (this.currentModel) {
            // Apply scale
            const scale = this.sizeScaleMap[this.avatarSize];
            this.currentModel.scale.set(scale, scale, scale);

            // Calculate Y position (Height)
            const baseY = -1.75;
            const yOffset = this.avatarSize === 'large' ? -0.5 :
                this.avatarSize === 'small' ? 0.2 : 0;

            // Calculate X position (Horizontal)
            const xOffset = this.positionXMap[this.avatarPosition];

            this.currentModel.position.set(xOffset, baseY + yOffset, 0);
        }
    }

    public isVideo(url: string | null): boolean {
        if (!url) return false;
        return url.startsWith('data:video') || url.endsWith('.mp4') || url.endsWith('.webm') || url.endsWith('.mov');
    }

    // Public method to force resize - call from parent when container size changes
    public forceResize() {
        setTimeout(() => this.onWindowResize(), 50);
    }

    ngOnDestroy() {
        cancelAnimationFrame(this.requestID);
        this.renderer.dispose();
    }

    private initThree() {
        const width = this.canvasContainer.nativeElement.clientWidth;
        const height = this.canvasContainer.nativeElement.clientHeight;

        // Scene
        this.scene = new THREE.Scene();

        // Camera
        this.camera = new THREE.PerspectiveCamera(25, width / height, 0.1, 1000);
        this.camera.position.set(0, 0.1, 2.5); // Closer shot for chest-up view

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // this.renderer.outputEncoding = THREE.sRGBEncoding; // Deprecated in recent Three.js
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

        this.canvasContainer.nativeElement.appendChild(this.renderer.domElement);

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(5, 10, 7);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
        hemiLight.position.set(0, 20, 0);
        this.scene.add(hemiLight);

        // Resize handling
        window.addEventListener('resize', this.onWindowResize.bind(this));
    }

    private async loadAvatar(url: string) {
        this.isLoading = true;
        const loader = new GLTFLoader();
        const normalizedUrl = this.normalizeAvatarUrl(url);

        try {
            const cachedData = await this.modelCache.getCachedModel(normalizedUrl);

            if (cachedData) {
                // Load from cache
                loader.parse(cachedData, '', (gltf: any) => {
                    this.processLoadedModel(gltf);
                }, (error: any) => {
                    console.error('Error parsing cached model:', error);
                    this.downloadAndParseModel(normalizedUrl, loader);
                });
            } else {
                this.downloadAndParseModel(normalizedUrl, loader);
            }
        } catch (error) {
            console.error('Error loading avatar:', error);
            this.isLoading = false;
        }
    }

    public async preloadAvatar(url: string): Promise<string> {
        const normalizedUrl = this.normalizeAvatarUrl(url);
        const cachedData = await this.modelCache.getCachedModel(normalizedUrl);

        if (!cachedData) {
            await this.downloadAndCacheModel(normalizedUrl);
        }

        return normalizedUrl;
    }

    private normalizeAvatarUrl(url: string): string {
        const trimmedUrl = url.trim();
        if (!trimmedUrl) {
            return trimmedUrl;
        }

        let normalizedUrl = trimmedUrl;

        if (!/\.glb(\?|$)/i.test(normalizedUrl)) {
            const queryStart = normalizedUrl.indexOf('?');
            if (queryStart >= 0) {
                const base = normalizedUrl.slice(0, queryStart);
                const query = normalizedUrl.slice(queryStart);
                normalizedUrl = `${base}.glb${query}`;
            } else {
                normalizedUrl = `${normalizedUrl}.glb`;
            }
        }

        if (!normalizedUrl.includes('morphTargets')) {
            normalizedUrl += (normalizedUrl.includes('?') ? '&' : '?') + 'morphTargets=ARKit&textureAtlas=1024';
        }

        return normalizedUrl;
    }

    private async downloadAndCacheModel(url: string): Promise<ArrayBuffer> {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        await this.modelCache.cacheModel(url, arrayBuffer);
        return arrayBuffer;
    }

    private downloadAndParseModel(url: string, loader: GLTFLoader) {
        console.log('📥 Downloading model from:', url);

        this.downloadAndCacheModel(url)
            .then(async (arrayBuffer) => {
                loader.parse(arrayBuffer, '', (gltf: any) => {
                    this.processLoadedModel(gltf);
                }, (error: any) => {
                    console.error('Error parsing downloaded model:', error);
                    this.isLoading = false;
                });
            })
            .catch((error) => {
                this.isLoading = false;
                const msg = error.message || 'Unknown error';
                alert('Error downloading avatar: ' + msg);
            });
    }

    private processLoadedModel(gltf: any) {
        // Cleanup previous model if exists
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            this.currentModel.traverse((node: THREE.Object3D) => {
                if ((node as THREE.Mesh).geometry) {
                    (node as THREE.Mesh).geometry.dispose();
                }
                if ((node as THREE.Mesh).material) {
                    const material = (node as THREE.Mesh).material;
                    if (Array.isArray(material)) {
                        material.forEach(m => m.dispose());
                    } else {
                        material.dispose();
                    }
                }
            });
        }

        const model = gltf.scene;
        // Apply scale based on size setting
        const scale = this.sizeScaleMap[this.avatarSize];
        model.scale.set(scale, scale, scale);

        // Apply position with Y offset based on size
        const baseY = -1.75;
        const yOffset = this.avatarSize === 'large' ? -0.5 :
            this.avatarSize === 'small' ? 0.2 : 0;
        model.position.set(0, baseY + yOffset, 0);

        this.currentModel = model;

        this.scene.add(model);

        this.headMesh = [];
        this.nodes = {};

        model.traverse((node: THREE.Object3D) => {
            // Build nodes map
            this.nodes[node.name] = node;

            // Identify head meshes for blendshapes
            if (node.name === 'Wolf3D_Head' ||
                node.name === 'Wolf3D_Teeth' ||
                node.name === 'Wolf3D_Beard' ||
                node.name === 'Wolf3D_Avatar' ||
                node.name === 'Wolf3D_Head_Custom') {
                this.headMesh.push(node);
            }
        });

        // DEBUG: Log arm-related bones to find correct names
        Object.keys(this.nodes).forEach(name => {
            const lowerName = name.toLowerCase();
            if (lowerName.includes('arm') || lowerName.includes('shoulder') ||
                lowerName.includes('hand') || lowerName.includes('elbow')) {
            }
        });

        this.isLoading = false;
    }

    private onWindowResize() {
        if (!this.camera || !this.renderer) return;
        const width = this.canvasContainer.nativeElement.clientWidth;
        const height = this.canvasContainer.nativeElement.clientHeight;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    private animate() {
        this.requestID = requestAnimationFrame(this.animate.bind(this));

        // Update breathing time
        this.breathingTime += 0.02;

        // --- Update Avatar Pose ---
        const blendshapes = this.trackService.blendshapes();
        const rotation = this.trackService.rotation();

        // Apply Face Blendshapes
        if (blendshapes.length > 0 && this.headMesh.length > 0) {
            blendshapes.forEach(element => {
                this.headMesh.forEach(mesh => {
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

        // --- Breathing Animation ---
        const breathCycle = Math.sin(this.breathingTime * 0.5);
        const breathIntensity = 0.05;
        const parts = this.nodes;

        // Spine (Breathing)
        if (parts['Spine']) parts['Spine'].rotation.x = breathCycle * breathIntensity * 0.2;
        if (parts['Spine1']) parts['Spine1'].rotation.x = breathCycle * breathIntensity * 0.2;

        // Spine2 (Breathing + Face Tracking Lean)
        if (parts['Spine2']) {
            const baseRotX = rotation ? rotation.x / 10 : 0;
            const baseRotY = rotation ? rotation.y / 10 : 0;
            const baseRotZ = rotation ? rotation.z / 10 : 0;
            parts['Spine2'].rotation.set(
                baseRotX + breathCycle * breathIntensity,
                baseRotY,
                baseRotZ
            );
        }

        // --- Face Tracking Rotations ---
        if (rotation) {
            if (parts['Head']) parts['Head'].rotation.set(rotation.x, rotation.y, rotation.z);
            if (parts['Neck']) parts['Neck'].rotation.set(rotation.x / 5 + 0.3, rotation.y / 5, rotation.z / 5);

            // Shoulders (Face tracking influence)
            if (parts['Wolf3D_Shoulder_L']) parts['Wolf3D_Shoulder_L'].rotation.set(rotation.x / 15, rotation.y / 15, rotation.z / 15);
            if (parts['Wolf3D_Shoulder_R']) parts['Wolf3D_Shoulder_R'].rotation.set(rotation.x / 15, rotation.y / 15, rotation.z / 15);
        }
        this.renderer.render(this.scene, this.camera);
    }
}
