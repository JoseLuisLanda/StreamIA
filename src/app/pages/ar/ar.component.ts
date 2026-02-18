import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

interface ModelInfo {
  name: string;
  path: string;
  displayName: string;
}

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
      <div class="model-toolbar">
        <h3>Seleccionar Modelo</h3>
        <div class="model-buttons">
          <button 
            *ngFor="let model of models" 
            (click)="loadModel(model.path)"
            [class.active]="currentModelPath === model.path"
            class="model-btn">
            {{ model.displayName }}
          </button>
        </div>
      </div>

      <!-- Rotation Controls -->
      <div class="rotation-controls" *ngIf="currentModelPath">
        <h3>Rotación Automática</h3>
        <div class="rotation-buttons">
          <button 
            (click)="toggleRotation('left')"
            [class.active]="isRotating && rotationDirection === 'left'"
            class="rotation-btn">
            ← Rotar Izquierda
          </button>
          <button 
            (click)="stopRotation()"
            [class.active]="!isRotating"
            class="rotation-btn stop-btn">
            ⏸ Detener
          </button>
          <button 
            (click)="toggleRotation('right')"
            [class.active]="isRotating && rotationDirection === 'right'"
            class="rotation-btn">
            Rotar Derecha →
          </button>
        </div>
        <p class="drag-hint">💡 Arrastra para rotar | 🖱️ Rueda/📱 Pinch para zoom</p>
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
      top: 1rem;
      left: 1rem;
      z-index: 2000;
      color: white;
      text-decoration: none;
      background: rgba(0,0,0,0.7);
      padding: 0.75rem 1.5rem;
      border-radius: 25px;
      font-family: sans-serif;
      font-weight: 600;
      transition: all 0.3s ease;
    }

    .back-btn:hover {
      background: rgba(0,0,0,0.9);
      transform: translateY(-2px);
    }

    .model-toolbar {
      position: absolute;
      top: 1rem;
      right: 1rem;
      background: rgba(0,0,0,0.8);
      padding: 1rem;
      border-radius: 15px;
      backdrop-filter: blur(10px);
      z-index: 1000;
      max-width: 300px;
      max-height: calc(100vh - 2rem);
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.3) transparent;
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
      margin: 0 0 0.75rem 0;
      font-size: 0.9rem;
      font-family: sans-serif;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .model-buttons {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .model-btn {
      padding: 0.6rem 1rem;
      background: rgba(255,255,255,0.1);
      color: white;
      border: 2px solid rgba(255,255,255,0.2);
      border-radius: 10px;
      cursor: pointer;
      font-family: sans-serif;
      font-size: 0.85rem;
      transition: all 0.3s ease;
      text-align: left;
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

    .rotation-controls {
      position: absolute;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.8);
      padding: 1rem 1.5rem;
      border-radius: 15px;
      backdrop-filter: blur(10px);
      z-index: 1000;
    }

    .rotation-controls h3 {
      color: white;
      margin: 0 0 0.75rem 0;
      font-size: 0.9rem;
      font-family: sans-serif;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .rotation-buttons {
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }

    .drag-hint {
      margin: 0.75rem 0 0 0;
      padding: 0;
      font-size: 0.8rem;
      color: rgba(255, 255, 255, 0.6);
      text-align: center;
      font-style: italic;
    }

    .rotation-btn {
      padding: 0.75rem 1.25rem;
      background: rgba(255,255,255,0.1);
      color: white;
      border: 2px solid rgba(255,255,255,0.2);
      border-radius: 10px;
      cursor: pointer;
      font-family: sans-serif;
      font-size: 0.9rem;
      font-weight: 600;
      transition: all 0.3s ease;
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

  private http = inject(HttpClient);
  
  // Three.js elements
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private loader = new GLTFLoader();
  private animationId: number = 0;
  private currentModel: THREE.Group | null = null;

  // Models list
  models: ModelInfo[] = [
    { name: 'glasses', path: 'assets/models/glasses.glb', displayName: '👓 Lentes' },
    { name: 'hair', path: 'assets/models/hair.glb', displayName: '💇 Cabello' },
    { name: 'header', path: 'assets/models/header.glb', displayName: '👤 Cabeza' },
    { name: 'imagen', path: 'assets/models/imagen.glb', displayName: '🖼️ Imagen' },
    { name: 'mask', path: 'assets/models/mask.glb', displayName: '🎭 Máscara' },
    { name: 'menu', path: 'assets/models/menu.glb', displayName: '📋 Menú' },
    { name: 'mustache', path: 'assets/models/mustache.glb', displayName: '🧔 Bigote' },
    { name: 'pineapple', path: 'assets/models/pineapple.glb', displayName: '🍍 Piña' },
    { name: 'shirt-normal', path: 'assets/models/shirt normal.glb', displayName: '👕 Camisa' },
    { name: 'strawberry', path: 'assets/models/strawberry.glb', displayName: '🍓 Fresa' },
    { name: 'tshirt', path: 'assets/models/tshirt.glb', displayName: '👕 Playera' }
  ];

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

  loadModel(path: string): void {
    this.currentModelPath = path;

    // Remove current model
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel = null;
    }

    // Reset scale
    this.modelScale = 1;

    // Load new model
    this.loader.load(
      path,
      (gltf) => {
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
      },
      undefined,
      (error) => {
        console.error('Error loading model:', error);
      }
    );
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
