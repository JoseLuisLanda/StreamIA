import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FaceTrackingService } from '../../services/face-tracking.service';
import { FACE_MESH_TRIANGULATION } from '../../data/face-mesh-triangulation';
import * as THREE from 'three';

interface MaskOption {
  id: string;
  name: string;
  imagePath: string;
  uvScaleX?: number;
  uvScaleY?: number;
  uvOffsetX?: number;
  uvOffsetY?: number;
  texture?: THREE.Texture;
}

@Component({
  selector: 'app-ar-mask',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div #container class="ar-container">
      <canvas #maskCanvas class="ar-canvas"></canvas>
    </div>
    
    <!-- Mask Selector UI -->
    <div class="mask-selector">
      <button 
        *ngFor="let mask of masks" 
        (click)="selectMask(mask.id)"
        [class.active]="selectedMaskId === mask.id"
        class="mask-btn">
        <img [src]="mask.imagePath" [alt]="mask.name" />
        <span>{{ mask.name }}</span>
      </button>
      <button 
        (click)="selectMask('none')"
        [class.active]="selectedMaskId === 'none'"
        class="mask-btn none-btn">
        <span>🚫</span>
        <span>Sin Máscara</span>
      </button>
    </div>
    
    <div class="debug-info">
      <p>Face: {{ faceDetected ? '✅' : '❌' }}</p>
      <p>Mask: {{ selectedMaskId }}</p>
      <p>Mode: Three.js Mesh</p>
    </div>
  `,
  styles: [`
    .ar-container {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 101;
    }
    
    .ar-canvas {
      width: 100%;
      height: 100%;
    }
    
    .mask-selector {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 12px;
      z-index: 300;
      background: rgba(0, 0, 0, 0.7);
      padding: 12px 20px;
      border-radius: 20px;
      backdrop-filter: blur(10px);
      pointer-events: auto;
    }
    
    .mask-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      background: rgba(255, 255, 255, 0.1);
      border: 2px solid transparent;
      border-radius: 12px;
      padding: 8px;
      cursor: pointer;
      transition: all 0.3s ease;
      color: white;
      font-size: 11px;
    }
    
    .mask-btn:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: scale(1.05);
    }
    
    .mask-btn.active {
      border-color: #00ffff;
      background: rgba(0, 255, 255, 0.2);
      box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
    }
    
    .mask-btn img {
      width: 50px;
      height: 50px;
      object-fit: contain;
      border-radius: 8px;
    }
    
    .none-btn span:first-child {
      font-size: 30px;
      line-height: 50px;
    }
    
    .debug-info {
      position: absolute;
      top: 10px;
      left: 10px;
      color: lime;
      font-family: monospace;
      font-size: 12px;
      z-index: 200;
      background: rgba(0,0,0,0.6);
      padding: 6px 10px;
      border-radius: 4px;
    }
    
    .debug-info p {
      margin: 2px 0;
    }
  `]
})
export class ArMaskComponent implements AfterViewInit, OnDestroy {
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('maskCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private trackService = inject(FaceTrackingService);
  private ngZone = inject(NgZone);
  private requestID: number = 0;

  // Three.js objects
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.OrthographicCamera;
  private faceMesh!: THREE.Mesh;
  private geometry!: THREE.BufferGeometry;
  private textureLoader = new THREE.TextureLoader();
  private uvReferenceByMask = new Map<string, Float32Array>();
  private noFaceFrameCount = 0;

  public faceDetected = false;
  public selectedMaskId = 'cat';

  public masks: MaskOption[] = [
    {
      id: 'cat',
      name: 'Gato',
      imagePath: 'assets/masks/cat.png',
      uvScaleX: 0.58,
      uvScaleY: 0.60,
      uvOffsetX: 0,
      uvOffsetY: 0.02,
    },
    {
      id: 'monster',
      name: 'Monstruo',
      imagePath: 'assets/masks/monster.png',
      uvScaleX: 0.60,
      uvScaleY: 0.62,
      uvOffsetX: 0,
      uvOffsetY: 0.01,
    },
    {
      id: 'robot',
      name: 'Robot',
      imagePath: 'assets/masks/robot.png',
      uvScaleX: 0.62,
      uvScaleY: 0.64,
      uvOffsetX: 0,
      uvOffsetY: 0.01,
    }
  ];

  private getActiveUvConfig(): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
    const selectedMask = this.masks.find((mask) => mask.id === this.selectedMaskId);
    return {
      scaleX: selectedMask?.uvScaleX ?? 0.60,
      scaleY: selectedMask?.uvScaleY ?? 0.62,
      offsetX: selectedMask?.uvOffsetX ?? 0,
      offsetY: selectedMask?.uvOffsetY ?? 0,
    };
  }

  ngAfterViewInit() {
    this.initThreeJS();
    this.loadTextures();
    this.updateMaterial();

    this.ngZone.runOutsideAngular(() => {
      this.animate();
    });
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.requestID);
    this.renderer?.dispose();
  }

  private initThreeJS() {
    const container = this.containerRef.nativeElement;
    const canvas = this.canvasRef.nativeElement;
    const rect = container.getBoundingClientRect();

    // Create renderer with transparency
    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: true
    });
    this.renderer.setSize(rect.width, rect.height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);

    // Create scene
    this.scene = new THREE.Scene();

    // Create orthographic camera for 2D overlay
    // Standard Three.js: left, right, top, bottom, near, far
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
    this.camera.position.z = 0.5;

    // Create initial geometry (will be updated with face data)
    this.createFaceMeshGeometry();
  }

  private createFaceMeshGeometry() {
    this.geometry = new THREE.BufferGeometry();

    // Initialize with 468 vertices (will be updated each frame)
    const positions = new Float32Array(468 * 3);
    const uvs = new Float32Array(468 * 2);

    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    // Filter triangulation to only include valid indices (0-467)
    const validIndices: number[] = [];
    for (let i = 0; i < FACE_MESH_TRIANGULATION.length; i += 3) {
      const a = FACE_MESH_TRIANGULATION[i];
      const b = FACE_MESH_TRIANGULATION[i + 1];
      const c = FACE_MESH_TRIANGULATION[i + 2];

      // Only include triangle if all indices are valid (0-467)
      if (a < 468 && b < 468 && c < 468 && a >= 0 && b >= 0 && c >= 0) {
        validIndices.push(a, b, c);
      }
    }


    // Set indices from validated triangulation
    const indices = new Uint16Array(validIndices);
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Create material
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthTest: false,
      wireframe: false // Set to true to see triangle edges
    });

    this.faceMesh = new THREE.Mesh(this.geometry, material);
    this.scene.add(this.faceMesh);
  }

  private loadTextures() {
    this.masks.forEach(mask => {
      this.textureLoader.load(mask.imagePath, (texture) => {
        // Don't flip - we handle orientation in UV calculation
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        mask.texture = texture;
        if (mask.id === this.selectedMaskId) {
          this.updateMaterial();
        }
      });
    });
  }

  selectMask(maskId: string) {
    console.log('Selecting mask:', maskId);
    this.ngZone.run(() => {
      this.selectedMaskId = maskId;
      this.uvReferenceByMask.delete(maskId);
      this.updateMaterial();
    });
  }

  private updateMaterial() {
    if (!this.faceMesh) return;

    const material = this.faceMesh.material as THREE.MeshBasicMaterial;

    if (this.selectedMaskId === 'none') {
      material.visible = false;
    } else {
      const selectedMask = this.masks.find(m => m.id === this.selectedMaskId);
      if (selectedMask?.texture) {
        material.map = selectedMask.texture;
        material.needsUpdate = true;
        material.visible = true;
      }
    }
  }

  private animate() {
    this.requestID = requestAnimationFrame(this.animate.bind(this));

    const landmarks = this.trackService.landmarks();
    const container = this.containerRef.nativeElement;
    const rect = container.getBoundingClientRect();

    // Update renderer size if needed
    if (this.renderer.domElement.width !== rect.width ||
      this.renderer.domElement.height !== rect.height) {
      this.renderer.setSize(rect.width, rect.height);
    }

    if (landmarks && landmarks.length >= 468) {
      this.noFaceFrameCount = 0;
      this.faceDetected = true;
      this.updateFaceMesh(landmarks, rect.width, rect.height);
      this.faceMesh.visible = this.selectedMaskId !== 'none';
    } else {
      this.noFaceFrameCount += 1;
      if (this.noFaceFrameCount > 15) {
        this.uvReferenceByMask.delete(this.selectedMaskId);
      }
      this.faceDetected = false;
      this.faceMesh.visible = false;
    }

    this.renderer.render(this.scene, this.camera);
  }

  private updateFaceMesh(landmarks: any[], width: number, height: number) {
    const positions = this.geometry.attributes['position'] as THREE.BufferAttribute;
    const uvs = this.geometry.attributes['uv'] as THREE.BufferAttribute;

    const { width: videoWidth, height: videoHeight } = this.trackService.getVideoDimensions();
    const videoAspect = videoWidth / videoHeight;
    const containerAspect = width / height;

    let renderedVideoWidth = width;
    let renderedVideoHeight = height;
    let cropOffsetX = 0;
    let cropOffsetY = 0;

    if (videoAspect > containerAspect) {
      renderedVideoHeight = height;
      renderedVideoWidth = height * videoAspect;
      cropOffsetX = (renderedVideoWidth - width) / 2;
    } else {
      renderedVideoWidth = width;
      renderedVideoHeight = width / videoAspect;
      cropOffsetY = (renderedVideoHeight - height) / 2;
    }

    const projected = new Array<{ x: number; y: number; z: number }>(landmarks.length);

    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      projected[i] = {
        x: (lm.x * renderedVideoWidth - cropOffsetX) / width,
        y: (lm.y * renderedVideoHeight - cropOffsetY) / height,
        z: lm.z ?? 0,
      };
    }

    // Calculate face bounding box
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (let i = 0; i < projected.length; i++) {
      minX = Math.min(minX, projected[i].x);
      maxX = Math.max(maxX, projected[i].x);
      minY = Math.min(minY, projected[i].y);
      maxY = Math.max(maxY, projected[i].y);
    }

    const faceWidth = Math.max(maxX - minX, 0.001);
    const faceHeight = Math.max(maxY - minY, 0.001);
    const faceCenterX = (minX + maxX) / 2;
    const faceCenterY = (minY + maxY) / 2;

    const uvConfig = this.getActiveUvConfig();
    const currentMaskKey = this.selectedMaskId;
    let referenceUv = this.uvReferenceByMask.get(currentMaskKey);

    if (!referenceUv || referenceUv.length !== landmarks.length * 2) {
      referenceUv = new Float32Array(landmarks.length * 2);
      for (let i = 0; i < projected.length; i++) {
        const normalizedX = (projected[i].x - faceCenterX) / faceWidth;
        const normalizedY = (projected[i].y - faceCenterY) / faceHeight;

        const u = THREE.MathUtils.clamp(
          0.5 + uvConfig.offsetX + normalizedX * uvConfig.scaleX,
          0.06,
          0.94
        );
        const v = THREE.MathUtils.clamp(
          0.5 + uvConfig.offsetY + normalizedY * uvConfig.scaleY,
          0.06,
          0.94
        );

        referenceUv[i * 2] = u;
        referenceUv[i * 2 + 1] = v;
      }
      this.uvReferenceByMask.set(currentMaskKey, referenceUv);
    }

    // Update vertex positions and UVs
    for (let i = 0; i < landmarks.length; i++) {
      const projectedX = projected[i].x;
      const projectedY = projected[i].y;
      const projectedZ = projected[i].z;

      // Position in normalized screen space (0-1)
      // Mirror X for selfie view, invert Y for Three.js (Y up vs Y down)
      const x = 1 - THREE.MathUtils.clamp(projectedX, 0, 1);
      const y = 1 - THREE.MathUtils.clamp(projectedY, 0, 1);
      const z = THREE.MathUtils.clamp(-projectedZ * 0.35, -0.25, 0.25);

      positions.setXYZ(i, x, y, z);

      uvs.setXY(i, referenceUv[i * 2], referenceUv[i * 2 + 1]);
    }

    positions.needsUpdate = true;
    uvs.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}








