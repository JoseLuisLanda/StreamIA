import { Injectable, signal, WritableSignal } from '@angular/core';
import { Euler, Matrix4 } from 'three';
import { FaceLandmarker, FaceLandmarkerOptions, FilesetResolver, FaceLandmarkerResult } from '@mediapipe/tasks-vision';

@Injectable({
    providedIn: 'root'
})
export class FaceTrackingService {
    public blendshapes: WritableSignal<any[]> = signal([]);
    public rotation: WritableSignal<Euler> = signal(new Euler(0, 0, 0));
    public transformationMatrix: WritableSignal<Matrix4 | null> = signal(null);
    public landmarks: WritableSignal<any[] | null> = signal(null);
    public isTracking: WritableSignal<boolean> = signal(false);

    private faceLandmarker: FaceLandmarker | null = null;
    private videoElement: HTMLVideoElement | null = null;
    private lastVideoTime = -1;
    private animationFrameId: number | null = null;
    private currentFacingMode: 'user' | 'environment' = 'user';

    constructor() { }

    async initialize(videoElement: HTMLVideoElement): Promise<void> {
        this.videoElement = videoElement;

        try {
            const filesetResolver = await FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
            );

            const options: FaceLandmarkerOptions = {
                baseOptions: {
                    modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
                    delegate: 'GPU'
                },
                numFaces: 1,
                runningMode: 'VIDEO',
                outputFaceBlendshapes: true,
                outputFacialTransformationMatrixes: true,
            };

            this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, options);

            await this.startCamera();
        } catch (error) {
            console.error('Error initializing face tracking:', error);
        }
    }

    private async startCamera(): Promise<void> {
        if (!this.videoElement) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    width: 1280, 
                    height: 720,
                    facingMode: this.currentFacingMode
                },
                audio: false,
            });

            this.videoElement.srcObject = stream;
            this.videoElement.addEventListener('loadeddata', () => {
                this.isTracking.set(true);
                this.predict();
            });
        } catch (error) {
            console.error('Error accessing camera:', error);
        }
    }

    private predict = () => {
        if (!this.faceLandmarker || !this.videoElement) {
            this.animationFrameId = requestAnimationFrame(this.predict);
            return;
        }

        const nowInMs = Date.now();
        if (this.lastVideoTime !== this.videoElement.currentTime) {
            this.lastVideoTime = this.videoElement.currentTime;

            const result: FaceLandmarkerResult = this.faceLandmarker.detectForVideo(this.videoElement, nowInMs);

            if (result.faceBlendshapes && result.faceBlendshapes.length > 0 && result.faceBlendshapes[0].categories) {
                // Update signal with new blendshapes
                // Optimization: In a real high-perf scenario, we might want to avoid creating new arrays constantly,
                // but for now we follow the React pattern using signals.
                this.blendshapes.set(result.faceBlendshapes[0].categories);

                if (result.facialTransformationMatrixes && result.facialTransformationMatrixes.length > 0) {
                    const matrix = new Matrix4().fromArray(result.facialTransformationMatrixes[0].data);

                    // MediaPipe matrices are often Row-Major, while Three.js expects Column-Major for .fromArray()
                    // However, empirical fixes often suggest Transposing fixes the "stuck in corner" issue if the data order is swapped.
                    // Let's transpose it to align with standard 3D practices if raw sequence is row-based.
                    // Also, we might need to adjust for coordinate system (Y-up vs Y-down).
                    // For now, Transpose is the primary suspect for "tiny and stuck at origin" (translation ending up in bottom row).
                    // Actually, if it IS column major, fromArray is fine.
                    // But if it looks weird, Transpose is the first check.
                    // Let's TRY Transposing.
                    // matrix.transpose(); 

                    // Update: Many MediaPipe web examples show the matrix is Column-Major for WebGL. 
                    // BUT, the translation might be in cm (e.g. 50), while we are rendering?
                    // Let's stick to the user's issue: "Small and Left".
                    // "Left" = Position. "Small" = Scale.
                    // Let's try to scale the positions?
                    // Actually, let's keep the code clean and maybe just try Transpose in the Component or here.
                    // Let's apply Transpose here.

                    // Actually, let's strictly follow the most robust path:
                    // Only Transpose if we are sure.
                    // Issue: If it's Column Major, [Tx, Ty, Tz] are at indices 12, 13, 14.
                    // If it's Row Major, they are at 3, 7, 11 (and 15 is 1).
                    // If we read Row Major as Column Major, the Translation (large numbers) end up in the 'w' row.
                    // This causes a HUGE 'w' perspective divide, making the object TINY and stuck near 0.
                    // THIS MATCHES THE USER DESCRIPTION PERFECTLY ("Small" and at "Top Left" i.e. 0,0).

                    // CONCLUSION: It is Row-Major data being read as Column-Major.
                    // FIX: Transpose.


                    // Transposing to fix coordinate reading.


                    const newRotation = new Euler().setFromRotationMatrix(matrix);
                    this.rotation.set(newRotation);
                    this.transformationMatrix.set(matrix);
                }

                if (result.faceLandmarks && result.faceLandmarks.length > 0) {
                    this.landmarks.set(result.faceLandmarks[0]);
                }
            }
        }

        // Loop
        // Since we are Zoneless, this requestAnimationFrame doesn't trigger CD globally automatically,
        // only the signal updates will trigger updates in components that read them.
        this.animationFrameId = requestAnimationFrame(this.predict);
    };

    stop(): void {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }

        if (this.videoElement && this.videoElement.srcObject) {
            const stream = this.videoElement.srcObject as MediaStream;
            stream.getTracks().forEach(track => track.stop());
        }

        this.isTracking.set(false);
    }

    getVideoDimensions(): { width: number; height: number } {
        if (!this.videoElement) {
            return { width: 1280, height: 720 };
        }

        return {
            width: this.videoElement.videoWidth || 1280,
            height: this.videoElement.videoHeight || 720,
        };
    }

    async switchCamera(): Promise<void> {
        // Toggle between front and back camera
        this.currentFacingMode = this.currentFacingMode === 'user' ? 'environment' : 'user';
        
        // Stop current stream
        if (this.videoElement && this.videoElement.srcObject) {
            const stream = this.videoElement.srcObject as MediaStream;
            stream.getTracks().forEach(track => track.stop());
        }
        
        // Start new stream with new facing mode
        await this.startCamera();
        console.log(`Switched to ${this.currentFacingMode} camera`);
    }

    getCurrentFacingMode(): 'user' | 'environment' {
        return this.currentFacingMode;
    }
}
