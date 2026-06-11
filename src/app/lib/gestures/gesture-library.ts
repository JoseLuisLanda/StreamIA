/**
 * Data-driven gesture/expression library.
 *
 * SCHEMA
 * ------
 * GestureDef:
 *   id                unique gesture id used in markup: [id]:[repetitions]:[speed]
 *   defaultRepetitions integer cycle count used when markup omits/invalidates repetitions
 *   defaultSpeed      preset name ('slow'|'normal'|'fast') used when markup omits speed
 *   returnDuration    seconds for the smooth return-to-neutral exit blend (also used when a
 *                     new gesture cancels this one mid-cycle)
 *   entryEasing       easing curve for entry: 'none'|'ease-in-cubic'|'ease-in-out-cubic'
 *   exitEasing        easing curve for exit: 'none'|'ease-out-cubic'|'ease-out-quad'
 *   allowMouth        optional, explicit escape hatch for non-speech expression clips
 *   channels          animation channels, each fully independent:
 *     type 'morph'  -> target is an ARKit blendshape name (brows/eyes only;
 *                      mouth/jaw channels are rejected at runtime so gestures
 *                      can NEVER overwrite lipsync visemes)
 *     type 'bone'   -> target is 'head.x' | 'head.y' | 'head.z'
 *                      (additive rotation offset in radians: x=pitch/nod,
 *                       y=yaw/shake, z=roll/tilt)
 *   keyframes       { t, v } pairs; t is NORMALIZED time 0..1 (scaled to the
 *                   actual duration at playback), v is morph weight (0..1)
 *                   or radians for bones. Interpolation between keyframes is
 *                   smoothstep -> built-in ease-in/ease-out, no snapping.
 *                   First and last v should be 0 to return to neutral.
 *
 * Speed multipliers (global config, tunable per project):
 *   slow:   0.5x  -> each cycle takes 2x longer
 *   normal: 1.0x  -> baseline cycle speed
 *   fast:   1.5x  -> each cycle takes 2/3 the time
 *
 * One repetition = one full pass through the keyframe curve (phase 0 -> 1). A gesture plays
 * exactly `repetitions` full cycles, then settles at neutral (keyframes start/end at 0). Speed
 * only changes how fast each cycle plays, so total play time = repetitions / speed cycles.
 *
 * Adding a new gesture = adding one entry to GESTURE_LIBRARY. No code changes.
 */

export type GestureChannelType = 'morph' | 'bone';
export type EasingType = 'none' | 'ease-in-cubic' | 'ease-in-out-cubic' | 'ease-out-cubic' | 'ease-out-quad';
export type SpeedPreset = 'slow' | 'normal' | 'fast';
export type SpeedParam = SpeedPreset | number | undefined;

// Global speed multiplier configuration (tunable per project)
export const SPEED_MULTIPLIERS: Record<SpeedPreset, number> = {
    slow: 0.5,
    normal: 1.0,
    fast: 1.5,
};

// Numeric range for raw speed multipliers
export const SPEED_MULTIPLIER_MIN = 0.1;
export const SPEED_MULTIPLIER_MAX = 3.0;

/**
 * Wall-clock seconds for one full cycle at speed 1.0. Total gesture time is
 * repetitions * CYCLE_BASE_SECONDS / speedMultiplier. Tunable per project.
 */
export const CYCLE_BASE_SECONDS = 1.0;

export interface GestureKeyframe {
    /** normalized time 0..1 */
    t: number;
    /** morph weight 0..1, or radians for bone channels */
    v: number;
}

export interface GestureChannel {
    type: GestureChannelType;
    /** morph: ARKit blendshape name. bone: 'head.x' | 'head.y' | 'head.z' */
    target: string;
    keyframes: GestureKeyframe[];
}

export interface GestureDef {
    id: string;
    /** integer cycle count used when markup omits/invalidates the repetition param */
    defaultRepetitions: number;
    defaultSpeed?: SpeedPreset;
    /** seconds for the smooth return-to-neutral exit blend (also used on cancel) */
    returnDuration: number;
    /** easing applied when entering the gesture from neutral */
    entryEasing: EasingType;
    /** easing applied when exiting back to neutral */
    exitEasing: EasingType;
    /** permit mouth/jaw morph channels when the scheduler marks the gesture as non-speech */
    allowMouth?: boolean;
    channels: GestureChannel[];
}

