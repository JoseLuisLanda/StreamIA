import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ModelCacheService, ModelInfo } from '../../services/model-cache.service';

@Component({
    selector: 'app-ar-page',
    standalone: true,
    imports: [CommonModule, RouterLink],
    template: `
    <div class="ar-container">
      <div #canvasContainer class="canvas-container">
        <canvas #canvas></canvas>
      </div>
      
      <!-- Back Button -->
      <a routerLink="/" class="back-btn">← Volver</a>

      <!-- Model Selector Toolbar -->
      <div class="model-toolbar" [class.collapsed]="isPanelCollapsed">
        <button class="toggle-panel-btn" (click)="togglePanel()" title="Expandir/Colapsar">
          <span *ngIf="isPanelCollapsed">◀</span>
          <span *ngIf="!isPanelCollapsed">▶</span>
        </button>
        
        <div class="toolbar-content">
          <h3>Modelos 3D</h3>
          
          <!-- Loading state -->
          <div *ngIf="isLoadingModels" class="loading-state">
            <div class="spinner"></div>
            <p class="loading-text">Cargando...</p>
          </div>
          
          <!-- Model list -->
          <div class="model-buttons" *ngIf="!isLoadingModels">
            <button 
              *ngFor="let model of models" 
              (click)="loadModel(model.storagePath)"
              [class.active]="currentModelPath === model.storagePath"
              [disabled]="isLoadingModel"
              class="model-btn">
              {{ model.displayName }}
            </button>
            
            <div *ngIf="models.length === 0" class="no-models">
              No hay modelos disponibles
            </div>
          </div>
        </div>
      </div>

      <!-- Rotation Controls -->
      <div class="rotation-controls" [class.collapsed]="isControlsCollapsed" *ngIf="currentModelPath">
        <button class="toggle-controls-btn" (click)="toggleControls()" title="Expandir/Colapsar controles">
          <span *ngIf="isControlsCollapsed">⬇</span>
          <span *ngIf="!isControlsCollapsed">⬆</span>
        </button>
        
        <div class="controls-content">
          <h3>Auto-Rotación</h3>
          <div class="rotation-buttons">
          <button 
            (click)="toggleRotation('left')"
            [class.active]="isRotating && rotationDirection === 'left'"
            class="rotation-btn">
            ← Izq
          </button>
          <button 
            (click)="stopRotation()"
            [class.active]="!isRotating"
            class="rotation-btn stop-btn">
            ⏸ Stop
          </button>
          <button 
            (click)="toggleRotation('right')"
            [class.active]="isRotating && rotationDirection === 'right'"
            class="rotation-btn">
            Der →
          </button>
          </div>
          <p class="drag-hint">💡 Arrastra | 🖱️ Rueda/📱 Pinch zoom</p>
        </div>
      </div>
    </div>
  `,
    styles: [`
    .ar-container {
      position: relative;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    
    .canvas-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    canvas {
      display: block;
      max-width: 100%;
      max-height: 100%;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }

    canvas:active {
      cursor: grabbing;
    }

    .back-btn {
      position: absolute;
      top: 0.75rem;
      left: 0.75rem;
      z-index: 2000;
      color: white;
      text-decoration: none;
      background: rgba(0,0,0,0.75);
      padding: 0.5rem 1rem;
      border-radius: 20px;
      font-family: sans-serif;
      font-size: 0.85rem;
      font-weight: 600;
      transition: all 0.3s ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }

    .back-btn:hover {
      background: rgba(0,0,0,0.9);
      transform: translateY(-2px);
    }

    .model-toolbar {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      background: rgba(0,0,0,0.85);
      padding: 0.5rem;
      border-radius: 12px;
      backdrop-filter: blur(10px);
      z-index: 1000;
      max-width: 200px;
      max-height: calc(100vh - 10rem);
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.3) transparent;
      transition: all 0.3s ease;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }

    .model-toolbar.collapsed {
      max-width: 45px;
      min-width: 45px;
      max-height: 45px;
      min-height: 45px;
      padding: 0;
      overflow: visible;
      background: transparent;
      backdrop-filter: none;
    }

    .model-toolbar.collapsed .toolbar-content {
      display: none;
    }

    .toggle-panel-btn {
      position: absolute;
      top: 0.25rem;
      right: 0.25rem;
      width: 35px;
      height: 35px;
      background: rgba(0, 0, 0, 0.9);
      border: 2px solid rgba(103, 126, 234, 1);
      border-radius: 50%;
      color: white;
      font-size: 1rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      z-index: 10;
      box-shadow: 0 3px 10px rgba(103, 126, 234, 0.4);
    }

    .toggle-panel-btn:hover {
      background: rgba(103, 126, 234, 0.9);
      transform: scale(1.15);
      box-shadow: 0 6px 20px rgba(103, 126, 234, 0.8);
    }

    .toggle-panel-btn span {
      display: block;
      line-height: 1;
    }

    .toolbar-content {
      margin-top: 2.5rem;
      padding: 0.25rem;
    }

    .model-toolbar::-webkit-scrollbar {
      width: 6px;
    }

    .model-toolbar::-webkit-scrollbar-track {
      background: transparent;
    }

    .model-toolbar::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.3);
      border-radius: 3px;
    }

    .model-toolbar::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,0.5);
    }

    .model-toolbar h3 {
      color: white;
      margin: 0 0 0.5rem 0;
      font-size: 0.7rem;
      font-family: sans-serif;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.9;
    }

    .model-buttons {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .model-btn {
      padding: 0.4rem 0.65rem;
      background: rgba(255,255,255,0.08);
      color: white;
      border: 1.5px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      cursor: pointer;
      font-family: sans-serif;
      font-size: 0.75rem;
      transition: all 0.2s ease;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .model-btn:hover {
      background: rgba(255,255,255,0.2);
      border-color: rgba(255,255,255,0.4);
      transform: translateX(5px);
    }

    .model-btn.active {
      background: rgba(103, 126, 234, 0.6);
      border-color: rgba(103, 126, 234, 1);
    }

    .model-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      padding: 1rem;
      color: rgba(255, 255, 255, 0.8);
    }

    .loading-text {
      margin: 0;
      font-size: 0.7rem;
      font-family: sans-serif;
    }

    .spinner {
      width: 25px;
      height: 25px;
      border: 3px solid rgba(255, 255, 255, 0.2);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .no-models {
      padding: 0.5rem;
      text-align: center;
      color: rgba(255, 255, 255, 0.6);
      font-size: 0.7rem;
    }

    .rotation-controls {
      position: absolute;
      top: 0.75rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.85);
      padding: 0.5rem 0.75rem;
      border-radius: 12px;
      backdrop-filter: blur(10px);
      z-index: 999;
      transition: all 0.3s ease;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      max-width: 90%;
    }

    .rotation-controls.collapsed {
      padding: 0;
      background: transparent;
      backdrop-filter: none;
      box-shadow: none;
    }

    .rotation-controls.collapsed .controls-content {
      display: none;
    }

    .toggle-controls-btn {
      position: absolute;
      bottom: -12px;
      left: 50%;
      transform: translateX(-50%);
      width: 35px;
      height: 25px;
      background: rgba(0, 0, 0, 0.9);
      border: 2px solid rgba(103, 126, 234, 1);
      border-radius: 0 0 8px 8px;
      color: white;
      font-size: 1.1rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.3s ease;
      z-index: 10;
      box-shadow: 0 3px 10px rgba(103, 126, 234, 0.4);
    }

    .toggle-controls-btn:hover {
      background: rgba(103, 126, 234, 0.9);
      transform: translateX(-50%) scale(1.1);
      box-shadow: 0 6px 20px rgba(103, 126, 234, 0.8);
    }

    .toggle-controls-btn span {
      display: block;
      line-height: 1;
    }

    .controls-content {
      transition: all 0.3s ease;
    }

    .rotation-controls h3 {
      color: white;
      margin: 0 0 0.4rem 0;
      font-size: 0.7rem;
      font-family: sans-serif;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.9;
    }

    .rotation-buttons {
      display: flex;
      gap: 0.4rem;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
    }

    .drag-hint {
      margin: 0.4rem 0 0 0;
      padding: 0;
      font-size: 0.65rem;
      color: rgba(255, 255, 255, 0.5);
      text-align: center;
      font-style: italic;
      line-height: 1.3;
    }

    .rotation-btn {
      padding: 0.4rem 0.75rem;
      background: rgba(255,255,255,0.08);
      color: white;
      border: 1.5px solid rgba(255,255,255,0.2);
      border-radius: 8px;
      cursor: pointer;
      font-family: sans-serif;
      font-size: 0.7rem;
      font-weight: 600;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .rotation-btn:hover {
      background: rgba(255,255,255,0.2);
      border-color: rgba(255,255,255,0.4);
      transform: scale(1.05);
    }

    .rotation-btn.active {
      background: rgba(76, 175, 80, 0.6);
      border-color: rgba(76, 175, 80, 1);
      animation: pulse 2s infinite;
    }

    .rotation-btn.stop-btn.active {
      background: rgba(244, 67, 54, 0.6);
      border-color: rgba(244, 67, 54, 1);
      animation: none;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }
  `]
})
export class ArPageComponent implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') containerRef!: ElementRef<HTMLDivElement>;

  private modelCache = inject(ModelCacheService);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);
  
  // Three.js elements
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private loader = new GLTFLoader();
  private animationId: number = 0;
  private currentModel: THREE.Group | null = null;

  // Models list (loaded from Firebase Storage)
  models: ModelInfo[] = [];
  isLoadingModels: boolean = true;
  isLoadingModel: boolean = false;
  isPanelCollapsed: boolean = false;
  isControlsCollapsed: boolean = false;

  currentModelPath: string = '';
  
  // Rotation state
  isRotating: boolean = false;
  rotationDirection: 'left' | 'right' = 'right';
  rotationSpeed: number = 0.01;

  // Drag rotation state
  private isDragging: boolean = false;
  private previousMousePosition = { x: 0, y: 0 };

  // Pinch zoom state
  private isPinching: boolean = false;
  private previousPinchDistance: number = 0;
  private modelScale: number = 1;

  ngAfterViewInit(): void {
    this.initThreeJS();
    this.setupDragControls();
    this.animate();
    this.loadModelsFromStorage();
  }

  async loadModelsFromStorage(): Promise<void> {
    try {
      this.isLoadingModels = true;
      this.cdr.detectChanges(); // Forzar detección de cambios
      console.log('📦 Loading models from Firebase Storage...');
      this.models = await this.modelCache.listModelsFromStorage();
      console.log(`✅ Loaded ${this.models.length} models`, this.models);
    } catch (error) {
      console.error('Error loading models from storage:', error);
    } finally {
      this.isLoadingModels = false;
      this.cdr.detectChanges(); // Forzar detección de cambios
    }
  }

  togglePanel(): void {
    this.isPanelCollapsed = !this.isPanelCollapsed;
  }

  toggleControls(): void {
    this.isControlsCollapsed = !this.isControlsCollapsed;
  }

  ngOnDestroy(): void {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.renderer) {
      this.renderer.dispose();
    }
    this.removeDragControls();
  }

  private setupDragControls(): void {
    const canvas = this.canvasRef.nativeElement;

    // Mouse events
    canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
    canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
    canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    canvas.addEventListener('mouseleave', this.onMouseUp.bind(this));
    canvas.addEventListener('wheel', this.onMouseWheel.bind(this), { passive: false });

    // Touch events
    canvas.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd.bind(this));
  }

  private removeDragControls(): void {
    const canvas = this.canvasRef.nativeElement;
    if (canvas) {
      canvas.removeEventListener('mousedown', this.onMouseDown.bind(this));
      canvas.removeEventListener('mousemove', this.onMouseMove.bind(this));
      canvas.removeEventListener('mouseup', this.onMouseUp.bind(this));
      canvas.removeEventListener('mouseleave', this.onMouseUp.bind(this));
      canvas.removeEventListener('wheel', this.onMouseWheel.bind(this));
      canvas.removeEventListener('touchstart', this.onTouchStart.bind(this));
      canvas.removeEventListener('touchmove', this.onTouchMove.bind(this));
      canvas.removeEventListener('touchend', this.onTouchEnd.bind(this));
    }
  }

  // Mouse handlers
  private onMouseDown(event: MouseEvent): void {
    this.isDragging = true;
    this.previousMousePosition = {
      x: event.clientX,
      y: event.clientY
    };
    // Stop auto-rotation when user starts dragging
    this.stopRotation();
  }

  private onMouseMove(event: MouseEvent): void {
    if (!this.isDragging || !this.currentModel) return;

    const deltaX = event.clientX - this.previousMousePosition.x;
    const deltaY = event.clientY - this.previousMousePosition.y;

    // Rotate on Y axis (horizontal drag)
    this.currentModel.rotation.y += deltaX * 0.01;
    
    // Rotate on X axis (vertical drag)
    this.currentModel.rotation.x += deltaY * 0.01;

    this.previousMousePosition = {
      x: event.clientX,
      y: event.clientY
    };
  }

  private onMouseUp(): void {
    this.isDragging = false;
  }

  // Mouse wheel handler for zoom
  private onMouseWheel(event: WheelEvent): void {
    if (!this.currentModel) return;
    
    event.preventDefault();
    
    // Determine zoom direction
    const delta = event.deltaY > 0 ? -0.1 : 0.1;
    
    // Update model scale
    this.modelScale += delta;
    
    // Clamp scale between 0.1 and 5
    this.modelScale = Math.max(0.1, Math.min(5, this.modelScale));
    
    this.currentModel.scale.setScalar(this.modelScale);
  }

  // Touch handlers
  private onTouchStart(event: TouchEvent): void {
    if (event.touches.length === 1) {
      // Single touch - rotation
      event.preventDefault();
      this.isDragging = true;
      this.isPinching = false;
      this.previousMousePosition = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      };
      // Stop auto-rotation when user starts dragging
      this.stopRotation();
    } else if (event.touches.length === 2) {
      // Two touches - pinch to zoom
      event.preventDefault();
      this.isDragging = false;
      this.isPinching = true;
      this.previousPinchDistance = this.getDistance(
        event.touches[0],
        event.touches[1]
      );
    }
  }

  private onTouchMove(event: TouchEvent): void {
    if (!this.currentModel) return;

    if (this.isDragging && event.touches.length === 1) {
      // Single touch - rotation
      event.preventDefault();
      const touch = event.touches[0];
      const deltaX = touch.clientX - this.previousMousePosition.x;
      const deltaY = touch.clientY - this.previousMousePosition.y;

      // Rotate on Y axis (horizontal drag)
      this.currentModel.rotation.y += deltaX * 0.01;
      
      // Rotate on X axis (vertical drag)
      this.currentModel.rotation.x += deltaY * 0.01;

      this.previousMousePosition = {
        x: touch.clientX,
        y: touch.clientY
      };
    } else if (this.isPinching && event.touches.length === 2) {
      // Two touches - pinch to zoom
      event.preventDefault();
      const currentDistance = this.getDistance(
        event.touches[0],
        event.touches[1]
      );

      const delta = currentDistance - this.previousPinchDistance;
      const scaleFactor = 1 + (delta * 0.01);

      // Update model scale
      this.modelScale *= scaleFactor;
      
      // Clamp scale between 0.1 and 5
      this.modelScale = Math.max(0.1, Math.min(5, this.modelScale));
      
      this.currentModel.scale.setScalar(this.modelScale);

      this.previousPinchDistance = currentDistance;
    }
  }

  private onTouchEnd(event: TouchEvent): void {
    if (event.touches.length === 0) {
      // All touches ended
      this.isDragging = false;
      this.isPinching = false;
    } else if (event.touches.length === 1 && this.isPinching) {
      // Went from 2 touches to 1 - switch to rotation mode
      this.isPinching = false;
      this.isDragging = true;
      this.previousMousePosition = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      };
    }
  }

  // Helper function to calculate distance between two touch points
  private getDistance(touch1: Touch, touch2: Touch): number {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private initThreeJS(): void {
    const canvas = this.canvasRef.nativeElement;
    const container = this.containerRef.nativeElement;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = null;

    // Camera
    const aspect = container.clientWidth / container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    this.camera.position.set(0, 0, 3);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ 
      canvas, 
      antialias: true,
      alpha: true 
    });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 5, 5);
    this.scene.add(directionalLight);

    const backLight = new THREE.DirectionalLight(0xffffff, 0.5);
    backLight.position.set(-5, 0, -5);
    this.scene.add(backLight);

    // Handle window resize
    window.addEventListener('resize', () => this.onWindowResize());
  }

  private onWindowResize(): void {
    const container = this.containerRef.nativeElement;
    const aspect = container.clientWidth / container.clientHeight;
    
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(container.clientWidth, container.clientHeight);
  }

  async loadModel(storagePath: string): Promise<void> {
    if (this.isLoadingModel) {
      console.log('⏳ Already loading a model, please wait...');
      return;
    }

    try {
      this.isLoadingModel = true;
      this.currentModelPath = storagePath;
      this.cdr.detectChanges();

      // Remove current model
      if (this.currentModel) {
        this.scene.remove(this.currentModel);
        this.currentModel = null;
      }

      // Reset scale
      this.modelScale = 1;

      console.log('📥 Loading model from Firebase Storage:', storagePath);

      // Get URL from cache or Firebase Storage
      const modelUrl = await this.modelCache.getModelBlob(storagePath);
      
      console.log('🔄 Loading model into scene from URL...');

      // Load model directly (may be blob URL from cache or Firebase download URL)
      this.loader.load(
        modelUrl,
        (gltf) => {
          this.ngZone.run(() => {
            console.log('✅ Model loaded successfully into scene');
            this.currentModel = gltf.scene;
            
            // Center and scale model
            const box = new THREE.Box3().setFromObject(this.currentModel);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            
            const maxDim = Math.max(size.x, size.y, size.z);
            const scale = 2 / maxDim;
            
            this.currentModel.scale.multiplyScalar(scale);
            
            // Center the model
            this.currentModel.position.sub(center.multiplyScalar(scale));
            
            // Store the base scale for later modifications
            this.modelScale = scale;
            
            this.scene.add(this.currentModel);
            
            // If it's a blob URL, revoke it to free memory
            if (modelUrl.startsWith('blob:')) {
              URL.revokeObjectURL(modelUrl);
            } else {
              // If it's a Firebase URL, try to cache it for next time
              this.modelCache.cacheModelFromUrl(storagePath, modelUrl).catch(err => {
                console.warn('Could not cache model:', err);
              });
            }
            
            this.isLoadingModel = false;
            this.cdr.detectChanges();
          });
        },
        (progress) => {
          const percent = progress.loaded && progress.total 
            ? (progress.loaded / progress.total) * 100 
            : 0;
          if (percent > 0) {
            console.log(`Loading into scene: ${percent.toFixed(2)}%`);
          }
        },
        (error: unknown) => {
          this.ngZone.run(() => {
            console.error('❌ Error loading model into scene:', error);
            const errorObj = error instanceof Error ? error : new Error(String(error));
            console.error('Full error details:', {
              message: errorObj.message,
              stack: errorObj.stack,
              storagePath: storagePath,
              modelUrl: modelUrl
            });
            
            // If it's a blob URL, revoke it even on error
            if (modelUrl.startsWith('blob:')) {
              URL.revokeObjectURL(modelUrl);
            }
            
            this.isLoadingModel = false;
            this.cdr.detectChanges();
          });
        }
      );
    } catch (error) {
      console.error('❌ Error getting model blob:', error);
      this.isLoadingModel = false;
    }
  }

  toggleRotation(direction: 'left' | 'right'): void {
    if (this.isRotating && this.rotationDirection === direction) {
      this.stopRotation();
    } else {
      this.isRotating = true;
      this.rotationDirection = direction;
    }
  }

  stopRotation(): void {
    this.isRotating = false;
  }

  private animate(): void {
    this.animationId = requestAnimationFrame(() => this.animate());

    // Apply rotation if enabled
    if (this.isRotating && this.currentModel) {
      const speed = this.rotationDirection === 'right' ? this.rotationSpeed : -this.rotationSpeed;
      this.currentModel.rotation.y += speed;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
