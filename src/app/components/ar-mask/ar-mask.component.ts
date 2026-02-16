import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, OnInit, inject, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { FaceTrackingService } from '../../services/face-tracking.service';
import { LiveStorageService } from '../../pages/live/live-storage.service';
import { FirebaseAvatarStorageService } from '../../services/firebase-avatar-storage.service';
import { ModelCacheService } from '../../services/model-cache.service';
import { AvatarSelectorComponent, CustomAvatarRequest } from '../../pages/live/components/avatar-selector.component';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface MaskOption {
  id: string;
  name: string;
  modelPath: string;
  type: 'glasses' | 'facial-hair' | 'hair' | 'mask' | 'hat' | 'clothing' | 'avatar';
  model?: THREE.Group;
  loaded?: boolean;
  available?: boolean;
  // State
  isActive?: boolean;
  isSelected?: boolean;  // Para saber cuál se está editando con gestures
  // Gesture adjustments
  scaleOffset?: number;
  positionOffsetX?: number;
  positionOffsetY?: number;
  positionOffsetZ?: number;
  // Manual rotation adjustments
  rotationOffsetX?: number;
  rotationOffsetY?: number;
  rotationOffsetZ?: number;
}

interface AvatarOption {
  id: string;
  name: string;
  url: string;
  thumbnail: string;
  defaultCollectionId?: string;
  isCustom?: boolean;
  storagePath?: string;
  ownerEmail?: string;
  sourceUrl?: string;
}