export const GESTURE_LIBRARY: GestureDef[] = [
    {
        // head shake: yaw left -> right -> left, one full cycle per repetition
        id: 'no',
        defaultRepetitions: 1,
        defaultSpeed: 'normal',
        returnDuration: 0.3,
        entryEasing: 'ease-in-cubic',
        exitEasing: 'ease-out-cubic',
        channels: [
            {
                type: 'bone', target: 'head.y',
                keyframes: [
                    { t: 0.0, v: 0 }, { t: 0.15, v: 0.32 }, { t: 0.4, v: -0.32 },
                    { t: 0.65, v: 0.2 }, { t: 0.85, v: -0.1 }, { t: 1.0, v: 0 },
                ],
            },
        ],
    },
    {
        // head nod: pitch down -> up -> down, one full cycle per repetition
        id: 'yes',
        defaultRepetitions: 1,
        defaultSpeed: 'normal',
        returnDuration: 0.3,
        entryEasing: 'ease-in-cubic',
        exitEasing: 'ease-out-cubic',
        channels: [
            {
                type: 'bone', target: 'head.x',
                keyframes: [
                    { t: 0.0, v: 0 }, { t: 0.2, v: 0.22 }, { t: 0.45, v: -0.08 },
                    { t: 0.7, v: 0.14 }, { t: 1.0, v: 0 },
                ],
            },
        ],
    },
    {
        // raise both eyebrows + widen eyes, hold, release (one-shot)
        id: 'surprise',
        defaultRepetitions: 1,
        defaultSpeed: 'slow',
        returnDuration: 0.4,
        entryEasing: 'ease-in-out-cubic',
        exitEasing: 'ease-out-quad',
        channels: [
            { type: 'morph', target: 'browInnerUp', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.95 }, { t: 0.7, v: 0.95 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'browOuterUpLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.8 }, { t: 0.7, v: 0.8 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'browOuterUpRight', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.8 }, { t: 0.7, v: 0.8 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'eyeWideLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.6 }, { t: 0.7, v: 0.6 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'eyeWideRight', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.6 }, { t: 0.7, v: 0.6 }, { t: 1, v: 0 }] },
        ],
    },
    {
        // eyes roll upward + slight head tilt, hold, return (one-shot)
        id: 'thinking',
        defaultRepetitions: 1,
        defaultSpeed: 'slow',
        returnDuration: 0.4,
        entryEasing: 'ease-in-out-cubic',
        exitEasing: 'ease-out-quad',
        channels: [
            { type: 'morph', target: 'eyeLookUpLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.2, v: 0.85 }, { t: 0.8, v: 0.85 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'eyeLookUpRight', keyframes: [{ t: 0, v: 0 }, { t: 0.2, v: 0.85 }, { t: 0.8, v: 0.85 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'browInnerUp', keyframes: [{ t: 0, v: 0 }, { t: 0.25, v: 0.4 }, { t: 0.8, v: 0.4 }, { t: 1, v: 0 }] },
            { type: 'bone', target: 'head.z', keyframes: [{ t: 0, v: 0 }, { t: 0.25, v: 0.1 }, { t: 0.8, v: 0.1 }, { t: 1, v: 0 }] },
            { type: 'bone', target: 'head.x', keyframes: [{ t: 0, v: 0 }, { t: 0.25, v: -0.08 }, { t: 0.8, v: -0.08 }, { t: 1, v: 0 }] },
        ],
    },
    {
        // non-verbal sigh: head floats back, drops gently, eyes close, brows relax
        id: 'sigh',
        defaultRepetitions: 1,
        defaultSpeed: 'slow',
        returnDuration: 0.35,
        entryEasing: 'ease-in-out-cubic',
        exitEasing: 'ease-out-quad',
        channels: [
            { type: 'bone', target: 'head.x', keyframes: [{ t: 0, v: 0 }, { t: 0.25, v: -0.12 }, { t: 0.72, v: 0.16 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'eyeBlinkLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.22, v: 0.75 }, { t: 0.62, v: 0.75 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'eyeBlinkRight', keyframes: [{ t: 0, v: 0 }, { t: 0.22, v: 0.75 }, { t: 0.62, v: 0.75 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'browDownLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.28, v: 0.22 }, { t: 0.7, v: 0.22 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'browDownRight', keyframes: [{ t: 0, v: 0 }, { t: 0.28, v: 0.22 }, { t: 0.7, v: 0.22 }, { t: 1, v: 0 }] },
        ],
    },
    {
        // non-verbal laugh clip: head bounces, cheeks/eyes squint, smile and jaw pulse
        id: 'laugh',
        defaultRepetitions: 1,
        defaultSpeed: 'normal',
        returnDuration: 0.28,
        entryEasing: 'ease-in-out-cubic',
        exitEasing: 'ease-out-quad',
        allowMouth: true,
        channels: [
            { type: 'bone', target: 'head.x', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.08 }, { t: 0.34, v: -0.06 }, { t: 0.52, v: 0.08 }, { t: 0.68, v: -0.05 }, { t: 0.84, v: 0.05 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'cheekSquintLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.16, v: 0.55 }, { t: 0.45, v: 0.28 }, { t: 0.66, v: 0.6 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'cheekSquintRight', keyframes: [{ t: 0, v: 0 }, { t: 0.16, v: 0.55 }, { t: 0.45, v: 0.28 }, { t: 0.66, v: 0.6 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'eyeSquintLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.5 }, { t: 0.48, v: 0.2 }, { t: 0.7, v: 0.45 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'eyeSquintRight', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.5 }, { t: 0.48, v: 0.2 }, { t: 0.7, v: 0.45 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'mouthSmileLeft', keyframes: [{ t: 0, v: 0 }, { t: 0.14, v: 0.75 }, { t: 0.5, v: 0.55 }, { t: 0.72, v: 0.8 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'mouthSmileRight', keyframes: [{ t: 0, v: 0 }, { t: 0.14, v: 0.75 }, { t: 0.5, v: 0.55 }, { t: 0.72, v: 0.8 }, { t: 1, v: 0 }] },
            { type: 'morph', target: 'jawOpen', keyframes: [{ t: 0, v: 0 }, { t: 0.18, v: 0.32 }, { t: 0.38, v: 0.12 }, { t: 0.58, v: 0.36 }, { t: 0.78, v: 0.14 }, { t: 1, v: 0 }] },
        ],
    },
];

export const GESTURE_MAP: Map<string, GestureDef> = new Map(GESTURE_LIBRARY.map(g => [g.id, g]));

/** Easing functions for smooth animation entry/exit */
function easeInCubic(t: number): number {
    return t * t * t;
}

function easeOutCubic(t: number): number {
    return 1 - (1 - t) ** 3;
}

function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function easeOutQuad(t: number): number {
    return 1 - (1 - t) * (1 - t);
}

/** Apply easing function based on type */
export function applyEasing(t: number, easing: EasingType): number {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    switch (easing) {
        case 'ease-in-cubic':
            return easeInCubic(t);
        case 'ease-out-cubic':
            return easeOutCubic(t);
        case 'ease-in-out-cubic':
            return easeInOutCubic(t);
        case 'ease-out-quad':
            return easeOutQuad(t);
        case 'none':
        default:
            return t;
    }
}

/** Sample one channel at normalized time u (0..1) with smoothstep easing between keyframes. */
export function sampleChannel(channel: GestureChannel, u: number): number {
    const kf = channel.keyframes;
    if (kf.length === 0) return 0;
    if (u <= kf[0].t) return kf[0].v;
    if (u >= kf[kf.length - 1].t) return kf[kf.length - 1].v;
    for (let i = 0; i < kf.length - 1; i++) {
        const a = kf[i], b = kf[i + 1];
        if (u >= a.t && u <= b.t) {
            const span = b.t - a.t || 1e-6;
            let p = (u - a.t) / span;
            p = p * p * (3 - 2 * p); // smoothstep ease in/out
            return a.v + (b.v - a.v) * p;
        }
    }
    return 0;
}
