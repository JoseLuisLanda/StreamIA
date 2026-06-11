/**
 * Data-driven gesture/expression library.
 *
 * SCHEMA
 * ------
 * GestureDef:
 *   id              unique gesture id used in markup: [id]:[seconds]:[speed]
 *   defaultDuration seconds used when markup omits/invalidates duration
 *   defaultSpeed    preset name ('slow'|'normal'|'fast') used when markup omits speed
 *   loopable        if true, the keyframe cycle repeats to fill the requested duration
 *   returnDuration  seconds for smooth return-to-neutral when gesture is cut mid-cycle
 *   entryEasing     easing curve for entry: 'none'|'ease-in-cubic'|'ease-in-out-cubic'
 *   exitEasing      easing curve for exit: 'none'|'ease-out-cubic'|'ease-out-quad'
 *   channels        animation channels, each fully independent:
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
 *   slow:   0.5x  -> motion takes 2x longer, half as many cycles in the window
 *   normal: 1.0x  -> baseline motion speed
 *   fast:   1.5x  -> motion takes 2/3 time, 1.5x cycles in the window
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
    defaultDuration: number;
    defaultSpeed?: SpeedPreset;
    loopable: boolean;
    /** time to smoothly return to neutral when cut mid-cycle (seconds) */
    returnDuration: number;
    /** easing applied when entering the gesture from neutral */
    entryEasing: EasingType;
    /** easing applied when exiting back to neutral */
    exitEasing: EasingType;
    channels: GestureChannel[];
}

export const GESTURE_LIBRARY: GestureDef[] = [
    {
        // head shake: yaw left -> right -> left, loopable for multi-cycle shakes
        id: 'no',
        defaultDuration: 1.6,
        defaultSpeed: 'normal',
        loopable: true, // keeps cycling while duration allows
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
        // head nod: pitch down -> up -> down, loopable for multi-cycle nods
        id: 'yes',
        defaultDuration: 1.4,
        defaultSpeed: 'normal',
        loopable: true, // keeps cycling while duration allows
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
        defaultDuration: 1.5,
        defaultSpeed: 'normal',
        loopable: false,
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
        defaultDuration: 2.0,
        defaultSpeed: 'normal',
        loopable: false,
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
