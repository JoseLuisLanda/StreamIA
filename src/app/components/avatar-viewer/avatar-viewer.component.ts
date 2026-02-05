import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, OnChanges, SimpleChanges, inject, NgZone, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { FaceTrackingService } from '../../services/face-tracking.service';

@Component({
    selector: 'app-avatar-viewer',
    standalone: true,
    imports: [CommonModule],
    template: `
    <div #canvasContainer class="canvas-container" [style.backgroundImage]="backgroundImage ? 'url(' + backgroundImage + ')' : null"></div>
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
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      transition: background-image 0.5s ease-in-out;
    }
  `]
})
export class AvatarViewerComponent implements AfterViewInit, OnDestroy, OnChanges {
    @ViewChild('canvasContainer') canvasContainer!: ElementRef<HTMLDivElement>;

    // Inputs
    @Input() avatarUrl: string = 'https://models.readyplayer.me/6984a7a905b43df7aaeb9df1.glb';
    @Input() backgroundImage: string | null = null;
    @Input() avatarSize: 'small' | 'medium' | 'large' = 'medium';

    // Size to scale mapping (uniform scale for the model)
    private sizeScaleMap = {
        small: 0.8,   // Smaller avatar
        medium: 1.0,  // Default size
        large: 1.4    // Larger avatar (fills more of the screen)
    };

    private trackService = inject(FaceTrackingService);
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


    ngAfterViewInit() {
        this.initThree();
        this.loadAvatar(this.avatarUrl);
        this.isInitialized = true;

        // Start render loop outside Angular Zone to avoid Change Detection on every frame
        this.ngZone.runOutsideAngular(() => {
            this.animate();
        });
    }

    ngOnChanges(changes: SimpleChanges) {
        if (changes['avatarUrl'] && !changes['avatarUrl'].firstChange && this.isInitialized) {
            console.log('Avatar URL changed to:', this.avatarUrl);
            this.loadAvatar(this.avatarUrl);
        }

        // Handle size changes
        if (changes['avatarSize'] && !changes['avatarSize'].firstChange && this.currentModel) {
            this.updateModelScale();
        }
    }

    private updateModelScale() {
        if (this.currentModel) {
            const scale = this.sizeScaleMap[this.avatarSize];
            this.currentModel.scale.set(scale, scale, scale);

            // Adjust Y position based on size to keep avatar in frame
            // Large size needs lower position to show from chest up
            const baseY = -1.75;
            const yOffset = this.avatarSize === 'large' ? -0.5 :
                this.avatarSize === 'small' ? 0.2 : 0;
            this.currentModel.position.setY(baseY + yOffset);
        }
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
        this.camera.position.set(0, 0, 3); // Ajustado para encuadre similar al original

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

    private loadAvatar(url: string) {
        this.isLoading = true;
        const loader = new GLTFLoader();

        // Ensure URL has necessary params if missing (Ready Player Me specific)
        if (!url.includes('morphTargets')) {
            url += (url.includes('?') ? '&' : '?') + 'morphTargets=ARKit&textureAtlas=1024';
        }

        loader.load(url, (gltf: any) => {
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

            console.log('Model loaded', this.nodes);
            this.isLoading = false;
        },
            (xhr: ProgressEvent) => {
                // progress info
                console.log((xhr.loaded / xhr.total * 100) + '% loaded');
            },
            (error: any) => {
                console.error('An error happened loading the avatar:', error);
                this.isLoading = false;
                const msg = error.message || error.target?.statusText || 'Unknown error';
                alert('Error loading avatar: ' + msg);
            });
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

        // --- Update Avatar Pose ---
        const blendshapes = this.trackService.blendshapes();
        const rotation = this.trackService.rotation();

        if (blendshapes.length > 0 && this.headMesh.length > 0) {
            blendshapes.forEach(element => {
                this.headMesh.forEach(mesh => {
                    const m = mesh as any; // Cast to access morphTargetDictionary
                    if (m.morphTargetDictionary && m.morphTargetInfluences) {
                        const index = m.morphTargetDictionary[element.categoryName];
                        if (index !== undefined && index >= 0) {
                            m.morphTargetInfluences[index] = element.score;
                        }
                    }
                });
            });
        }

        if (rotation) {
            const parts = this.nodes;
            // Rotation factors borrowed from React code
            if (parts['Head']) parts['Head'].rotation.set(rotation.x, rotation.y, rotation.z);
            if (parts['Neck']) parts['Neck'].rotation.set(rotation.x / 5 + 0.3, rotation.y / 5, rotation.z / 5);
            if (parts['Spine2']) parts['Spine2'].rotation.set(rotation.x / 10, rotation.y / 10, rotation.z / 10);

            // Shoulders, Arms, etc. (Simplifying for now, can add all)
            if (parts['Wolf3D_Shoulder_L']) parts['Wolf3D_Shoulder_L'].rotation.set(rotation.x / 15, rotation.y / 15, rotation.z / 15);
            if (parts['Wolf3D_Shoulder_R']) parts['Wolf3D_Shoulder_R'].rotation.set(rotation.x / 15, rotation.y / 15, rotation.z / 15);
        }

        this.renderer.render(this.scene, this.camera);
    }
}
