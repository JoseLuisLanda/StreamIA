import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FaceTrackingService } from '../../services/face-tracking.service';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface MaskOption {
  id: string;
  name: string;
  modelPath: string;
  type: 'glasses' | 'facial-hair' | 'hair' | 'mask' | 'hat' | 'clothing' | 'avatar';
  model?: THREE.Group;
  loaded?: boolean;
  // State
  isActive?: boolean;
  isSelected?: boolean;  // Para saber cuál se está editando con gestures
  // Gesture adjustments
  scaleOffset?: number;
  positionOffsetX?: number;
  positionOffsetY?: number;
  positionOffsetZ?: number;
}

@Component({
  selector: 'app-ar-mask',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div #container class="ar-container">
      <canvas #maskCanvas class="ar-canvas"></canvas>
    </div>
    
    <!-- Accessory Selector UI -->
    <div class="mask-selector">
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('glasses')"
          [class.active]="isMaskActive('glasses')"
          [class.selected]="selectedMaskId === 'glasses'"
          class="mask-btn">
          <span class="icon">👓</span>
          <span>Lentes</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'glasses'"
              [class.active]="isMaskActive('glasses')"
              (click)="selectForEditing($event, 'glasses')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('glasses1')"
          [class.active]="isMaskActive('glasses1')"
          [class.selected]="selectedMaskId === 'glasses1'"
          class="mask-btn">
          <span class="icon">🕶️</span>
          <span>Lentes 2</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'glasses1'"
              [class.active]="isMaskActive('glasses1')"
              (click)="selectForEditing($event, 'glasses1')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('mustache')"
          [class.active]="isMaskActive('mustache')"
          [class.selected]="selectedMaskId === 'mustache'"
          class="mask-btn">
          <span class="icon">👨</span>
          <span>Bigote</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'mustache'"
              [class.active]="isMaskActive('mustache')"
              (click)="selectForEditing($event, 'mustache')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('mustache1')"
          [class.active]="isMaskActive('mustache1')"
          [class.selected]="selectedMaskId === 'mustache1'"
          class="mask-btn">
          <span class="icon">🧔</span>
          <span>Bigote 2</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'mustache1'"
              [class.active]="isMaskActive('mustache1')"
              (click)="selectForEditing($event, 'mustache1')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('beard')"
          [class.active]="isMaskActive('beard')"
          [class.selected]="selectedMaskId === 'beard'"
          class="mask-btn">
          <span class="icon">🧔‍♂️</span>
          <span>Barba</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'beard'"
              [class.active]="isMaskActive('beard')"
              (click)="selectForEditing($event, 'beard')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('mask')"
          [class.active]="isMaskActive('mask')"
          [class.selected]="selectedMaskId === 'mask'"
          class="mask-btn">
          <span class="icon">🎭</span>
          <span>Máscara</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'mask'"
              [class.active]="isMaskActive('mask')"
              (click)="selectForEditing($event, 'mask')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('mask1')"
          [class.active]="isMaskActive('mask1')"
          [class.selected]="selectedMaskId === 'mask1'"
          class="mask-btn">
          <span class="icon">😷</span>
          <span>Máscara 2</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'mask1'"
              [class.active]="isMaskActive('mask1')"
              (click)="selectForEditing($event, 'mask1')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('gorra')"
          [class.active]="isMaskActive('gorra')"
          [class.selected]="selectedMaskId === 'gorra'"
          class="mask-btn">
          <span class="icon">🧢</span>
          <span>Gorra</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'gorra'"
              [class.active]="isMaskActive('gorra')"
              (click)="selectForEditing($event, 'gorra')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('gorra1')"
          [class.active]="isMaskActive('gorra1')"
          [class.selected]="selectedMaskId === 'gorra1'"
          class="mask-btn">
          <span class="icon">🎩</span>
          <span>Gorra 2</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'gorra1'"
              [class.active]="isMaskActive('gorra1')"
              (click)="selectForEditing($event, 'gorra1')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('hair')"
          [class.active]="isMaskActive('hair')"
          [class.selected]="selectedMaskId === 'hair'"
          class="mask-btn">
          <span class="icon">💇</span>
          <span>Cabello</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'hair'"
              [class.active]="isMaskActive('hair')"
              (click)="selectForEditing($event, 'hair')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('hair1')"
          [class.active]="isMaskActive('hair1')"
          [class.selected]="selectedMaskId === 'hair1'"
          class="mask-btn">
          <span class="icon">💁</span>
          <span>Cabello 2</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'hair1'"
              [class.active]="isMaskActive('hair1')"
              (click)="selectForEditing($event, 'hair1')">✏️</span>
      </div>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('tshirt')"
          [class.active]="isMaskActive('tshirt')"
          [class.selected]="selectedMaskId === 'tshirt'"
          class="mask-btn">
          <span class="icon">👕</span>
          <span>Playera</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'tshirt'"
              [class.active]="isMaskActive('tshirt')"
              (click)="selectForEditing($event, 'tshirt')">✏️</span>
      </div>
      <button 
        (click)="clearAll()"
        class="mask-btn clear-btn">
        <span class="icon">🗑️</span>
        <span>Limpiar</span>
      </button>
      <button 
        (click)="resetAdjustments()"
        [disabled]="selectedMaskId === 'none'"
        class="mask-btn reset-btn"
        title="Restablecer posición y tamaño del seleccionado">
        <span class="icon">↺</span>
        <span>Reset</span>
      </button>
      <button 
        (click)="switchCamera()"
        class="mask-btn camera-switch-btn"
        title="Cambiar cámara">
        <span class="icon">🔄</span>
        <span>Cámara</span>
      </button>
      <div class="mask-btn-wrapper">
        <button 
          (click)="toggleMask('avatar')"
          [class.active]="isMaskActive('avatar')"
          [class.selected]="selectedMaskId === 'avatar'"
          class="mask-btn avatar-btn"
          title="Avatar sincronizado">
          <span class="icon">🧑</span>
          <span>Avatar</span>
        </button>
        <span class="edit-indicator" 
              [class.editing]="selectedMaskId === 'avatar'"
              [class.active]="isMaskActive('avatar')"
              (click)="selectForEditing($event, 'avatar')">✏️</span>
      </div>
    </div>
    
    <div class="debug-info">
      <p>Face: {{ faceDetected ? '✅' : '❌' }}</p>
      <p>Activos: {{ getActiveCount() }}</p>
      <p>Editando: <span style="color: #ffaa00">✏️ {{ selectedMaskId }}</span></p>
      <p>Mode: Multi-Accesorio</p>
      <p style="font-size: 10px; margin-top: 8px; color: #aaa;">
        Botón: Activar/Desactivar<br>
        ✏️ Click en lápiz: Seleccionar para editar<br>
        📱 Pinch: Zoom | Drag: Mover<br>
        🖱️ Scroll: Zoom | Shift+Scroll: Profundidad | Drag: Mover
      </p>
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
      pointer-events: auto;
      touch-action: none;
      cursor: grab;
    }
    
    .ar-canvas:active {
      cursor: grabbing;
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
      max-width: 95vw;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.3) transparent;
    }
    
    .mask-selector::-webkit-scrollbar {
      height: 6px;
    }
    
    .mask-selector::-webkit-scrollbar-track {
      background: transparent;
    }
    
    .mask-selector::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.3);
      border-radius: 3px;
    }
    
    .mask-selector::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,0.5);
    }
    
    .mask-btn-wrapper {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    
    .mask-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      background: rgba(255, 255, 255, 0.1);
      border: 2px solid transparent;
      border-radius: 12px;
      padding: 8px 12px;
      cursor: pointer;
      transition: all 0.3s ease;
      color: white;
      font-size: 11px;
      min-width: 70px;
      position: relative;
    }
    
    .mask-btn .icon {
      font-size: 32px;
      line-height: 1;
    }
    
    .edit-indicator {
      position: absolute;
      top: -2px;
      right: -2px;
      font-size: 14px;
      opacity: 0;
      transition: all 0.3s ease;
      filter: grayscale(100%);
      cursor: pointer;
      padding: 4px;
      z-index: 10;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 50%;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .edit-indicator.active {
      opacity: 0.5;
    }
    
    .mask-btn-wrapper:hover .edit-indicator.active {
      opacity: 0.8;
      background: rgba(0, 0, 0, 0.5);
      transform: scale(1.1);
    }
    
    .edit-indicator.editing {
      opacity: 1 !important;
      filter: grayscale(0%);
      color: #ffaa00;
      background: rgba(255, 170, 0, 0.3);
      border: 2px solid #ffaa00;
      animation: pulse 1.5s ease-in-out infinite;
    }
    
    @keyframes pulse {
      0%, 100% { 
        transform: scale(1);
        box-shadow: 0 0 0 0 rgba(255, 170, 0, 0.7);
      }
      50% { 
        transform: scale(1.15);
        box-shadow: 0 0 8px 4px rgba(255, 170, 0, 0.3);
      }
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
    
    .mask-btn.selected {
      border-color: #ffaa00;
      box-shadow: 0 0 20px rgba(255, 170, 0, 0.8);
    }
    
    .clear-btn {
      min-width: 70px;
      background: rgba(255, 50, 50, 0.2) !important;
    }
    
    .clear-btn:hover {
      background: rgba(255, 50, 50, 0.3) !important;
    }
    
    .reset-btn {
      min-width: 70px;
      background: rgba(255, 100, 100, 0.2) !important;
    }
    
    .reset-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    
    .reset-btn:not(:disabled):hover {
      background: rgba(255, 100, 100, 0.3) !important;
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
  private camera!: THREE.PerspectiveCamera;
  private gltfLoader = new GLTFLoader();
  
  // 3D model objects for each accessory
  private glassesModel!: THREE.Group;
  private glasses1Model!: THREE.Group;
  private mustacheModel!: THREE.Group;
  private mustache1Model!: THREE.Group;
  private maskModel!: THREE.Group;
  private mask1Model!: THREE.Group;
  private gorraModel!: THREE.Group;
  private gorra1Model!: THREE.Group;
  private hairModel!: THREE.Group;
  private hair1Model!: THREE.Group;
  private tshirtModel!: THREE.Group;
  private beardModel!: THREE.Group;
  
  // Lights
  private ambientLight!: THREE.AmbientLight;
  private directionalLight!: THREE.DirectionalLight;

  // Avatar with bones (Ready Player Me)
  private avatarModel: THREE.Object3D | null = null;
  private avatarNodes: Record<string, THREE.Object3D> = {};
  private avatarHeadMeshes: THREE.Object3D[] = [];
  public avatarEnabled = false;
  public avatarUrl = 'https://models.readyplayer.me/6984a7a905b43df7aaeb9df1.glb?morphTargets=ARKit&textureAtlas=1024';
  private breathingTime = 0;
  private avatarCalculatedScale: number | null = null;  // Scale calculated once based on face proportions

  public faceDetected = false;
  public selectedMaskId = 'none';  // Para UI, último clickeado para gestures

  // Gesture control state
  private isDragging = false;
  private lastTouchDistance = 0;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private canvasRect!: DOMRect;

  public masks: MaskOption[] = [
    {
      id: 'glasses',
      name: 'Lentes',
      modelPath: 'assets/models/glasses.glb',
      type: 'glasses',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'glasses1',
      name: 'Lentes 2',
      modelPath: 'assets/models/glasses1.glb',
      type: 'glasses',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'mustache',
      name: 'Bigote',
      modelPath: 'assets/models/mustache.glb',
      type: 'facial-hair',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'mustache1',
      name: 'Bigote 2',
      modelPath: 'assets/models/mustache1.glb',
      type: 'facial-hair',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'beard',
      name: 'Barba',
      modelPath: 'assets/models/beard.glb',
      type: 'facial-hair',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'mask',
      name: 'Máscara',
      modelPath: 'assets/models/mask.glb',
      type: 'mask',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'mask1',
      name: 'Máscara 2',
      modelPath: 'assets/models/mask1.glb',
      type: 'mask',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'gorra',
      name: 'Gorra',
      modelPath: 'assets/models/gorra.glb',
      type: 'hat',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'gorra1',
      name: 'Gorra 2',
      modelPath: 'assets/models/gorra1.glb',
      type: 'hat',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'hair',
      name: 'Cabello',
      modelPath: 'assets/models/hair.glb',
      type: 'hair',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'hair1',
      name: 'Cabello 2',
      modelPath: 'assets/models/hair1.glb',
      type: 'hair',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0
    },
    {
      id: 'tshirt',
      name: 'Playera',
      modelPath: 'assets/models/tshirt.glb',
      type: 'clothing',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    },
    {
      id: 'avatar',
      name: 'Avatar RPM',
      modelPath: 'https://models.readyplayer.me/67a8d1a1f5f0c1d5a6993bc1.glb',
      type: 'avatar',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0
    }
  ];

  ngAfterViewInit() {
    this.initThreeJS();
    this.setupLighting();
    this.create3DModels();
    this.load3DModels();
    this.setupGestureControls();

    this.ngZone.runOutsideAngular(() => {
      this.animate();
    });
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.requestID);
    this.removeGestureControls();
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
    
    // Enable depth testing for 3D models
    this.renderer.sortObjects = true;

    // Create scene
    this.scene = new THREE.Scene();

    // Create perspective camera for 3D depth
    this.camera = new THREE.PerspectiveCamera(45, rect.width / rect.height, 0.1, 100);
    this.camera.position.set(0, 0, 2);
    this.camera.lookAt(0, 0, 0);
  }

  private setupLighting() {
    // Ambient light for overall illumination
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(this.ambientLight);

    // Directional light for highlights and shadows
    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    this.directionalLight.position.set(0, 0, 1);
    this.scene.add(this.directionalLight);
  }

  private create3DModels() {
    // Create empty groups for each accessory
    this.glassesModel = new THREE.Group();
    this.glassesModel.visible = false;
    this.scene.add(this.glassesModel);

    this.glasses1Model = new THREE.Group();
    this.glasses1Model.visible = false;
    this.scene.add(this.glasses1Model);

    this.mustacheModel = new THREE.Group();
    this.mustacheModel.visible = false;
    this.scene.add(this.mustacheModel);

    this.mustache1Model = new THREE.Group();
    this.mustache1Model.visible = false;
    this.scene.add(this.mustache1Model);

    this.beardModel = new THREE.Group();
    this.beardModel.visible = false;
    this.scene.add(this.beardModel);

    this.maskModel = new THREE.Group();
    this.maskModel.visible = false;
    this.scene.add(this.maskModel);

    this.mask1Model = new THREE.Group();
    this.mask1Model.visible = false;
    this.scene.add(this.mask1Model);

    this.gorraModel = new THREE.Group();
    this.gorraModel.visible = false;
    this.scene.add(this.gorraModel);

    this.gorra1Model = new THREE.Group();
    this.gorra1Model.visible = false;
    this.scene.add(this.gorra1Model);

    this.hairModel = new THREE.Group();
    this.hairModel.visible = false;
    this.scene.add(this.hairModel);

    this.hair1Model = new THREE.Group();
    this.hair1Model.visible = false;
    this.scene.add(this.hair1Model);

    this.tshirtModel = new THREE.Group();
    this.tshirtModel.visible = false;
    this.scene.add(this.tshirtModel);
  }

  private load3DModels() {
    this.masks.forEach(mask => {
      this.gltfLoader.load(
        mask.modelPath,
        (gltf) => {
          mask.model = gltf.scene;
          mask.loaded = true;
          console.log(`✅ Loaded 3D model: ${mask.name}`);
          
          // Assign model to appropriate group
          if (mask.id === 'glasses') {
            this.glassesModel.add(gltf.scene);
          } else if (mask.id === 'glasses1') {
            this.glasses1Model.add(gltf.scene);
          } else if (mask.id === 'mustache') {
            this.mustacheModel.add(gltf.scene);
          } else if (mask.id === 'mustache1') {
            this.mustache1Model.add(gltf.scene);
          } else if (mask.id === 'beard') {
            this.beardModel.add(gltf.scene);
          } else if (mask.id === 'mask') {
            this.maskModel.add(gltf.scene);
          } else if (mask.id === 'mask1') {
            this.mask1Model.add(gltf.scene);
          } else if (mask.id === 'gorra') {
            this.gorraModel.add(gltf.scene);
          } else if (mask.id === 'gorra1') {
            this.gorra1Model.add(gltf.scene);
          } else if (mask.id === 'hair') {
            this.hairModel.add(gltf.scene);
          } else if (mask.id === 'hair1') {
            this.hair1Model.add(gltf.scene);
          } else if (mask.id === 'tshirt') {
            this.tshirtModel.add(gltf.scene);
          }
        },
        (progress) => {
          const percent = (progress.loaded / progress.total) * 100;
          console.log(`Loading ${mask.name}: ${percent.toFixed(0)}%`);
        },
        (error) => {
          console.error(`❌ Error loading ${mask.name}:`, error);
        }
      );
    });
  }

  selectMask(maskId: string) {
    console.log('Selecting accessory:', maskId);
    this.ngZone.run(() => {
      this.selectedMaskId = maskId;
      this.updateVisibility();
    });
  }

  toggleMask(maskId: string) {
    const mask = this.masks.find(m => m.id === maskId);
    if (!mask) return;
    
    this.ngZone.run(() => {
      // Toggle active state
      mask.isActive = !mask.isActive;
      
      // Si se activa el avatar, resetear la escala calculada para que recalcule
      if (mask.isActive && maskId === 'avatar') {
        this.avatarCalculatedScale = null;
      }
      
      // Si se activa, se convierte en el seleccionado para gestures
      if (mask.isActive) {
        this.selectedMaskId = maskId;
        // Deseleccionar otros
        this.masks.forEach(m => m.isSelected = false);
        mask.isSelected = true;
      } else {
        // Si se desactiva y era el seleccionado, seleccionar otro activo
        if (this.selectedMaskId === maskId) {
          const otherActive = this.masks.find(m => m.isActive && m.id !== maskId);
          this.selectedMaskId = otherActive?.id || 'none';
          if (otherActive) {
            this.masks.forEach(m => m.isSelected = false);
            otherActive.isSelected = true;
          }
        }
        mask.isSelected = false;
      }
      
      this.updateVisibility();
      console.log(`Toggled ${maskId}: ${mask.isActive ? 'ON' : 'OFF'}, isSelected: ${mask.isSelected}`);
    });
  }

  selectForEditing(event: Event, maskId: string) {
    event.stopPropagation(); // Prevenir que se dispare el toggle
    event.preventDefault();  // Prevenir comportamiento default
    
    const mask = this.masks.find(m => m.id === maskId);
    if (!mask) return;
    
    this.ngZone.run(() => {
      // SIEMPRE asegurar que esté activo antes de editar
      if (!mask.isActive) {
        mask.isActive = true;
      }
      
      // Seleccionar para edición (sin tocar isActive de nuevo)
      this.selectedMaskId = maskId;
      this.masks.forEach(m => m.isSelected = (m.id === maskId));
      
      // Asegurar visibilidad
      this.updateVisibility();
      
      console.log(`Selected for editing: ${maskId}, isActive: ${mask.isActive}, isSelected: ${mask.isSelected}`);
    });
  }

  isMaskActive(maskId: string): boolean {
    return this.masks.find(m => m.id === maskId)?.isActive || false;
  }

  clearAll() {
    this.ngZone.run(() => {
      // Clear all accessories and avatar
      this.masks.forEach(m => {
        m.isActive = false;
        m.isSelected = false;
        m.scaleOffset = 1.0;
        m.positionOffsetX = 0;
        m.positionOffsetY = 0;
        m.positionOffsetZ = 0;
      });
      this.selectedMaskId = 'none';
      
      this.updateVisibility();
      console.log('Cleared all accessories and avatar');
    });
  }

  getActiveCount(): number {
    return this.masks.filter(m => m.isActive).length;
  }

  resetAdjustments() {
    this.ngZone.run(() => {
      const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
      if (activeMask) {
        activeMask.scaleOffset = 1.0;
        activeMask.positionOffsetX = 0;
        activeMask.positionOffsetY = 0;
        activeMask.positionOffsetZ = 0;
        console.log(`Reset adjustments for ${this.selectedMaskId}`);
      }
    });
  }

  getLoadedModelsCount(): number {
    return this.masks.filter(m => m.loaded).length;
  }

  private setupGestureControls() {
    const canvas = this.canvasRef.nativeElement;
    this.canvasRect = canvas.getBoundingClientRect();

    // Touch events (móvil)
    canvas.addEventListener('touchstart', this.onTouchStart.bind(this));
    canvas.addEventListener('touchmove', this.onTouchMove.bind(this));
    canvas.addEventListener('touchend', this.onTouchEnd.bind(this));

    // Mouse events (desktop)
    canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    canvas.addEventListener('wheel', this.onWheel.bind(this), { passive: false });

    // Update canvas rect on resize
    window.addEventListener('resize', () => {
      this.canvasRect = canvas.getBoundingClientRect();
    });
  }

  private removeGestureControls() {
    const canvas = this.canvasRef.nativeElement;
    if (!canvas) return;

    canvas.removeEventListener('touchstart', this.onTouchStart.bind(this));
    canvas.removeEventListener('touchmove', this.onTouchMove.bind(this));
    canvas.removeEventListener('touchend', this.onTouchEnd.bind(this));
    canvas.removeEventListener('mousedown', this.onMouseDown.bind(this));
    canvas.removeEventListener('mousemove', this.onMouseMove.bind(this));
    canvas.removeEventListener('mouseup', this.onMouseUp.bind(this));
    canvas.removeEventListener('wheel', this.onWheel.bind(this));
  }

  // Touch gesture handlers
  private onTouchStart(event: TouchEvent) {
    if (this.selectedMaskId === 'none' || !this.faceDetected) return;

    if (event.touches.length === 2) {
      // Pinch to zoom
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      this.lastTouchDistance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );
    } else if (event.touches.length === 1) {
      // Single touch drag
      this.isDragging = true;
      this.lastMouseX = event.touches[0].clientX;
      this.lastMouseY = event.touches[0].clientY;
    }
  }

  private onTouchMove(event: TouchEvent) {
    if (this.selectedMaskId === 'none' || !this.faceDetected) return;
    event.preventDefault();

    const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
    if (!activeMask) return;

    if (event.touches.length === 2 && this.lastTouchDistance > 0) {
      // Pinch to zoom
      const touch1 = event.touches[0];
      const touch2 = event.touches[1];
      const distance = Math.hypot(
        touch2.clientX - touch1.clientX,
        touch2.clientY - touch1.clientY
      );
      
      const scaleDelta = (distance - this.lastTouchDistance) * 0.002;
      activeMask.scaleOffset = Math.max(0.3, Math.min(3.0, (activeMask.scaleOffset || 1.0) + scaleDelta));
      
      this.lastTouchDistance = distance;
    } else if (event.touches.length === 1 && this.isDragging) {
      // Drag to move
      const deltaX = event.touches[0].clientX - this.lastMouseX;
      const deltaY = event.touches[0].clientY - this.lastMouseY;
      
      activeMask.positionOffsetX = (activeMask.positionOffsetX || 0) + deltaX * 0.001;
      activeMask.positionOffsetY = (activeMask.positionOffsetY || 0) - deltaY * 0.001;
      
      this.lastMouseX = event.touches[0].clientX;
      this.lastMouseY = event.touches[0].clientY;
    }
  }

  private onTouchEnd(event: TouchEvent) {
    this.isDragging = false;
    this.lastTouchDistance = 0;
  }

  // Mouse gesture handlers (desktop)
  private onMouseDown(event: MouseEvent) {
    if (this.selectedMaskId === 'none' || !this.faceDetected) return;
    
    this.isDragging = true;
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
  }

  private onMouseMove(event: MouseEvent) {
    if (!this.isDragging || this.selectedMaskId === 'none' || !this.faceDetected) return;

    const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
    if (!activeMask) return;

    const deltaX = event.clientX - this.lastMouseX;
    const deltaY = event.clientY - this.lastMouseY;
    
    activeMask.positionOffsetX = (activeMask.positionOffsetX || 0) + deltaX * 0.001;
    activeMask.positionOffsetY = (activeMask.positionOffsetY || 0) - deltaY * 0.001;
    
    this.lastMouseX = event.clientX;
    this.lastMouseY = event.clientY;
  }

  private onMouseUp(event: MouseEvent) {
    this.isDragging = false;
  }

  private onWheel(event: WheelEvent) {
    if (this.selectedMaskId === 'none' || !this.faceDetected) return;
    event.preventDefault();

    const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
    if (!activeMask) return;

    if (event.shiftKey) {
      // Shift + Scroll: Move in Z axis (depth)
      const zDelta = -event.deltaY * 0.002;
      activeMask.positionOffsetZ = (activeMask.positionOffsetZ || 0) + zDelta;
      console.log(`Z offset for ${this.selectedMaskId}: ${activeMask.positionOffsetZ.toFixed(3)}`);
    } else {
      // Normal scroll: Scale
      const scaleDelta = -event.deltaY * 0.0005;
      activeMask.scaleOffset = Math.max(0.3, Math.min(3.0, (activeMask.scaleOffset || 1.0) + scaleDelta));
    }
  }

  private updateVisibility() {
    // Handle avatar separately with loading
    const avatarMask = this.masks.find(m => m.id === 'avatar');
    if (avatarMask) {
      this.avatarEnabled = avatarMask.isActive || false;
      if (this.avatarEnabled && !this.avatarModel) {
        this.loadAvatar();
      } else if (this.avatarModel) {
        this.avatarModel.visible = this.avatarEnabled && this.faceDetected;
      }
    }
    
    // Update visibility based on active state, not selected
    this.glassesModel.visible = this.isMaskActive('glasses') && this.faceDetected;
    this.glasses1Model.visible = this.isMaskActive('glasses1') && this.faceDetected;
    this.mustacheModel.visible = this.isMaskActive('mustache') && this.faceDetected;
    this.mustache1Model.visible = this.isMaskActive('mustache1') && this.faceDetected;
    this.beardModel.visible = this.isMaskActive('beard') && this.faceDetected;
    this.maskModel.visible = this.isMaskActive('mask') && this.faceDetected;
    this.mask1Model.visible = this.isMaskActive('mask1') && this.faceDetected;
    this.gorraModel.visible = this.isMaskActive('gorra') && this.faceDetected;
    this.gorra1Model.visible = this.isMaskActive('gorra1') && this.faceDetected;
    this.hairModel.visible = this.isMaskActive('hair') && this.faceDetected;
    this.hair1Model.visible = this.isMaskActive('hair1') && this.faceDetected;
    this.tshirtModel.visible = this.isMaskActive('tshirt') && this.faceDetected;
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
      this.camera.aspect = rect.width / rect.height;
      this.camera.updateProjectionMatrix();
    }

    if (landmarks && landmarks.length >= 468) {
      this.faceDetected = true;
      this.updateAccessories(landmarks, rect.width, rect.height);
      this.updateVisibility();
      this.updateAvatar(); // Update avatar with face tracking
    } else {
      this.faceDetected = false;
      this.updateVisibility();
    }

    this.renderer.render(this.scene, this.camera);
  }

  private updateAccessories(landmarks: any[], width: number, height: number) {
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

    // Helper to project landmark to normalized coordinates
    const project = (lm: any) => ({
      x: (lm.x * renderedVideoWidth - cropOffsetX) / width,
      y: (lm.y * renderedVideoHeight - cropOffsetY) / height,
      z: lm.z ?? 0,
    });

    // Key landmarks
    const leftEye = project(landmarks[33]);
    const rightEye = project(landmarks[263]);
    const nose = project(landmarks[1]);
    const upperLip = project(landmarks[13]);
    const lowerLip = project(landmarks[14]);
    const chin = project(landmarks[152]);
    const forehead = project(landmarks[10]); // Top of forehead

    // Calculate eye center and distance
    const eyeCenterX = (leftEye.x + rightEye.x) / 2;
    const eyeCenterY = (leftEye.y + rightEye.y) / 2;
    const eyeDistance = Math.abs(rightEye.x - leftEye.x);
    const eyeAngle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

    // Calculate mouth center
    const mouthCenterX = (upperLip.x + lowerLip.x) / 2;
    const mouthCenterY = (upperLip.y + lowerLip.y) / 2;

    // Convert normalized coordinates (0-1) to 3D world coordinates
    // For perspective camera, we need to calculate position in 3D space
    const aspect = this.camera.aspect;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = 2; // Distance from camera (matches camera.position.z)
    const vFOV = 2 * Math.tan(fov / 2) * distance;
    const hFOV = vFOV * aspect;

    const toWorld3D = (x: number, y: number, z: number) => ({
      x: (0.5 - x) * hFOV,  // Inverted for mirrored video
      y: (0.5 - y) * vFOV,
      z: (z * 0.3),  // Small depth variation from face tracking
    });

    // Update glasses model (always update if active)
    if (this.isMaskActive('glasses') && this.glassesModel) {
      const mask = this.masks.find(m => m.id === 'glasses');
      const worldPos = toWorld3D(eyeCenterX, eyeCenterY, nose.z);
      
      // Apply position offsets from gestures
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.glassesModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      
      // Scale based on eye distance + gesture scale offset
      const baseScale = eyeDistance * 1.5;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.glassesModel.scale.set(finalScale, finalScale, finalScale);
      
      // Rotation (reduced to 30% to avoid over-rotation)
      this.glassesModel.rotation.z = eyeAngle * 0.5;
    }

    // Update mustache model (always update if active)
    if (this.isMaskActive('mustache') && this.mustacheModel) {
      const mask = this.masks.find(m => m.id === 'mustache');
      const mustacheY = upperLip.y - (eyeDistance * 0.05); // Ajustado para subir
      const worldPos = toWorld3D(mouthCenterX, mustacheY, nose.z);
      
      // Apply position offsets from gestures
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.mustacheModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      
      // Scale + gesture offset
      const baseScale = eyeDistance * 1.0;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.mustacheModel.scale.set(finalScale, finalScale, finalScale);
      
// Rotation (reduced to 50%)
      this.mustacheModel.rotation.z = eyeAngle * 0.5;
    }

    // Update glasses1 model
    if (this.isMaskActive('glasses1') && this.glasses1Model) {
      const mask = this.masks.find(m => m.id === 'glasses1');
      const worldPos = toWorld3D(eyeCenterX, eyeCenterY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.glasses1Model.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 1.4;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.glasses1Model.scale.set(finalScale, finalScale, finalScale);
      this.glasses1Model.rotation.z = eyeAngle * 0.5;
    }

    // Update mustache1 model
    if (this.isMaskActive('mustache1') && this.mustache1Model) {
      const mask = this.masks.find(m => m.id === 'mustache1');
      const mustacheY = upperLip.y - (eyeDistance * 0.05);
      const worldPos = toWorld3D(mouthCenterX, mustacheY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.mustache1Model.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 1.0;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.mustache1Model.scale.set(finalScale, finalScale, finalScale);
      this.mustache1Model.rotation.z = eyeAngle * 0.5;
    }

    // Update beard model
    if (this.isMaskActive('beard') && this.beardModel) {
      const mask = this.masks.find(m => m.id === 'beard');
      const beardY = chin.y + (eyeDistance * 0.15);
      const worldPos = toWorld3D(mouthCenterX, beardY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.beardModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 1.2;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.beardModel.scale.set(finalScale, finalScale, finalScale);
      this.beardModel.rotation.z = eyeAngle * 0.5;
    }

    // Update mask model (cubre toda la cara)
    if (this.isMaskActive('mask') && this.maskModel) {
      const mask = this.masks.find(m => m.id === 'mask');
      const faceCenterY = (eyeCenterY + nose.y) / 2;
      const worldPos = toWorld3D(eyeCenterX, faceCenterY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.maskModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 2.0;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.maskModel.scale.set(finalScale, finalScale, finalScale);
      this.maskModel.rotation.z = eyeAngle * 0.5;
    }

    // Update mask1 model
    if (this.isMaskActive('mask1') && this.mask1Model) {
      const mask = this.masks.find(m => m.id === 'mask1');
      const faceCenterY = (eyeCenterY + nose.y) / 2;
      const worldPos = toWorld3D(eyeCenterX, faceCenterY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.mask1Model.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 2.0;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.mask1Model.scale.set(finalScale, finalScale, finalScale);
      this.mask1Model.rotation.z = eyeAngle * 0.5;
    }

    // Update gorra model (sobre la cabeza)
    if (this.isMaskActive('gorra') && this.gorraModel) {
      const mask = this.masks.find(m => m.id === 'gorra');
      const hatY = forehead.y - (eyeDistance * 0.4);
      const worldPos = toWorld3D(eyeCenterX, hatY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = (mask?.positionOffsetZ || 0) - 0.15; // Gorra más atrás por defecto
      this.gorraModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 1.6;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.gorraModel.scale.set(finalScale, finalScale, finalScale);
      this.gorraModel.rotation.z = eyeAngle * 0.5;
    }

    // Update gorra1 model
    if (this.isMaskActive('gorra1') && this.gorra1Model) {
      const mask = this.masks.find(m => m.id === 'gorra1');
      const hatY = forehead.y - (eyeDistance * 0.4);
      const worldPos = toWorld3D(eyeCenterX, hatY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = (mask?.positionOffsetZ || 0) - 0.15; // Gorra más atrás por defecto
      this.gorra1Model.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 1.6;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.gorra1Model.scale.set(finalScale, finalScale, finalScale);
      this.gorra1Model.rotation.z = eyeAngle * 0.5;
    }

    // Update hair model
    if (this.isMaskActive('hair') && this.hairModel) {
      const mask = this.masks.find(m => m.id === 'hair');
      const hairY = forehead.y - (eyeDistance * 0.3);
      const worldPos = toWorld3D(eyeCenterX, hairY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.hairModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 1.8;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.hairModel.scale.set(finalScale, finalScale, finalScale);
      this.hairModel.rotation.z = eyeAngle * 0.5;
    }

    // Update hair1 model
    if (this.isMaskActive('hair1') && this.hair1Model) {
      const mask = this.masks.find(m => m.id === 'hair1');
      const hairY = forehead.y - (eyeDistance * 0.3);
      const worldPos = toWorld3D(eyeCenterX, hairY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.hair1Model.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 1.8;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.hair1Model.scale.set(finalScale, finalScale, finalScale);
      this.hair1Model.rotation.z = eyeAngle * 0.5;
    }

    // Update tshirt model (abajo en el torso)
    if (this.isMaskActive('tshirt') && this.tshirtModel) {
      const mask = this.masks.find(m => m.id === 'tshirt');
      const tshirtY = chin.y + (eyeDistance * 0.8);
      const worldPos = toWorld3D(eyeCenterX, tshirtY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.tshirtModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 2.5;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.tshirtModel.scale.set(finalScale, finalScale, finalScale);
      this.tshirtModel.rotation.z = eyeAngle * 0.5;
    }
  }

  switchCamera() {
    this.ngZone.run(async () => {
      await this.trackService.switchCamera();
      console.log('Camera switched');
    });
  }

  // Avatar is now handled through toggleMask('avatar')

  private loadAvatar() {
    console.log('Loading avatar:', this.avatarUrl);
    
    this.gltfLoader.load(
      this.avatarUrl,
      (gltf) => {
        // Remove previous avatar if exists
        if (this.avatarModel) {
          this.scene.remove(this.avatarModel);
        }

        const model = gltf.scene;
        
        // Base position (will be modified by offsets in updateAvatar)
        model.position.set(0, -1.5, 0);
        model.scale.set(1.2, 1.2, 1.2);
        
        this.avatarModel = model;
        this.avatarNodes = {};
        this.avatarHeadMeshes = [];
        
        // Build nodes map and find head meshes for blendshapes
        model.traverse((node: THREE.Object3D) => {
          this.avatarNodes[node.name] = node;
          
          // Log bone names to debug arm structure  
          if (node.name.includes('Arm') || node.name.includes('Shoulder') || node.name.includes('Hand')) {
            console.log('Bone found:', node.name);
          }
          
         
          // Identify head meshes for facial expressions
          if (node.name === 'Wolf3D_Head' ||
              node.name === 'Wolf3D_Teeth' ||
              node.name === 'Wolf3D_Beard' ||
              node.name === 'Wolf3D_Avatar' ||
              node.name === 'Wolf3D_Head_Custom') {
            this.avatarHeadMeshes.push(node);
          }
        });
        
        this.scene.add(model);
        model.visible = this.avatarEnabled;
        
        console.log('✅ Avatar loaded with', Object.keys(this.avatarNodes).length, 'nodes');
      },
      (progress) => {
        const percent = (progress.loaded / progress.total) * 100;
        console.log(`Loading avatar: ${percent.toFixed(0)}%`);
      },
      (error) => {
        console.error('❌ Error loading avatar:', error);
      }
    );
  }

  private updateAvatar() {
    const avatarMask = this.masks.find(m => m.id === 'avatar');
    if (!this.avatarModel || !avatarMask || !avatarMask.isActive || !this.avatarModel.visible) return;

    this.breathingTime += 0.02;

    const blendshapes = this.trackService.blendshapes();
    const rotation = this.trackService.rotation();
    const landmarks = this.trackService.landmarks();
    
    // Calculate scale ONLY ONCE based on face proportions
    if (this.avatarCalculatedScale === null && landmarks && landmarks.length > 468) {
      const leftEyeOuter = landmarks[33];   // Left eye outer corner
      const rightEyeOuter = landmarks[263]; // Right eye outer corner
      
      if (leftEyeOuter && rightEyeOuter) {
        // Calculate distance between eyes
        const eyeDistance = Math.sqrt(
          Math.pow(rightEyeOuter.x - leftEyeOuter.x, 2) +
          Math.pow(rightEyeOuter.y - leftEyeOuter.y, 2) +
          Math.pow(rightEyeOuter.z - leftEyeOuter.z, 2)
        );
        
        // Scale avatar based on eye distance (calculated once)
        // Multiplier adjusted to match face size (roughly 2.0-2.2)
        this.avatarCalculatedScale = eyeDistance * 30.0;
      }
    }
    
    // Use calculated scale or default
    const baseScale = this.avatarCalculatedScale || 2.2;
    const finalScale = baseScale * (avatarMask.scaleOffset || 1.0);
    this.avatarModel.scale.set(finalScale, finalScale, finalScale);
    
    // Keep position fixed (only use user offsets)
    this.avatarModel.position.x = 0 + (avatarMask.positionOffsetX || 0);
    this.avatarModel.position.y = -3.75 + (avatarMask.positionOffsetY || 0);
    this.avatarModel.position.z = 0 + (avatarMask.positionOffsetZ || 0);

    // Apply Face Blendshapes (ARKit morphTargets)
    if (blendshapes.length > 0 && this.avatarHeadMeshes.length > 0) {
      blendshapes.forEach(element => {
        this.avatarHeadMeshes.forEach(mesh => {
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

    // Breathing animation
    const breathCycle = Math.sin(this.breathingTime * 0.5);
    const breathIntensity = 0.05;
    const parts = this.avatarNodes;

    // Spine breathing
    if (parts['Spine']) parts['Spine'].rotation.x = breathCycle * breathIntensity * 0.2;
    if (parts['Spine1']) parts['Spine1'].rotation.x = breathCycle * breathIntensity * 0.2;

    // Spine2 with face tracking lean
    if (parts['Spine2'] && rotation) {
      const baseRotX = rotation.x / 10;
      const baseRotY = -rotation.y / 10;
      const baseRotZ = -rotation.z / 10;
      parts['Spine2'].rotation.set(
        baseRotX + breathCycle * breathIntensity,
        baseRotY,
        baseRotZ
      );
    }

    // Face tracking rotations
    if (rotation) {
      if (parts['Head']) parts['Head'].rotation.set(rotation.x, -rotation.y, -rotation.z);
      if (parts['Neck']) parts['Neck'].rotation.set(rotation.x / 5 + 0.3, -rotation.y / 5, -rotation.z / 5);
      
      }
    
 }
}
