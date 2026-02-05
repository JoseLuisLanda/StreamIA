import { Component, Input, Output, EventEmitter, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface MediaItem {
  type: 'image' | 'video';
  url: string;
}

export interface MediaOverlay {
  id: string;
  name: string;
  items: MediaItem[];
  currentIndex: number;
  isPlaying: boolean;
  autoLoop: boolean;
  intervalSeconds: number;
  position?: { x: number, y: number };
}

@Component({
  selector: 'app-media-overlay',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div 
        class="overlay-box" 
        [class.draggable]="draggable"
        [class.dragging]="isDragging"
        [style.width.px]="width" 
        [style.height.px]="height"
        [style.position]="draggable && overlay.position ? 'absolute' : 'relative'"
        [style.left.px]="draggable && overlay.position ? overlay.position.x : null"
        [style.top.px]="draggable && overlay.position ? overlay.position.y : null"
        (mousedown)="onMouseDown($event)"
    >
      <!-- Media Content -->
      <div class="media-container" *ngIf="overlay.items.length > 0">
        <!-- Image -->
        <img 
          *ngIf="currentItem?.type === 'image'" 
          [src]="currentItem?.url" 
          alt="Overlay media"
          class="media-content"
          [style.pointer-events]="'none'"
        />
        
        <!-- Video -->
        <video 
          *ngIf="currentItem?.type === 'video'"
          #videoPlayer
          [src]="currentItem?.url"
          class="media-content"
          [muted]="true"
          (ended)="onVideoEnded()"
          (click)="toggleVideoPlay()"
        ></video>
      </div>
      
      <!-- Empty State -->
      <div class="empty-state" *ngIf="overlay.items.length === 0">
        <span>No media</span>
      </div>
      
      <!-- Controls Bar -->
      <div class="controls-bar" (mousedown)="$event.stopPropagation()">
        <!-- Play/Pause -->
        <button class="control-btn" (click)="togglePlay()" [title]="overlay.isPlaying ? 'Pause' : 'Play'">
          {{ overlay.isPlaying ? '⏸' : '▶' }}
        </button>
        
        <!-- Navigation -->
        <button class="control-btn" (click)="prev()" *ngIf="overlay.items.length > 1">◀</button>
        <span class="indicator" *ngIf="overlay.items.length > 1">{{ overlay.currentIndex + 1 }}/{{ overlay.items.length }}</span>
        <button class="control-btn" (click)="next()" *ngIf="overlay.items.length > 1">▶</button>
        
        <!-- Close -->
        <button class="control-btn close-btn" (click)="onRemove.emit(overlay.id)" title="Remove">✕</button>
      </div>
      
      <!-- Name Label -->
      <div class="name-label">{{ overlay.name }}</div>
    </div>
  `,
  styles: [`
    .overlay-box {
      position: relative;
      background: rgba(0, 0, 0, 0.8);
      border-radius: 12px;
      overflow: hidden;
      border: 2px solid rgba(255, 255, 255, 0.2);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      transition: box-shadow 0.2s;
    }
    
    .overlay-box.draggable {
      cursor: grab;
      border-color: #00d9ff;
    }
    
    .overlay-box.dragging {
        cursor: grabbing;
        box-shadow: 0 0 20px rgba(0, 217, 255, 0.6);
        z-index: 1000;
    }
    
    .media-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .media-content {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    
    .empty-state {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.4);
      font-size: 0.85rem;
    }
    
    .controls-bar {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 6px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
      opacity: 0;
      transition: opacity 0.2s;
    }
    
    .overlay-box:hover .controls-bar {
      opacity: 1;
    }
    
    .control-btn {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.2);
      color: white;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .control-btn:hover {
      background: rgba(255, 255, 255, 0.4);
      transform: scale(1.1);
    }
    
    .close-btn {
      position: absolute;
      right: 6px;
      background: rgba(255, 80, 80, 0.6);
    }
    .close-btn:hover {
      background: rgba(255, 80, 80, 0.9);
    }
    
    .indicator {
      color: white;
      font-size: 0.75rem;
      min-width: 30px;
      text-align: center;
    }
    
    .name-label {
      position: absolute;
      top: 6px;
      left: 6px;
      background: rgba(0, 0, 0, 0.6);
      color: white;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.7rem;
      opacity: 0;
      transition: opacity 0.2s;
    }
    
    .overlay-box:hover .name-label {
      opacity: 1;
    }
  `]
})
export class MediaOverlayComponent implements OnDestroy {
  @Input() overlay!: MediaOverlay;
  @Input() width = 200;
  @Input() height = 150;
  @Input() draggable = false;

  @Output() onRemove = new EventEmitter<string>();
  @Output() onUpdate = new EventEmitter<MediaOverlay>();
  @Output() onPositionChange = new EventEmitter<MediaOverlay>();

  @ViewChild('videoPlayer') videoPlayer?: ElementRef<HTMLVideoElement>;

  private autoPlayInterval: ReturnType<typeof setInterval> | null = null;

  // Drag state
  isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private initialPosX = 0;
  private initialPosY = 0;

  get currentItem(): MediaItem | null {
    if (!this.overlay || this.overlay.items.length === 0) return null;
    return this.overlay.items[this.overlay.currentIndex];
  }

  ngOnDestroy() {
    this.stopAutoPlay();
    this.removeDragListeners();
  }

  // Drag Logic
  onMouseDown(event: MouseEvent) {
    if (!this.draggable) return;

    // Don't drag if clicking controls (handled by stopPropagation in template, but safety check)
    // Also don't drag if not left click
    if (event.button !== 0) return;

    event.preventDefault();
    this.isDragging = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;

    // Initialize position if not set
    if (!this.overlay.position) {
      // This is tricky because we need the current relative position if swapping to absolute
      // But relying on parent to set initial positions is safer.
      // For now, assume if position is undefined, we start at 0,0 or we rely on logic component to set it.
      // However, if we are in draggable mode, position SHOULD be set by parent or here.
      this.overlay.position = { x: 0, y: 0 };
    }

    this.initialPosX = this.overlay.position!.x;
    this.initialPosY = this.overlay.position!.y;

    this.addDragListeners();
  }

  private addDragListeners() {
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mouseup', this.onMouseUp);
  }

  private removeDragListeners() {
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mouseup', this.onMouseUp);
  }

  private onMouseMove = (event: MouseEvent) => {
    if (!this.isDragging) return;

    const deltaX = event.clientX - this.dragStartX;
    const deltaY = event.clientY - this.dragStartY;

    if (this.overlay.position) {
      this.overlay.position.x = this.initialPosX + deltaX;
      this.overlay.position.y = this.initialPosY + deltaY;
    }
  }

  private onMouseUp = () => {
    if (this.isDragging) {
      this.isDragging = false;
      this.removeDragListeners();
      this.onPositionChange.emit(this.overlay);
    }
  }

  togglePlay() {
    this.overlay.isPlaying = !this.overlay.isPlaying;

    if (this.overlay.isPlaying) {
      // If current item is video, play it
      if (this.currentItem?.type === 'video' && this.videoPlayer) {
        this.videoPlayer.nativeElement.play();
      }
      // Start auto-loop for images or multiple items
      if (this.overlay.autoLoop && this.overlay.items.length > 1) {
        this.startAutoPlay();
      }
    } else {
      // Pause video if playing
      if (this.videoPlayer) {
        this.videoPlayer.nativeElement.pause();
      }
      this.stopAutoPlay();
    }

    this.onUpdate.emit(this.overlay);
  }

  toggleVideoPlay() {
    if (this.currentItem?.type === 'video' && this.videoPlayer) {
      if (this.videoPlayer.nativeElement.paused) {
        this.videoPlayer.nativeElement.play();
        this.overlay.isPlaying = true;
      } else {
        this.videoPlayer.nativeElement.pause();
        this.overlay.isPlaying = false;
      }
      this.onUpdate.emit(this.overlay);
    }
  }

  prev() {
    if (this.overlay.items.length === 0) return;
    this.overlay.currentIndex = this.overlay.currentIndex === 0
      ? this.overlay.items.length - 1
      : this.overlay.currentIndex - 1;
    this.onMediaChange();
  }

  next() {
    if (this.overlay.items.length === 0) return;
    this.overlay.currentIndex = (this.overlay.currentIndex + 1) % this.overlay.items.length;
    this.onMediaChange();
  }

  private onMediaChange() {
    // If new item is video and we're playing, start the video
    setTimeout(() => {
      if (this.currentItem?.type === 'video' && this.overlay.isPlaying && this.videoPlayer) {
        this.videoPlayer.nativeElement.play();
      }
    }, 100);
    this.onUpdate.emit(this.overlay);
  }

  onVideoEnded() {
    // Auto-advance to next item when video ends
    if (this.overlay.autoLoop && this.overlay.items.length > 1) {
      this.next();
    } else if (this.overlay.items.length === 1) {
      // Single video, restart if looping
      if (this.overlay.autoLoop && this.videoPlayer) {
        this.videoPlayer.nativeElement.currentTime = 0;
        this.videoPlayer.nativeElement.play();
      }
    }
  }

  private startAutoPlay() {
    this.stopAutoPlay();

    // Only auto-advance if current item is image (videos auto-advance on end)
    if (this.currentItem?.type === 'image') {
      this.autoPlayInterval = setInterval(() => {
        if (this.currentItem?.type === 'image') {
          this.next();
        }
      }, this.overlay.intervalSeconds * 1000);
    }
  }

  private stopAutoPlay() {
    if (this.autoPlayInterval) {
      clearInterval(this.autoPlayInterval);
      this.autoPlayInterval = null;
    }
  }
}
