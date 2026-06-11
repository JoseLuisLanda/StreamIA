/**
 * Viseme → ARKit blendshape mapping for Ready Player Me avatars
 * (loaded with ?morphTargets=ARKit).
 *
 * Internal viseme set is Oculus-style: 15 mouth poses.
 * Weights are calibrated (0.1–0.9) to avoid exaggerated motion.
 */

export type Viseme =
    | 'sil' | 'PP' | 'FF' | 'TH' | 'DD' | 'kk' | 'CH' | 'SS'
    | 'nn' | 'RR' | 'aa' | 'E' | 'I' | 'O' | 'U';

export type BlendWeights = Record<string, number>;

export const VISEME_TO_ARKIT: Record<Viseme, BlendWeights> = {
    sil: {},
    // p, b, m — lips pressed together
    PP: { mouthClose: 0.7, mouthPressLeft: 0.5, mouthPressRight: 0.5, jawOpen: 0.08 },
    // f, v — lower lip to upper teeth
    FF: { mouthRollLower: 0.6, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2, jawOpen: 0.1 },
    // soft th / d (dental approximant)
    TH: { jawOpen: 0.15, tongueOut: 0.35, mouthStretchLeft: 0.2, mouthStretchRight: 0.2 },
    // d, t — tongue to alveolar ridge
    DD: { jawOpen: 0.16, mouthStretchLeft: 0.25, mouthStretchRight: 0.25, mouthPressLeft: 0.15, mouthPressRight: 0.15 },
    // k, g, j (Spanish jota)
    kk: { jawOpen: 0.2, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
    // ch, sh, ll/y
    CH: { jawOpen: 0.15, mouthFunnel: 0.4, mouthPucker: 0.3 },
    // s, z, ce/ci
    SS: { jawOpen: 0.1, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, mouthSmileLeft: 0.15, mouthSmileRight: 0.15 },
    // n, ñ, l
    nn: { jawOpen: 0.15, mouthPressLeft: 0.15, mouthPressRight: 0.15 },
    // r, rr
    RR: { jawOpen: 0.18, mouthStretchLeft: 0.2, mouthStretchRight: 0.2, mouthPucker: 0.1 },
    // open vowel a
    aa: { jawOpen: 0.55, mouthLowerDownLeft: 0.25, mouthLowerDownRight: 0.25 },
    // e
    E: { jawOpen: 0.3, mouthStretchLeft: 0.35, mouthStretchRight: 0.35, mouthSmileLeft: 0.2, mouthSmileRight: 0.2 },
    // i
    I: { jawOpen: 0.12, mouthSmileLeft: 0.45, mouthSmileRight: 0.45, mouthStretchLeft: 0.25, mouthStretchRight: 0.25 },
    // o
    O: { jawOpen: 0.35, mouthFunnel: 0.55, mouthPucker: 0.25 },
    // u
    U: { jawOpen: 0.12, mouthPucker: 0.65, mouthFunnel: 0.35 },
};

/** Every ARKit key the lipsync touches — used to decay back to neutral. */
export const MOUTH_KEYS: string[] = Array.from(
    new Set(Object.values(VISEME_TO_ARKIT).flatMap(w => Object.keys(w)))
);
