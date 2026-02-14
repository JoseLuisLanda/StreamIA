import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy, inject, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FaceTrackingService } from '../../services/face-tracking.service';

@Component({
  selector: 'app-video-preview',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="video-container">
      <video #videoElement 
        class="input_video" 
        autoplay 
        playsinline
        muted
        [style.transform]="'scaleX(-1)'"
        [style.opacity]="faceTrackingService.hideVideo() ? '0' : '1'"
      ></video>
      <canvas #maskCanvas 
        class="mask-canvas"
        [style.transform]="'scaleX(-1)'"
      ></canvas>
    </div>
  `,
  styles: [`
    .video-container {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 12px;
      overflow: hidden;
      background: #00ff00;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
    }
    
    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: opacity 0.3s ease;
    }
    
    .mask-canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      pointer-events: none;
    }
  `]
})
export class VideoPreviewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;
  @ViewChild('maskCanvas') maskCanvas!: ElementRef<HTMLCanvasElement>;

  public faceTrackingService = inject(FaceTrackingService);
  private renderLoopId: number | null = null;

  constructor() {
    effect(() => {
      const hidePerson = this.faceTrackingService.hidePersonWithGreen();
      
      if (hidePerson) {
        // Start render loop for continuous updates
        if (!this.renderLoopId) {
          this.startRenderLoop();
        }
      } else {
        // Stop render loop and clear canvas
        if (this.renderLoopId) {
          cancelAnimationFrame(this.renderLoopId);
          this.renderLoopId = null;
        }
        if (this.maskCanvas) {
          const canvas = this.maskCanvas.nativeElement;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
        }
      }
    });
  }

  ngAfterViewInit() {
    this.faceTrackingService.initialize(this.videoElement.nativeElement);
    this.setupCanvas();
  }

  ngOnDestroy() {
    if (this.renderLoopId) {
      cancelAnimationFrame(this.renderLoopId);
    }
  }

  private startRenderLoop() {
    const render = () => {
      const landmarks = this.faceTrackingService.landmarks();
      if (landmarks && this.faceTrackingService.hidePersonWithGreen()) {
        this.drawPersonMask(landmarks);
      }
      this.renderLoopId = requestAnimationFrame(render);
    };
    this.renderLoopId = requestAnimationFrame(render);
  }

  private setupCanvas() {
    const canvas = this.maskCanvas.nativeElement;
    const video = this.videoElement.nativeElement;
    
    const resizeCanvas = () => {
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
    };
    
    video.addEventListener('loadedmetadata', resizeCanvas);
    resizeCanvas();
  }

  private drawPersonMask(landmarks: any[]) {
    const canvas = this.maskCanvas.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx || !landmarks || landmarks.length === 0) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Get face boundaries from landmarks
    const xs = landmarks.map(lm => lm.x * canvas.width);
    const ys = landmarks.map(lm => lm.y * canvas.height);
    
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    
    const faceWidth = maxX - minX;
    const faceHeight = maxY - minY;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    // Expand area to cover shoulders and body
    const bodyWidth = faceWidth * 3.5;
    const bodyHeight = faceHeight * 4.5;
    const bodyTop = minY - faceHeight * 0.3;
    
    // Draw green ellipse over person
    ctx.fillStyle = '#00ff00';
    ctx.beginPath();
    ctx.ellipse(
      centerX,
      bodyTop + bodyHeight / 2,
      bodyWidth / 2,
      bodyHeight / 2,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }
}
