import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { VideoPreviewComponent } from '../../components/video-preview/video-preview.component';
import { ArMaskComponent } from '../../components/ar-mask/ar-mask.component';

@Component({
    selector: 'app-ar-face-tracking-page',
    standalone: true,
    imports: [CommonModule, RouterLink, VideoPreviewComponent, ArMaskComponent],
    template: `
    <div class="ar-container">
      <app-video-preview></app-video-preview>
      <app-ar-mask></app-ar-mask>
      
      <!-- Back Button -->
      <a routerLink="/" class="back-btn">← Volver</a>
    </div>
  `,
    styles: [`
    .ar-container {
      position: relative;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: #000;
    }
    
    /* Ensure child components fill the container */
    app-video-preview {
      display: block;
      width: 100%;
      height: 100%;
    }
    
    app-ar-mask {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
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
  `]
})
export class ArFaceTrackingComponent { }
