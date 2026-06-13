import { GestureDef } from '../gestures/gesture-library';
import { VisemeFrame } from '../lipsync/text-to-visemes';

// ---------------------------------------------------------------------------
// ARKit channel sets used by the recorder / compiler
// ---------------------------------------------------------------------------

export const BROW_ARKIT_KEYS: string[] = [
    'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'browDownLeft', 'browDownRight',
];

export const EYE_ARKIT_KEYS: string[] = [
    'eyeBlinkLeft', 'eyeBlinkRight',
    'eyeWideLeft', 'eyeWideRight',
    'eyeSquintLeft', 'eyeSquintRight',
    'eyeLookUpLeft', 'eyeLookUpRight',
    'eyeLookDownLeft', 'eyeLookDownRight',
    'eyeLookInLeft', 'eyeLookInRight',
    'eyeLookOutLeft', 'eyeLookOutRight',
];

// Cheek keys included here so they are captured when eyes are on
export const CHEEK_ARKIT_KEYS: string[] = [
    'cheekSquintLeft', 'cheekSquintRight', 'cheekPuff',
];

// ---------------------------------------------------------------------------
// Core recording types
// ---------------------------------------------------------------------------

/**
 * One sample captured at ~30 fps during a recording session.
 * All values are already baseline-subtracted (frame[0] = neutral = 0).
 */
export interface MotionFrame {
    /** Elapsed seconds from recording start */
    t: number;
    /**
     * ARKit blendshape weights (already delta from baseline).
     * Only channels whose absolute peak value exceeds CHANNEL_ACTIVE_THRESHOLD
     * are stored; zero-motion channels are omitted to save space.
     */
    morphs: Record<string, number>;
    /** Additive head pitch offset from baseline (radians) */
    headX: number;
    /** Additive head yaw offset from baseline (radians) */
    headY: number;
    /** Additive head roll offset from baseline (radians) */
    headZ: number;
}

export type RecordingCategory = 'head' | 'expression' | 'mixed';

/** Which ARKit channel groups the recorder should capture */
export interface RecordChannelConfig {
    brows: boolean;
    eyes: boolean;
    head: boolean;
    /** Off by default — mouth/jaw conflicts with lipsync visemes */
    mouth: boolean;
    /** Capture mic audio during recording for TTS voice conversion. Off by default (requires mic permission). */
    voice: boolean;
}

// Mouth is enabled by default in gesture studio — motion captures are replayed
// as standalone clips, not layered with live TTS. GestureDef.allowMouth controls
// whether a compiled gesture overrides lipsync during playback.
export const DEFAULT_CHANNEL_CONFIG: RecordChannelConfig = {
    brows: true,
    eyes: true,
    head: true,
    mouth: true,
    voice: false,
};

export interface MotionRecording {
    /** UUID v4 */
    id: string;
    /** User-supplied label, e.g. "sigh_v2". Becomes the gesture id with 'custom_' prefix. */
    label: string;
    category: RecordingCategory;
    /** Configured capture duration in seconds */
    duration: number;
    frameCount: number;
    /** Approximate sample rate (frames / duration) */
    fps: number;
    frames: MotionFrame[];
    /**
     * Auto-compiled GestureDef; null until the user accepts compilation.
     * Once set, it is also registered in CustomGestureRegistryService.
     */
    compiledGesture: GestureDef | null;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    /** Optional voice attachment — absent for silent (motion-only) recordings. */
    voiceAttachment?: VoiceAttachment;
}

/**
 * Metadata about a voice recording attached to a MotionRecording.
 * Audio ArrayBuffers (rawAudioData, ttsAudioData) are stored separately
 * in MotionStoreService.audioStore to keep recording-list reads fast.
 */
export interface VoiceAttachment {
    /** User-confirmed spoken transcript. */
    transcript?: string;
    transcriptConfirmed: boolean;
    /** Decoded duration of the re-synthesized TTS audio in seconds. */
    ttsAudioDurationSec?: number;
    /** Pre-computed viseme timeline aligned to ttsAudioData. */
    lipsyncFrames?: VisemeFrame[];
    /** Piper voice ID used for re-synthesis. */
    voiceId?: string;
    /** Provider used — 'piper' | 'azure'. */
    provider?: 'piper' | 'azure';
    /** MIME type of the raw captured audio (e.g. 'audio/webm;codecs=opus'). */
    rawAudioMimeType?: string;
}

/** Audio blobs stored separately in IndexedDB audioStore (keyed by MotionRecording.id). */
export interface AudioEntry {
    /** Same as MotionRecording.id */
    id: string;
    rawAudioData?: ArrayBuffer;
    rawAudioMimeType?: string;
    ttsAudioData?: ArrayBuffer;
}
