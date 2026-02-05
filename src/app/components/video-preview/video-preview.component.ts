import { Component, ElementRef, ViewChild, AfterViewInit, inject } from '@angular/core';
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
      ></video>
    </div>
  `,
  styles: [`
    .video-container {
      width: 100%;
      height: 100%;
      border-radius: 12px;
      overflow: hidden;
      /* z-index handled by parent */
      background: #000;
      box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
    }
    
    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `]
})
export class VideoPreviewComponent implements AfterViewInit {
  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;

  private faceTrackingService = inject(FaceTrackingService);

  ngAfterViewInit() {
    this.faceTrackingService.initialize(this.videoElement.nativeElement);
  }
}
