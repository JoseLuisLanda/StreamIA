import { Injectable, signal, WritableSignal } from '@angular/core';
import { PoseLandmarker, PoseLandmarkerOptions, FilesetResolver, PoseLandmarkerResult } from '@mediapipe/tasks-vision';

export interface PoseLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

@Injectable({
  providedIn: 'root'
})
export class BodyTrackingService {
  public poseLandmarks: WritableSignal<PoseLandmark[] | null> = signal(null);
  public worldLandmarks: WritableSignal<PoseLandmark[] | null> = signal(null);
  public isTracking: WritableSignal<boolean> = signal(false);

  private poseLandmarker: PoseLandmarker | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private lastVideoTime = -1;
  private animationFrameId: number | null = null;

  // Índices de landmarks importantes para ropa
  public readonly POSE_LANDMARKS = {
    NOSE: 0,
    LEFT_EYE: 2,
    RIGHT_EYE: 5,
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,
    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
    LEFT_KNEE: 25,
    RIGHT_KNEE: 26,
    LEFT_ANKLE: 27,
    RIGHT_ANKLE: 28
  };

  constructor() { }

  async initialize(videoElement: HTMLVideoElement): Promise<void> {
    this.videoElement = videoElement;

    try {
      const filesetResolver = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
      );

      const options: PoseLandmarkerOptions = {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      };

      this.poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, options);
      this.isTracking.set(true);
      this.predict();
      
      console.log('Body tracking initialized successfully');
    } catch (error) {
      console.error('Error initializing body tracking:', error);
    }
  }

  private predict = () => {
    if (!this.poseLandmarker || !this.videoElement) {
      this.animationFrameId = requestAnimationFrame(this.predict);
      return;
    }

    const nowInMs = Date.now();
    if (this.lastVideoTime !== this.videoElement.currentTime) {
      this.lastVideoTime = this.videoElement.currentTime;

      try {
        const result: PoseLandmarkerResult = this.poseLandmarker.detectForVideo(this.videoElement, nowInMs);

        if (result.landmarks && result.landmarks.length > 0) {
          this.poseLandmarks.set(result.landmarks[0] as PoseLandmark[]);
        } else {
          this.poseLandmarks.set(null);
        }

        if (result.worldLandmarks && result.worldLandmarks.length > 0) {
          this.worldLandmarks.set(result.worldLandmarks[0] as PoseLandmark[]);
        } else {
          this.worldLandmarks.set(null);
        }
      } catch (error) {
        // Video might not be ready yet, continue loop
      }
    }

    this.animationFrameId = requestAnimationFrame(this.predict);
  };

  stop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.isTracking.set(false);
    this.poseLandmarks.set(null);
    this.worldLandmarks.set(null);
  }

  // Helper para obtener un landmark específico
  getLandmark(index: number): PoseLandmark | null {
    const landmarks = this.poseLandmarks();
    if (!landmarks || index >= landmarks.length) return null;
    return landmarks[index];
  }

  // Helper para obtener centro de hombros
  getShoulderCenter(): { x: number; y: number; z: number } | null {
    const leftShoulder = this.getLandmark(this.POSE_LANDMARKS.LEFT_SHOULDER);
    const rightShoulder = this.getLandmark(this.POSE_LANDMARKS.RIGHT_SHOULDER);
    
    if (!leftShoulder || !rightShoulder) return null;
    
    return {
      x: (leftShoulder.x + rightShoulder.x) / 2,
      y: (leftShoulder.y + rightShoulder.y) / 2,
      z: (leftShoulder.z + rightShoulder.z) / 2
    };
  }

  // Helper para obtener ancho de hombros
  getShoulderWidth(): number | null {
    const leftShoulder = this.getLandmark(this.POSE_LANDMARKS.LEFT_SHOULDER);
    const rightShoulder = this.getLandmark(this.POSE_LANDMARKS.RIGHT_SHOULDER);
    
    if (!leftShoulder || !rightShoulder) return null;
    
    const dx = rightShoulder.x - leftShoulder.x;
    const dy = rightShoulder.y - leftShoulder.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Helper para obtener ángulo de inclinación de hombros
  getShoulderAngle(): number | null {
    const leftShoulder = this.getLandmark(this.POSE_LANDMARKS.LEFT_SHOULDER);
    const rightShoulder = this.getLandmark(this.POSE_LANDMARKS.RIGHT_SHOULDER);
    
    if (!leftShoulder || !rightShoulder) return null;
    
    return Math.atan2(rightShoulder.y - leftShoulder.y, rightShoulder.x - leftShoulder.x);
  }

  // Helper para obtener centro de cadera
  getHipCenter(): { x: number; y: number; z: number } | null {
    const leftHip = this.getLandmark(this.POSE_LANDMARKS.LEFT_HIP);
    const rightHip = this.getLandmark(this.POSE_LANDMARKS.RIGHT_HIP);
    
    if (!leftHip || !rightHip) return null;
    
    return {
      x: (leftHip.x + rightHip.x) / 2,
      y: (leftHip.y + rightHip.y) / 2,
      z: (leftHip.z + rightHip.z) / 2
    };
  }

  // Verificar si el cuerpo está visible con suficiente confianza
  isBodyVisible(): boolean {
    const leftShoulder = this.getLandmark(this.POSE_LANDMARKS.LEFT_SHOULDER);
    const rightShoulder = this.getLandmark(this.POSE_LANDMARKS.RIGHT_SHOULDER);
    
    if (!leftShoulder || !rightShoulder) return false;
    
    // Verificar visibility si está disponible
    const leftVisible = leftShoulder.visibility !== undefined ? leftShoulder.visibility > 0.5 : true;
    const rightVisible = rightShoulder.visibility !== undefined ? rightShoulder.visibility > 0.5 : true;
    
    return leftVisible && rightVisible;
  }
}
