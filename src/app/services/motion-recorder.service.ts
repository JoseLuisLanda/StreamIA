import { Injectable, signal, inject, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { FaceTrackingService } from './face-tracking.service';
import {
    MotionFrame, RecordChannelConfig, DEFAULT_CHANNEL_CONFIG,
} from '../lib/motion/motion.models';

@Injectable({ providedIn: 'root' })
export class MotionRecorderService {
    private faceTracking = inject(FaceTrackingService);
    private ngZone = inject(NgZone);

    // ---- public state signals -----------------------------------------------
    readonly isRecording = signal(false);
    readonly elapsed     = signal(0);
    readonly frameCount  = signal(0);
    readonly cameraReady = signal(false);

    /** Emits the completed frame buffer when a recording finishes */
    readonly recordingComplete$ = new Subject<{ frames: MotionFrame[]; duration: number; channels: RecordChannelConfig; rawAudioData?: ArrayBuffer; rawAudioMimeType?: string }>();

    // ---- private state -------------------------------------------------------
    private frames: MotionFrame[] = [];
    private recordStartMs = 0;
    private recordDurationMs = 0;
    private channelConfig: RecordChannelConfig = { ...DEFAULT_CHANNEL_CONFIG };
    private baseline: { morphs: Record<string, number>; headX: number; headY: number; headZ: number } | null = null;
    private rafId: number | null = null;
    private videoEl: HTMLVideoElement | null = null;
    private audioStream: MediaStream | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private audioChunks: Blob[] = [];

    // ---- camera management ---------------------------------------------------

    async enableCamera(videoElement: HTMLVideoElement): Promise<void> {
        this.videoEl = videoElement;
        if (this.faceTracking.isTracking()) {
            // Already running (shared singleton) — just mark ready
            this.ngZone.run(() => this.cameraReady.set(true));
            return;
        }
        try {
            await this.faceTracking.initialize(videoElement);
            this.ngZone.run(() => this.cameraReady.set(true));
        } catch (e) {
            console.error('[motion-recorder] camera init failed:', e);
            throw e; // re-throw so FaceTrackedAvatarComponent can catch it
        }
    }

    disableCamera(): void {
        this.faceTracking.stop();
        this.cameraReady.set(false);
    }

    /** Request mic permission and store the audio stream for later MediaRecorder use. */
    async enableMic(): Promise<boolean> {
        if (this.audioStream) return true; // already open
        try {
            this.audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            return true;
        } catch (e) {
            console.warn('[motion-recorder] mic permission denied:', e);
            return false;
        }
    }

    disableMic(): void {
        if (this.audioStream) {
            this.audioStream.getTracks().forEach(t => t.stop());
            this.audioStream = null;
        }
    }

    // ---- recording -----------------------------------------------------------

    /**
     * Start capturing face-tracking data.
     * @param durationSec Maximum recording duration (default 5 s).
     * @param channels    Which ARKit channel groups to include.
     */
    startRecording(durationSec = 5, channels: RecordChannelConfig = DEFAULT_CHANNEL_CONFIG): void {
        if (this.isRecording()) return;
        this.channelConfig = { ...channels };
        this.frames = [];
        this.baseline = null;
        this.recordDurationMs = durationSec * 1000;
        this.recordStartMs = performance.now();

        this.isRecording.set(true);
        this.elapsed.set(0);
        this.frameCount.set(0);

        // Start voice capture if requested and mic stream is open
        if (channels.voice && this.audioStream) {
            this.audioChunks = [];
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus' : '';
            this.mediaRecorder = new MediaRecorder(
                this.audioStream, mimeType ? { mimeType } : {});
            this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
                if (e.data.size > 0) this.audioChunks.push(e.data);
            };
            this.mediaRecorder.start(100);
        }

        this.ngZone.runOutsideAngular(() => {
            this.rafId = requestAnimationFrame(this.captureLoop);
        });
    }

    /** Stop early (or called automatically at end of duration). Returns the frame count. */
    stopRecording(): number {
        if (!this.isRecording()) return 0;
        const count = this.frames.length;
        this.stopLoop();
        this.stopVoiceAndEmit();
        return count;
    }

    cancel(): void {
        this.stopLoop();
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.frames = [];
        this.baseline = null;
        this.ngZone.run(() => {
            this.isRecording.set(false);
            this.elapsed.set(0);
            this.frameCount.set(0);
        });
    }

    // ---- private helpers ----------------------------------------------------

    private stopLoop(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.ngZone.run(() => this.isRecording.set(false));
    }

    private emitRecording(rawAudioData?: ArrayBuffer, rawAudioMimeType?: string): void {
        const frames = [...this.frames];
        const duration = frames.length > 0 ? frames[frames.length - 1].t : 0;
        this.recordingComplete$.next({ frames, duration, channels: this.channelConfig, rawAudioData, rawAudioMimeType });
    }

    /** Stop MediaRecorder (if active) then emit. Called from stopRecording() and captureLoop end. */
    private stopVoiceAndEmit(): void {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            const mimeType = this.mediaRecorder.mimeType;
            this.mediaRecorder.onstop = async () => {
                const blob = new Blob(this.audioChunks, { type: mimeType });
                const rawAudioData = await blob.arrayBuffer();
                this.emitRecording(rawAudioData, mimeType);
                this.mediaRecorder = null;
            };
            this.mediaRecorder.stop();
        } else {
            this.mediaRecorder = null;
            this.emitRecording(undefined);
        }
    }

    private readonly captureLoop = (): void => {
        const nowMs = performance.now();
        const elapsedMs = nowMs - this.recordStartMs;
        const elapsedSec = elapsedMs / 1000;

        this.elapsed.set(Math.min(elapsedSec, this.recordDurationMs / 1000));
        this.frameCount.set(this.frames.length);

        this.captureFrame(elapsedSec);

        if (elapsedMs >= this.recordDurationMs) {
            this.stopLoop();
            this.stopVoiceAndEmit();
            return;
        }

        this.rafId = requestAnimationFrame(this.captureLoop);
    };

    private captureFrame(elapsedSec: number): void {
        const blendshapes = this.faceTracking.blendshapes();
        const rotation    = this.faceTracking.rotation();

        // Snapshot ALL blendshapes from MediaPipe (keyed by categoryName)
        const rawMorphs: Record<string, number> = {};
        for (const cat of blendshapes) {
            if (cat.categoryName && typeof cat.score === 'number') {
                rawMorphs[cat.categoryName] = cat.score;
            }
        }

        // Establish baseline on the very first captured frame (neutral pose)
        if (!this.baseline) {
            this.baseline = {
                morphs: { ...rawMorphs },
                headX: rotation?.x ?? 0,
                headY: rotation?.y ?? 0,
                headZ: rotation?.z ?? 0,
            };
        }

        // ----------------------------------------------------------------
        // Store delta from baseline for EVERY key that passes channel filter.
        //
        // Key design decisions vs. prior implementation:
        //  1. No per-frame threshold gate — even a 0.001 delta is stored. Subtle
        //     movements (slight squints, micro-brow lifts) were silently dropped
        //     by the old FRAME_STORE_THRESHOLD=0.005, creating flat/choppy signals.
        //  2. Dynamic category matching by prefix/substring is used instead of
        //     hardcoded key lists, so any ARKit key MediaPipe returns is captured
        //     without needing to maintain the lists.
        // ----------------------------------------------------------------
        const deltaMorphs: Record<string, number> = {};
        for (const [key, rawValue] of Object.entries(rawMorphs)) {
            if (!this.isKeyEnabled(key)) continue;
            const delta = rawValue - (this.baseline.morphs[key] ?? 0);
            deltaMorphs[key] = delta; // stored even if near-zero
        }

        const frame: MotionFrame = {
            t: elapsedSec,
            morphs: deltaMorphs,
            headX: this.channelConfig.head ? (rotation?.x ?? 0) - this.baseline.headX : 0,
            headY: this.channelConfig.head ? (rotation?.y ?? 0) - this.baseline.headY : 0,
            headZ: this.channelConfig.head ? (rotation?.z ?? 0) - this.baseline.headZ : 0,
        };

        this.frames.push(frame);
    }

    /**
     * Classify a blendshape key by channel category using prefix/substring matching.
     * This is intentionally broad so any ARKit key MediaPipe returns is captured
     * without maintaining hardcoded lists that can become stale.
     */
    private isKeyEnabled(key: string): boolean {
        const k = key.toLowerCase();
        if (this.channelConfig.brows && k.startsWith('brow')) return true;
        if (this.channelConfig.eyes &&
            (k.startsWith('eye') || k.startsWith('cheek'))) return true;
        if (this.channelConfig.mouth &&
            (k.startsWith('mouth') || k.startsWith('jaw') ||
             k.startsWith('tongue') || k.startsWith('lip') ||
             k.startsWith('nose'))) return true;
        return false;
    }
}