@Component({
  selector: 'app-ar-mask',
  standalone: true,
  imports: [CommonModule, FormsModule, AvatarSelectorComponent, HttpClientModule],
  template: `
    <div #container class="ar-container">
      <canvas #maskCanvas class="ar-canvas" [class.panel-open]="isAvatarPanelOpen"></canvas>
    </div>
    
    <!-- Toggle Button Flotante -->
    <button 
      (click)="toggleSelector()"
      class="toggle-selector-btn"
      title="Mostrar/Ocultar controles">
      <span class="icon">{{ isSelectorCollapsed ? '▲' : '▼' }}</span>
    </button>

    <!-- Accessory Selector UI (dinámico según archivos en assets/models) -->
    <div class="mask-selector" [class.collapsed]="isSelectorCollapsed">
      <ng-container *ngFor="let mask of masks">
        <div class="mask-btn-wrapper" *ngIf="mask.available">
          <button
            (click)="toggleMask(mask.id)"
            [class.active]="isMaskActive(mask.id)"
            [class.selected]="selectedMaskId === mask.id"
            class="mask-btn">
            <span class="icon">{{ getIconForType(mask.type) }}</span>
            <span>{{ mask.name }}</span>
          </button>
          <span class="edit-indicator"
                [class.editing]="selectedMaskId === mask.id"
                [class.active]="isMaskActive(mask.id)"
                (click)="selectForEditing($event, mask.id)">✏️</span>
        </div>
      </ng-container>

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
      <button
        (click)="toggleVideoHide()"
        [class.active]="isVideoHidden()"
        class="mask-btn hide-btn"
        title="Ocultar video (fondo verde)">
        <span class="icon">🟢</span>
        <span>F.Verde</span>
      </button>
      <button
        (click)="toggleVideoHideBlack()"
        [class.active]="isVideoHiddenBlack()"
        class="mask-btn hide-black-btn"
        title="Ocultar video (fondo negro)">
        <span class="icon">⚫</span>
        <span>F.Negro</span>
      </button>
      <button
        (click)="toggleSegmentation()"
        [class.active]="isSegmentationActive()"
        class="mask-btn segmentation-btn"
        title="Ocultar persona (mantiene fondo)">
        <span class="icon">👤</span>
        <span>Seg</span>
      </button>
      <button
        (click)="toggleAvatarPanel()"
        [class.active]="isAvatarPanelOpen"
        class="mask-btn config-btn"
        title="Configurar avatares">
        <span class="icon">⚙️</span>
        <span>Config</span>
      </button>
    </div>

    <!-- Avatar Configuration Panel -->
    <div class="avatar-panel" *ngIf="isAvatarPanelOpen">
      <div class="panel-header">
        <h3>👤 Avatar</h3>
        <button class="close-btn" (click)="toggleAvatarPanel()">✕</button>
      </div>
      <app-avatar-selector
        [avatars]="avatars"
        [currentAvatar]="currentAvatar"
        [avatarSize]="'medium'"
        [avatarPosition]="'center'"
        [collections]="[]"
        [sizeOptions]="sizeOptions"
        [positionOptions]="positionOptions"
        (onSelect)="selectAvatar($event)"
        (onLoadCustom)="loadCustomAvatar($event)"
        (onDelete)="deleteAvatar($event)">
      </app-avatar-selector>
    </div>

    <!-- Rotation Controls -->
    <div class="rotation-container" *ngIf="selectedMaskId !== 'none' && faceDetected">
      <div class="rotation-title">🔄 Rotación</div>
      
      <!-- Botones Y (horizontal) -->
      <div class="axis-control">
        <label class="axis-label">Horizontal (Y)</label>
        <div class="button-group">
          <button class="rotation-btn" 
                  (click)="rotateY(-1)"
                  title="Rotar izquierda">
            ←
          </button>
          <button class="rotation-btn" 
                  (click)="rotateY(1)"
                  title="Rotar derecha">
            →
          </button>
        </div>
      </div>
      
      <!-- Botones X (vertical) -->
      <div class="axis-control">
        <label class="axis-label">Vertical (X)</label>
        <div class="button-group">
          <button class="rotation-btn" 
                  (click)="rotateX(-1)"
                  title="Rotar arriba">
            ↑
          </button>
          <button class="rotation-btn" 
                  (click)="rotateX(1)"
                  title="Rotar abajo">
            ↓
          </button>
        </div>
      </div>
      
      <!-- Botones Z rotación -->
      <div class="axis-control">
        <label class="axis-label">Rotación (Z)</label>
        <div class="button-group">
          <button class="rotation-btn" 
                  (click)="rotateZ(-1)"
                  title="Rotar antihorario">
            ↺
          </button>
          <button class="rotation-btn" 
                  (click)="rotateZ(1)"
                  title="Rotar horario">
            ↻
          </button>
        </div>
      </div>
      
      <button class="reset-rotation-btn" (click)="resetRotation()" title="Restablecer rotación">
        ↺ Reset
      </button>
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
        🖱️ Scroll: Zoom | Shift+Scroll: Profundidad | Drag: Mover<br>
        🔄 Joystick: Rotar objeto
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
    
    .ar-canvas.panel-open {
      pointer-events: none !important;
      cursor: default;
    }
    
    .ar-canvas:active {
      cursor: grabbing;
    }
    
    /* Toggle Button - Flotante y discreto */
    .toggle-selector-btn {
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 301;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 255, 0, 0.15);
      border: 1px solid rgba(0, 255, 0, 0.3);
      border-radius: 50%;
      width: 44px;
      height: 44px;
      cursor: pointer;
      transition: all 0.3s ease;
      color: rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(5px);
      pointer-events: auto;
    }
    
    .toggle-selector-btn .icon {
      font-size: 18px;
      line-height: 1;
    }
    
    .toggle-selector-btn:hover {
      background: rgba(0, 255, 0, 0.25);
      border-color: rgba(0, 255, 0, 0.5);
      color: rgba(255, 255, 255, 0.9);
      transform: translateX(-50%) scale(1.05);
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
      max-height: 200px;
      transition: all 0.3s ease;
    }
    
    .mask-selector.collapsed {
      transform: translate(-50%, calc(100% + 20px));
      pointer-events: none;
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
      display: none;
    }

    /* Avatar Panel Styles */
    .avatar-panel {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 90%;
      max-width: 400px;
      max-height: 80vh;
      background: #0B0F19;
      border: 1px solid #5C24FF;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
      z-index: 400;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      pointer-events: auto;
      touch-action: auto;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      background: linear-gradient(135deg, #1e1e2e 0%, #252538 100%);
      border-bottom: 1px solid #23293D;
    }

    .panel-header h3 {
      margin: 0;
      color: #E2E8F0;
      font-size: 1.1rem;
      font-weight: 600;
    }

    .close-btn {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid #23293D;
      background: #151926;
      color: #94A3B8;
      font-size: 1.2rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }

    .close-btn:hover {
      border-color: #A855F7;
      color: #fff;
      background: #23293D;
    }

    .avatar-panel app-avatar-selector {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
    }

    .config-btn {
      background: rgba(92, 36, 255, 0.2) !important;
    }

    .config-btn.active {
      background: rgba(92, 36, 255, 0.4) !important;
      border-color: #A855F7 !important;
    }

    .config-btn:hover {
      background: rgba(92, 36, 255, 0.3) !important;
    }

    /* Joystick Controls */
    .rotation-container {
      position: absolute;
      bottom: 200px;
      right: 20px;
      z-index: 310;
      background: rgba(0, 0, 0, 0.7);
      padding: 16px;
      border-radius: 16px;
      backdrop-filter: blur(10px);
      pointer-events: auto;
      min-width: 220px;
    }

    .rotation-title {
      color: white;
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 16px;
      text-align: center;
    }

    .axis-control {
      margin-bottom: 12px;
    }

    .axis-label {
      display: block;
      color: rgba(255, 255, 255, 0.9);
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 6px;
      text-align: center;
    }

    .button-group {
      display: flex;
      gap: 8px;
      justify-content: center;
    }

    .rotation-btn {
      width: 50px;
      height: 50px;
      border-radius: 8px;
      background: rgba(92, 36, 255, 0.3);
      border: 2px solid rgba(92, 36, 255, 0.5);
      color: white;
      font-size: 24px;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      pointer-events: auto;
    }

    .rotation-btn:active {
      background: rgba(92, 36, 255, 0.6);
      transform: scale(0.95);
    }

    .rotation-btn:hover {
      background: rgba(92, 36, 255, 0.5);
      border-color: #A855F7;
    }

    .reset-rotation-btn {
      width: 100%;
      padding: 10px;
      background: rgba(255, 100, 100, 0.2);
      border: 1px solid rgba(255, 100, 100, 0.5);
      border-radius: 8px;
      color: white;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      pointer-events: auto;
      margin-top: 8px;
    }

    .reset-rotation-btn:hover {
      background: rgba(255, 100, 100, 0.3);
      border-color: rgba(255, 100, 100, 0.7);
      transform: scale(1.02);
    }

    .reset-rotation-btn:active {
      transform: scale(0.98);
    }
  `]
})
export class ArMaskComponent implements AfterViewInit, OnDestroy, OnInit {
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('maskCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  private trackService = inject(FaceTrackingService);
  private ngZone = inject(NgZone);
  private storageService = inject(LiveStorageService);
  private firebaseAvatarStorage = inject(FirebaseAvatarStorageService);
  private modelCache = inject(ModelCacheService);
  private cdr = inject(ChangeDetectorRef);
  private requestID: number = 0;
  private http = inject(HttpClient);

  // Rotation controls
  private readonly rotationStep = 0.25; // Incremento pequeño por click

  // Avatar management
  private readonly defaultAvatars: AvatarOption[] = [
    {
      id: 'avatar1',
      name: 'Avatar 1',
      url: 'https://models.readyplayer.me/6984a7a905b43df7aaeb9df1.glb',
      thumbnail: 'https://models.readyplayer.me/6984a7a905b43df7aaeb9df1.png'
    },
    {
      id: 'avatar2',
      name: 'Avatar 2',
      url: 'https://models.readyplayer.me/6984ad1a0b547ce9ae29d70d.glb',
      thumbnail: 'https://models.readyplayer.me/6984ad1a0b547ce9ae29d70d.png'
    }
  ];

  ngOnInit() {
    // Verificar existencia de archivos en assets/models y ocultar entradas sin archivo
    this.checkAvailableModels();
  }

  avatars: AvatarOption[] = [...this.defaultAvatars];
  currentAvatar: AvatarOption | null = null;
  isAvatarPanelOpen = false;
  isSelectorCollapsed = false;
  private hiddenAvatarIds = new Set<string>();

  sizeOptions = [
    { label: 'S', value: 'small' },
    { label: 'M', value: 'medium' },
    { label: 'L', value: 'large' }
  ];

  positionOptions = [
    { label: '⬅️', value: 'left' as const },
    { label: '⏺️', value: 'center' as const },
    { label: '➡️', value: 'right' as const }
  ];

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

  // Header model (avatar sin cuerpo)
  private headerModel: THREE.Object3D | null = null;
  private headerNodes: Record<string, THREE.Object3D> = {};
  private headerHeadMeshes: THREE.Object3D[] = [];
  public headerEnabled = false;
  private headerBreathingTime = 0;
  private headerCalculatedScale: number | null = null;

  // Avatar1 model (desde assets/models)
  private avatar1Model: THREE.Object3D | null = null;
  private avatar1Nodes: Record<string, THREE.Object3D> = {};
  private avatar1HeadMeshes: THREE.Object3D[] = [];
  public avatar1Enabled = false;
  private avatar1BreathingTime = 0;
  private avatar1CalculatedScale: number | null = null;

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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetY: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
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
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
    },
    {
      id: 'header',
      name: 'Header (Solo cabeza)',
      modelPath: 'assets/models/header.glb',
      type: 'avatar',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
    },
    {
      id: 'avatar1',
      name: 'Avatar1 (Local)',
      modelPath: 'assets/models/avatar1.glb',
      type: 'avatar',
      loaded: false,
      isActive: false,
      isSelected: false,
      scaleOffset: 1.0,
      positionOffsetX: 0,
      positionOffsetY: 0,
      positionOffsetZ: 0,
      rotationOffsetX: 0,
      rotationOffsetY: 0,
      rotationOffsetZ: 0
    }
  ];

  ngAfterViewInit() {
    // Load stored avatars
    this.loadStoredAvatars();
    
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

  private checkAvailableModels() {
    this.masks.forEach(mask => {
      // inicialmente undefined; intentamos HEAD para comprobar si existe
      this.http.head(mask.modelPath, { observe: 'response' }).subscribe({
        next: () => {
          mask.available = true;
          this.cdr.markForCheck();
        },
        error: () => {
          // archivo no encontrado o error -> ocultar opción
          mask.available = false;
          this.cdr.markForCheck();
        }
      });
    });
  }

  // Helper para iconos simples según tipo
  getIconForType(type: MaskOption['type']): string {
    switch (type) {
      case 'glasses': return '👓';
      case 'facial-hair': return '🧔';
      case 'hair': return '💇';
      case 'mask': return '🎭';
      case 'hat': return '🧢';
      case 'clothing': return '👕';
      case 'avatar': return '👤';
      default: return '🔸';
    }
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
      
      // Si se activa el header, resetear la escala calculada para que recalcule
      if (mask.isActive && maskId === 'header') {
        this.headerCalculatedScale = null;
      }
      
      // Si se activa el avatar1, resetear la escala calculada para que recalcule
      if (mask.isActive && maskId === 'avatar1') {
        this.avatar1CalculatedScale = null;
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
        m.rotationOffsetX = 0;
        m.rotationOffsetY = 0;
        m.rotationOffsetZ = 0;
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
        activeMask.rotationOffsetX = 0;
        activeMask.rotationOffsetY = 0;
        activeMask.rotationOffsetZ = 0;
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

  // Joystick controls setup
  rotateX(direction: number) {
    if (this.selectedMaskId === 'none') return;
    
    const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
    if (!activeMask) return;
    
    activeMask.rotationOffsetX = (activeMask.rotationOffsetX || 0) + (direction * this.rotationStep);
  }

  rotateY(direction: number) {
    if (this.selectedMaskId === 'none') return;
    
    const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
    if (!activeMask) return;
    
    activeMask.rotationOffsetY = (activeMask.rotationOffsetY || 0) + (direction * this.rotationStep);
  }

  rotateZ(direction: number) {
    if (this.selectedMaskId === 'none') return;
    
    const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
    if (!activeMask) return;
    
    activeMask.rotationOffsetZ = (activeMask.rotationOffsetZ || 0) + (direction * this.rotationStep);
  }

  resetRotation() {
    if (this.selectedMaskId === 'none') return;
    
    const activeMask = this.masks.find(m => m.id === this.selectedMaskId);
    if (activeMask) {
      activeMask.rotationOffsetX = 0;
      activeMask.rotationOffsetY = 0;
      activeMask.rotationOffsetZ = 0;
      console.log(`Reset rotation for ${this.selectedMaskId}`);
    }
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
      const oldScale = activeMask.scaleOffset || 1.0;
      const scaleDelta = -event.deltaY * 0.0005;
      const newScale = Math.max(0.3, Math.min(3.0, oldScale + scaleDelta));
      
      // For avatar types, adjust Y position proportionally to scale change
      // to make it appear to scale from center instead of from feet
      if (activeMask.type === 'avatar') {
        const scaleChange = newScale - oldScale;
        const yAdjustment = scaleChange * 2.0; // Compensate upward movement
        activeMask.positionOffsetY = (activeMask.positionOffsetY || 0) - yAdjustment;
      }
      
      activeMask.scaleOffset = newScale;
      console.log(`Scale for ${this.selectedMaskId}: ${newScale.toFixed(3)}`);
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

    // Handle header model
    const headerMask = this.masks.find(m => m.id === 'header');
    if (headerMask) {
      this.headerEnabled = headerMask.isActive || false;
      if (this.headerEnabled && !this.headerModel) {
        this.loadHeader();
      } else if (this.headerModel) {
        this.headerModel.visible = this.headerEnabled && this.faceDetected;
      }
    }

    // Handle avatar1 model
    const avatar1Mask = this.masks.find(m => m.id === 'avatar1');
    if (avatar1Mask) {
      this.avatar1Enabled = avatar1Mask.isActive || false;
      if (this.avatar1Enabled && !this.avatar1Model) {
        this.loadAvatar1();
      } else if (this.avatar1Model) {
        this.avatar1Model.visible = this.avatar1Enabled && this.faceDetected;
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
      this.updateHeader(); // Update header with face tracking
      this.updateAvatar1(); // Update avatar1 with face tracking
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
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.glassesModel.rotation.x = rotX;
      this.glassesModel.rotation.y = rotY;
      this.glassesModel.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.mustacheModel.rotation.x = rotX;
      this.mustacheModel.rotation.y = rotY;
      this.mustacheModel.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.glasses1Model.rotation.x = rotX;
      this.glasses1Model.rotation.y = rotY;
      this.glasses1Model.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.mustache1Model.rotation.x = rotX;
      this.mustache1Model.rotation.y = rotY;
      this.mustache1Model.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.beardModel.rotation.x = rotX;
      this.beardModel.rotation.y = rotY;
      this.beardModel.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.maskModel.rotation.x = rotX;
      this.maskModel.rotation.y = rotY;
      this.maskModel.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.mask1Model.rotation.x = rotX;
      this.mask1Model.rotation.y = rotY;
      this.mask1Model.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.gorraModel.rotation.x = rotX;
      this.gorraModel.rotation.y = rotY;
      this.gorraModel.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.gorra1Model.rotation.x = rotX;
      this.gorra1Model.rotation.y = rotY;
      this.gorra1Model.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.hairModel.rotation.x = rotX;
      this.hairModel.rotation.y = rotY;
      this.hairModel.rotation.z = eyeAngle * 0.5 + rotZ;
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
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.hair1Model.rotation.x = rotX;
      this.hair1Model.rotation.y = rotY;
      this.hair1Model.rotation.z = eyeAngle * 0.5 + rotZ;
    }

    // Update tshirt model (abajo en el torso)
    if (this.isMaskActive('tshirt') && this.tshirtModel) {
      const mask = this.masks.find(m => m.id === 'tshirt');
      const tshirtY = chin.y + (eyeDistance * 0.8);
      const worldPos = toWorld3D(0.5, tshirtY, nose.z);
      const offsetX = mask?.positionOffsetX || 0;
      const offsetY = mask?.positionOffsetY || 0;
      const offsetZ = mask?.positionOffsetZ || 0;
      this.tshirtModel.position.set(worldPos.x + offsetX, worldPos.y + offsetY, worldPos.z + offsetZ);
      const baseScale = eyeDistance * 2.5;
      const scaleMultiplier = mask?.scaleOffset || 1.0;
      const finalScale = baseScale * scaleMultiplier;
      this.tshirtModel.scale.set(finalScale, finalScale, finalScale);
      this.tshirtModel.rotation.z = 0;
      
      // Apply manual rotation offsets
      const rotX = mask?.rotationOffsetX || 0;
      const rotY = mask?.rotationOffsetY || 0;
      const rotZ = mask?.rotationOffsetZ || 0;
      this.tshirtModel.rotation.x = rotX;
      this.tshirtModel.rotation.y = rotY;
      this.tshirtModel.rotation.z = rotZ;
    }
  }

  switchCamera() {
    this.ngZone.run(async () => {
      await this.trackService.switchCamera();
      console.log('Camera switched');
    });
  }

  toggleVideoHide() {
    this.ngZone.run(() => {
      const currentState = this.trackService.hideVideo();
      this.trackService.toggleVideoVisibility(!currentState);
      
      // Si se activa hide video verde, desactivar segmentación y fondo negro
      if (!currentState) {
        this.trackService.togglePersonMask(false);
        this.trackService.toggleVideoVisibilityBlack(false);
      }
    });
  }

  isVideoHidden(): boolean {
    return this.trackService.hideVideo();
  }

  toggleVideoHideBlack() {
    this.ngZone.run(() => {
      const currentState = this.trackService.hideVideoBlack();
      this.trackService.toggleVideoVisibilityBlack(!currentState);
      
      // Si se activa hide video negro, desactivar segmentación y fondo verde
      if (!currentState) {
        this.trackService.togglePersonMask(false);
        this.trackService.toggleVideoVisibility(false);
      }
    });
  }

  isVideoHiddenBlack(): boolean {
    return this.trackService.hideVideoBlack();
  }

  toggleSegmentation() {
    this.ngZone.run(() => {
      const currentState = this.trackService.hidePersonWithGreen();
      this.trackService.togglePersonMask(!currentState);
      
      // Si se activa mask persona, desactivar hide video (verde y negro)
      if (!currentState) {
        this.trackService.toggleVideoVisibility(false);
        this.trackService.toggleVideoVisibilityBlack(false);
      }
    });
  }

  isSegmentationActive(): boolean {
    return this.trackService.hidePersonWithGreen();
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

  private loadHeader() {
    const headerMask = this.masks.find(m => m.id === 'header');
    if (!headerMask) return;

    console.log('Loading header:', headerMask.modelPath);
    
    this.gltfLoader.load(
      headerMask.modelPath,
      (gltf) => {
        // Remove previous header if exists
        if (this.headerModel) {
          this.scene.remove(this.headerModel);
        }

        const model = gltf.scene;
        
        // Base position (will be modified by offsets in updateHeader)
        model.position.set(0, -1.5, 0);
        model.scale.set(1.2, 1.2, 1.2);
        
        this.headerModel = model;
        this.headerNodes = {};
        this.headerHeadMeshes = [];
        
        // Build nodes map and find head meshes for blendshapes
        model.traverse((node: THREE.Object3D) => {
          this.headerNodes[node.name] = node;
          
          // Identify head meshes for facial expressions
          if (node.name === 'Wolf3D_Head' ||
              node.name === 'Wolf3D_Teeth' ||
              node.name === 'Wolf3D_Beard' ||
              node.name === 'Wolf3D_Avatar' ||
              node.name === 'Wolf3D_Head_Custom') {
            this.headerHeadMeshes.push(node);
          }
        });
        
        this.scene.add(model);
        model.visible = this.headerEnabled;
        
        console.log('✅ Header loaded with', Object.keys(this.headerNodes).length, 'nodes');
      },
      (progress) => {
        const percent = (progress.loaded / progress.total) * 100;
        console.log(`Loading header: ${percent.toFixed(0)}%`);
      },
      (error) => {
        console.error('❌ Error loading header:', error);
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
        this.avatarCalculatedScale = eyeDistance * 32.0;
      }
    }
    
    // Use calculated scale or default
    const baseScale = this.avatarCalculatedScale || 2.2;
    const finalScale = baseScale * (avatarMask.scaleOffset || 1.0);
    this.avatarModel.scale.set(finalScale, finalScale, finalScale);
    
    // Keep position fixed (only use user offsets)
    this.avatarModel.position.x = 0 + (avatarMask.positionOffsetX || 0);
    this.avatarModel.position.y = -4.3 + (avatarMask.positionOffsetY || 0);
    this.avatarModel.position.z = 0 + (avatarMask.positionOffsetZ || 0);
    
    // Apply manual rotation offsets from sliders
    const rotX = avatarMask?.rotationOffsetX || 0;
    const rotY = avatarMask?.rotationOffsetY || 0;
    const rotZ = avatarMask?.rotationOffsetZ || 0;
    this.avatarModel.rotation.x = rotX;
    this.avatarModel.rotation.y = rotY;
    this.avatarModel.rotation.z = rotZ;

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
    
    this.breathingTime += 0.016;
  }

  private updateHeader() {
    const headerMask = this.masks.find(m => m.id === 'header');
    if (!this.headerModel || !headerMask || !headerMask.isActive || !this.headerModel.visible) return;

    this.headerBreathingTime += 0.02;

    const blendshapes = this.trackService.blendshapes();
    const rotation = this.trackService.rotation();
    const landmarks = this.trackService.landmarks();
    
    // Calculate scale ONLY ONCE based on face proportions
    if (this.headerCalculatedScale === null && landmarks && landmarks.length > 468) {
      const leftEyeOuter = landmarks[33];   // Left eye outer corner
      const rightEyeOuter = landmarks[263]; // Right eye outer corner
      
      if (leftEyeOuter && rightEyeOuter) {
        // Calculate distance between eyes
        const eyeDistance = Math.sqrt(
          Math.pow(rightEyeOuter.x - leftEyeOuter.x, 2) +
          Math.pow(rightEyeOuter.y - leftEyeOuter.y, 2) +
          Math.pow(rightEyeOuter.z - leftEyeOuter.z, 2)
        );
        
        // Scale header based on eye distance (calculated once)
        // Same multiplier as avatar for consistency
        this.headerCalculatedScale = eyeDistance * 32.0;
      }
    }
    
    // Use calculated scale or default
    const baseScale = this.headerCalculatedScale || 2.2;
    const finalScale = baseScale * (headerMask.scaleOffset || 1.0);
    this.headerModel.scale.set(finalScale, finalScale, finalScale);
    
    // Keep position fixed (only use user offsets)
    this.headerModel.position.x = 0 + (headerMask.positionOffsetX || 0);
    this.headerModel.position.y = -4.3 + (headerMask.positionOffsetY || 0);
    this.headerModel.position.z = 0 + (headerMask.positionOffsetZ || 0);
    
    // Apply manual rotation offsets from sliders
    const rotX = headerMask?.rotationOffsetX || 0;
    const rotY = headerMask?.rotationOffsetY || 0;
    const rotZ = headerMask?.rotationOffsetZ || 0;
    this.headerModel.rotation.x = rotX;
    this.headerModel.rotation.y = rotY;
    this.headerModel.rotation.z = rotZ;

    // Apply Face Blendshapes (ARKit morphTargets)
    if (blendshapes.length > 0 && this.headerHeadMeshes.length > 0) {
      blendshapes.forEach(element => {
        this.headerHeadMeshes.forEach(mesh => {
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
    const breathCycle = Math.sin(this.headerBreathingTime * 0.5);
    const breathIntensity = 0.05;
    const parts = this.headerNodes;

    // Spine breathing (si tiene huesos de spine)
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
    
    this.headerBreathingTime += 0.016;
  }

  private loadAvatar1() {
    const avatar1Mask = this.masks.find(m => m.id === 'avatar1');
    if (!avatar1Mask) return;

    console.log('Loading avatar1:', avatar1Mask.modelPath);
    
    this.gltfLoader.load(
      avatar1Mask.modelPath,
      (gltf) => {
        // Remove previous avatar1 if exists
        if (this.avatar1Model) {
          this.scene.remove(this.avatar1Model);
        }

        const model = gltf.scene;
        
        // Base position (will be modified by offsets in updateAvatar1)
        model.position.set(0, -1.5, 0);
        model.scale.set(1.2, 1.2, 1.2);
        
        this.avatar1Model = model;
        this.avatar1Nodes = {};
        this.avatar1HeadMeshes = [];
        
        // Build nodes map and find head meshes for blendshapes
        model.traverse((node: THREE.Object3D) => {
          this.avatar1Nodes[node.name] = node;
          
          // Identify head meshes for facial expressions
          if (node.name === 'Wolf3D_Head' ||
              node.name === 'Wolf3D_Teeth' ||
              node.name === 'Wolf3D_Beard' ||
              node.name === 'Wolf3D_Avatar' ||
              node.name === 'Wolf3D_Head_Custom') {
            this.avatar1HeadMeshes.push(node);
          }
        });
        
        this.scene.add(model);
        model.visible = this.avatar1Enabled;
        
        console.log('✅ Avatar1 loaded with', Object.keys(this.avatar1Nodes).length, 'nodes');
      },
      (progress) => {
        const percent = (progress.loaded / progress.total) * 100;
        console.log(`Loading avatar1: ${percent.toFixed(0)}%`);
      },
      (error) => {
        console.error('❌ Error loading avatar1:', error);
      }
    );
  }

  private updateAvatar1() {
    const avatar1Mask = this.masks.find(m => m.id === 'avatar1');
    if (!this.avatar1Model || !avatar1Mask || !avatar1Mask.isActive || !this.avatar1Model.visible) return;

    this.avatar1BreathingTime += 0.02;

    const blendshapes = this.trackService.blendshapes();
    const rotation = this.trackService.rotation();
    const landmarks = this.trackService.landmarks();
    
    // Calculate scale ONLY ONCE based on face proportions
    if (this.avatar1CalculatedScale === null && landmarks && landmarks.length > 468) {
      const leftEyeOuter = landmarks[33];   // Left eye outer corner
      const rightEyeOuter = landmarks[263]; // Right eye outer corner
      
      if (leftEyeOuter && rightEyeOuter) {
        // Calculate distance between eyes
        const eyeDistance = Math.sqrt(
          Math.pow(rightEyeOuter.x - leftEyeOuter.x, 2) +
          Math.pow(rightEyeOuter.y - leftEyeOuter.y, 2) +
          Math.pow(rightEyeOuter.z - leftEyeOuter.z, 2)
        );
        
        // Scale avatar1 based on eye distance (calculated once)
        // Same multiplier as main avatar for consistency
        this.avatar1CalculatedScale = eyeDistance * 32.0;
      }
    }
    
    // Use calculated scale or default
    const baseScale = this.avatar1CalculatedScale || 2.2;
    const finalScale = baseScale * (avatar1Mask.scaleOffset || 1.0);
    this.avatar1Model.scale.set(finalScale, finalScale, finalScale);
    
    // Keep position fixed (only use user offsets)
    this.avatar1Model.position.x = 0 + (avatar1Mask.positionOffsetX || 0);
    this.avatar1Model.position.y = -4.3 + (avatar1Mask.positionOffsetY || 0);
    this.avatar1Model.position.z = 0 + (avatar1Mask.positionOffsetZ || 0);
    
    // Apply manual rotation offsets from sliders
    const rotX = avatar1Mask?.rotationOffsetX || 0;
    const rotY = avatar1Mask?.rotationOffsetY || 0;
    const rotZ = avatar1Mask?.rotationOffsetZ || 0;
    this.avatar1Model.rotation.x = rotX;
    this.avatar1Model.rotation.y = rotY;
    this.avatar1Model.rotation.z = rotZ;

    // Apply Face Blendshapes (ARKit morphTargets)
    if (blendshapes.length > 0 && this.avatar1HeadMeshes.length > 0) {
      blendshapes.forEach(element => {
        this.avatar1HeadMeshes.forEach(mesh => {
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
    const breathCycle = Math.sin(this.avatar1BreathingTime * 0.5);
    const breathIntensity = 0.05;
    const parts = this.avatar1Nodes;

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
    
    this.avatar1BreathingTime += 0.016;
  }

  // === Avatar Management Methods ===

  toggleAvatarPanel() {
    this.isAvatarPanelOpen = !this.isAvatarPanelOpen;
  }

  toggleSelector() {
    this.isSelectorCollapsed = !this.isSelectorCollapsed;
  }

  selectAvatar(avatar: AvatarOption) {
    this.currentAvatar = avatar;
    this.avatarUrl = this.normalizeAvatarUrl(avatar.url);
    
    // Reset avatar scale when changing avatar
    this.avatarCalculatedScale = null;
    
    // Reload avatar if currently active
    if (this.avatarEnabled) {
      this.loadAvatar();
    }
    
    void this.storageService.saveCustomAvatars(this.avatars);
  }

  private async loadStoredAvatars() {
    try {
      const [customAvatars, hiddenIds] = await Promise.all([
        this.storageService.loadCustomAvatars(),
        this.storageService.loadHiddenAvatarIds()
      ]);

      this.hiddenAvatarIds = new Set(hiddenIds);
      const visibleCustomAvatars = customAvatars.filter(avatar => !this.hiddenAvatarIds.has(avatar.id));

      this.avatars = [...this.defaultAvatars, ...visibleCustomAvatars];

      // Select first avatar by default
      if (this.avatars.length > 0 && !this.currentAvatar) {
        this.currentAvatar = this.avatars[0];
        this.avatarUrl = this.normalizeAvatarUrl(this.currentAvatar.url);
      }

      this.cdr.detectChanges();
    } catch (error) {
      console.error('Error loading stored avatars:', error);
    }
  }

  async loadCustomAvatar(request: CustomAvatarRequest) {
    if (!request?.url || !request.url.trim()) {
      return;
    }

    try {
      const avatarName = this.resolveAvatarName(request.name);
      if (!avatarName) {
        alert('Avatar name is required.');
        return;
      }

      const email = await this.resolveUserEmail();
      if (!email) {
        alert('Necesitas iniciar sesión para guardar el avatar en Firebase Storage.');
        return;
      }

      const normalizedUrl = this.normalizeAvatarUrl(request.url);
      const expectedStoragePath = this.firebaseAvatarStorage.buildAvatarPath(email, avatarName);
      const customAvatarId = this.createAvatarIdFromUrl(expectedStoragePath);

      if (this.hiddenAvatarIds.has(customAvatarId)) {
        this.hiddenAvatarIds.delete(customAvatarId);
        await this.storageService.saveHiddenAvatarIds(Array.from(this.hiddenAvatarIds));
      }

      const avatarBuffer = await this.preloadAvatarModel(normalizedUrl);
      const uploadResult = await this.firebaseAvatarStorage.uploadAvatar(email, avatarName, avatarBuffer);

      let customAvatar = this.avatars.find(avatar => avatar.storagePath === uploadResult.path);

      if (!customAvatar) {
        customAvatar = this.createCustomAvatar(normalizedUrl, avatarName, email, uploadResult.path, normalizedUrl);
        this.avatars = [...this.avatars, customAvatar];
      } else {
        customAvatar.id = this.createAvatarIdFromUrl(uploadResult.path);
        customAvatar.name = avatarName;
        customAvatar.url = normalizedUrl;
        customAvatar.storagePath = uploadResult.path;
        customAvatar.ownerEmail = email;
        customAvatar.sourceUrl = normalizedUrl;
      }

      this.selectAvatar(customAvatar);
      await this.storageService.saveCustomAvatars(this.avatars);
      this.cdr.detectChanges();
    } catch (error) {
      console.error('Error loading custom avatar:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      alert('Error loading custom avatar: ' + message);
    }
  }

  async deleteAvatar(avatar: AvatarOption) {
    if (this.avatars.length <= 1) {
      alert('At least one avatar must remain available.');
      return;
    }

    if (!confirm(`Delete avatar "${avatar.name}"?`)) {
      return;
    }

    if (avatar.storagePath) {
      try {
        await this.firebaseAvatarStorage.deleteAvatar(avatar.storagePath);
      } catch (error) {
        console.error('Error deleting avatar from Firebase Storage:', error);
        alert('Could not delete avatar from Firebase Storage. Try again.');
        return;
      }
    }

    this.avatars = this.avatars.filter(item => item.id !== avatar.id);
    this.hiddenAvatarIds.add(avatar.id);

    await this.storageService.saveHiddenAvatarIds(Array.from(this.hiddenAvatarIds));
    await this.storageService.saveCustomAvatars(this.avatars);

    if (this.currentAvatar?.id === avatar.id) {
      const nextAvatar = this.avatars[0] ?? null;
      if (nextAvatar) {
        this.selectAvatar(nextAvatar);
      } else {
        this.currentAvatar = null;
        this.avatarUrl = this.defaultAvatars[0]?.url || '';
      }
    }

    this.cdr.detectChanges();
  }

  // === Helper Methods for Avatar Management ===

  private async resolveUserEmail(): Promise<string | null> {
    const savedEmail = await this.storageService.loadUserEmail();
    if (savedEmail) return savedEmail;

    const email = this.firebaseAvatarStorage.getAuthenticatedEmail();
    if (email) return email;

    return null;
  }

  private resolveAvatarName(name: string): string | null {
    const trimmedName = name?.trim() ?? '';
    if (trimmedName) {
      return trimmedName;
    }

    const promptedName = prompt('Name for the avatar:', '');
    const normalizedName = promptedName?.trim() ?? '';
    return normalizedName || null;
  }

  private async preloadAvatarModel(url: string): Promise<ArrayBuffer> {
    const cachedData = await this.modelCache.getCachedModel(url);
    if (cachedData) {
      return cachedData;
    }

    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    await this.modelCache.cacheModel(url, arrayBuffer);
    return arrayBuffer;
  }

  private createCustomAvatar(url: string, name: string, ownerEmail: string, storagePath: string, sourceUrl: string): AvatarOption {
    const customCount = this.avatars.filter(avatar => avatar.isCustom).length + 1;

    return {
      id: this.createAvatarIdFromUrl(storagePath),
      name: name || `Custom ${customCount}`,
      url,
      thumbnail: this.buildAvatarThumbnail(url),
      isCustom: true,
      storagePath,
      ownerEmail,
      sourceUrl
    };
  }

  private createAvatarIdFromUrl(url: string): string {
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      hash = ((hash << 5) - hash) + url.charCodeAt(i);
      hash |= 0;
    }
    return `custom-${Math.abs(hash)}`;
  }

  private buildAvatarThumbnail(url: string): string {
    const baseUrl = url.split('?')[0];
    if (baseUrl.toLowerCase().endsWith('.glb')) {
      return `${baseUrl.slice(0, -4)}.png`;
    }
    return baseUrl;
  }

  private normalizeAvatarUrl(url: string): string {
    let normalizedUrl = url.trim();

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
}
