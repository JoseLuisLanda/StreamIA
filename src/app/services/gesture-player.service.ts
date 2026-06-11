import { Injectable } from '@angular/core';
import { GESTURE_MAP, GestureDef, sampleChannel, applyEasing, SPEED_MULTIPLIERS, SPEED_MULTIPLIER_MIN, SPEED_MULTIPLIER_MAX, SpeedPreset } from '../lib/gestures/gesture-library';
import { MOUTH_KEYS } from '../lib/lipsync/viseme-map';

/**
 * Gesture playback scheduler with advanced speed control and graceful cutoff.
 *
 * - Receives scheduled gestures (absolute wall-clock start, seconds) or
 *   immediate programmatic triggers via trigger().
 * - sample() is called once per render frame by the avatar component and
 *   returns ADDITIVE offsets: morph weights (brows/eyes) + head rotation.
 * - Mouth/jaw morphs are filtered out, so lipsync visemes are never touched.
 *
 * New features:
 * - Speed multiplier: gesture progress accumulates at speedMultiplier × deltaTime.
 *   This means oscillating gestures (yes, no) cycle faster or slower without
 *   stretching individual keyframes.
 * - Graceful cutoff: when duration expires, the current pose is captured and
 *   smoothly blended back to neutral over returnDuration (configurable per gesture).
 * - Easing on entry and exit: gestures fade in from neutral and fade out to neutral.
 *
 * Overlap policy: non-conflicting channels overlap freely. When two active
 * gestures drive the SAME channel, morphs take the max (avoids >1 weights and
 * double-brow artifacts) and bone rotations sum with a safety clamp. We merge
 * rather than queue because gestures are anchored to word positions in
 * speech — delaying one would desynchronize it from the text that triggered it.
 */

const MOUTH_SET = new Set(MOUTH_KEYS);
const BONE_CLAMP = 0.6; // radians

export interface GestureSample {
    morphs: Record<string, number>;
    /** additive head rotation offsets in radians */
    head: { x: number; y: number; z: number };
}

interface ChannelPose {
    type: 'morph' | 'bone';
    target: string;
    value: number;
}

interface ActiveGesture {
    def: GestureDef;
    /** wall-clock seconds (performance.now()/1000) */
    start: number;
    duration: number;
    speedMultiplier: number; // 0.5 = slow, 1.0 = normal, 1.5 = fast
    /** accumulated phase for this gesture (0..inf for loopable) */
    phase: number;
    /** state: 'playing' | 'exiting' */
    state: 'playing' | 'exiting';
    /** for exiting: pose at cutoff time */
    exitStartPose?: Record<string, ChannelPose>;
    /** for exiting: when the exit started */
    exitStart?: number;
}

export const now = () => performance.now() / 1000;

@Injectable({ providedIn: 'root' })
export class GesturePlayerService {
    private active: ActiveGesture[] = [];
    /** morph keys touched recently — reported as 0 after release so renderers can decay */
    private touchedMorphs = new Set<string>();
    private lastFrameTime = now();

    /** Resolve speed parameter to numeric multiplier */
    private resolveSpeed(speedParam?: 'slow' | 'normal' | 'fast' | number): number {
        if (speedParam === undefined) return 1.0;
        if (typeof speedParam === 'number') {
            return Math.max(SPEED_MULTIPLIER_MIN, Math.min(SPEED_MULTIPLIER_MAX, speedParam));
        }
        return SPEED_MULTIPLIERS[speedParam] ?? 1.0;
    }

    /** Schedule a gesture at an absolute wall-clock time (sec, performance.now()/1000 basis). */
    schedule(id: string, atWallSec: number, duration?: number, speed?: 'slow' | 'normal' | 'fast' | number): boolean {
        const def = GESTURE_MAP.get(id);
        if (!def) {
            console.warn(`[gestures] unknown gesture id "${id}" — skipped`);
            return false;
        }
        const speedMult = this.resolveSpeed(speed);
        this.active.push({
            def,
            start: atWallSec,
            duration: this.resolveDuration(def, duration),
            speedMultiplier: speedMult,
            phase: 0,
            state: 'playing',
        });
        return true;
    }

    /** Programmatic API: play a gesture immediately. */
    trigger(id: string, duration?: number, speed?: 'slow' | 'normal' | 'fast' | number): boolean {
        return this.schedule(id, now(), duration, speed);
    }

    /** Cancel everything (e.g. speech interrupted). Channels ease back via renderer smoothing. */
    clear(): void {
        this.active = [];
    }

    get pendingOrActiveCount(): number {
        return this.active.length;
    }

    /** Per-frame sampling. Returns additive offsets for the current instant. */
    sample(t: number = now()): GestureSample {
        const morphs: Record<string, number> = {};
        const head = { x: 0, y: 0, z: 0 };

        // Update phase based on elapsed time
        const deltaTime = Math.max(0, t - this.lastFrameTime);
        this.lastFrameTime = t;

        // report released morphs as 0 once so smoothing can take them home
        for (const k of this.touchedMorphs) morphs[k] = 0;

        if (this.active.length) {
            const keep: ActiveGesture[] = [];
            for (const g of this.active) {
                // Check if gesture has completely finished (exiting phase complete)
                if (g.state === 'exiting' && g.exitStart !== undefined) {
                    const exitElapsed = t - g.exitStart;
                    if (exitElapsed >= g.def.returnDuration) {
                        continue; // fully finished, remove from active
                    }
                }

                keep.push(g);

                // If in playing state, check if time to transition to exiting
                if (g.state === 'playing') {
                    const playElapsed = t - g.start;
                    if (playElapsed >= g.duration) {
                        // Duration expired: transition to exiting phase
                        g.state = 'exiting';
                        g.exitStart = t;
                        // Capture current pose for smooth blend-out
                        g.exitStartPose = this.captureChannelPose(g);
                        // Continue immediately to sample the exit blend
                    }
                }

                // Sample the gesture (either playing or exiting)
                if (g.state === 'playing' && t >= g.start) {
                    // Accumulate phase based on speed and deltaTime
                    g.phase += this.getPhaseVelocity(g) * deltaTime;

                    // Compute normalized time u (0..1 per cycle) for sampling keyframes
                    const cycleTime = g.phase % g.def.defaultDuration; // 0..defaultDuration
                    const u = cycleTime / g.def.defaultDuration; // 0..1 per cycle

                    // Apply entry easing for the first part of the gesture
                    const playElapsed = t - g.start;
                    const entryProgress = Math.min(1, playElapsed / Math.max(0.1, g.def.returnDuration * 0.5));
                    const entryEasing = applyEasing(entryProgress, g.def.entryEasing);

                    // Sample and apply
                    this.applyGestureSample(g, u, entryEasing, morphs, head);
                } else if (g.state === 'exiting' && g.exitStartPose && g.exitStart !== undefined) {
                    // Blend from captured pose back to neutral
                    const exitElapsed = t - g.exitStart;
                    let exitProgress = exitElapsed / g.def.returnDuration;
                    exitProgress = Math.max(0, Math.min(1, exitProgress));

                    const exitEasing = applyEasing(exitProgress, g.def.exitEasing);

                    // Linear blend: captured value * (1 - exitEasing) + neutral * exitEasing
                    // Since neutral = 0, this simplifies to: value * (1 - exitEasing)
                    for (const channelPose of Object.values(g.exitStartPose)) {
                        const blendedValue = channelPose.value * (1 - exitEasing);

                        if (channelPose.type === 'morph') {
                            if (MOUTH_SET.has(channelPose.target)) continue;
                            this.touchedMorphs.add(channelPose.target);
                            morphs[channelPose.target] = Math.max(morphs[channelPose.target] ?? 0, Math.min(1, blendedValue));
                        } else {
                            const axis = channelPose.target.split('.')[1] as 'x' | 'y' | 'z';
                            if (axis === 'x' || axis === 'y' || axis === 'z') head[axis] += blendedValue;
                        }
                    }
                }
            }
            this.active = keep;
            head.x = clamp(head.x); head.y = clamp(head.y); head.z = clamp(head.z);
        }

        // drop fully-released morphs from the touched set once they've been reported as 0
        if (this.active.length === 0 && this.touchedMorphs.size) {
            this.touchedMorphs.clear();
            // (renderer smoothing handles the final decay to neutral)
        }

        return { morphs, head };
    }

    /** Get phase velocity (how fast phase accumulates per second) */
    private getPhaseVelocity(g: ActiveGesture): number {
        // Normal cycle time is g.def.defaultDuration
        // At speed 1.0, we should complete one cycle in defaultDuration seconds
        // phase velocity = 1 cycle / defaultDuration seconds = speedMultiplier / defaultDuration
        return g.speedMultiplier / g.def.defaultDuration;
    }

    /** Capture the current pose of all channels in a gesture for smooth exit blending */
    private captureChannelPose(g: ActiveGesture): Record<string, ChannelPose> {
        const pose: Record<string, ChannelPose> = {};
        const cycleTime = g.phase % g.def.defaultDuration;
        const u = cycleTime / g.def.defaultDuration;

        for (const ch of g.def.channels) {
            const v = sampleChannel(ch, u);
            const key = `${ch.type}:${ch.target}`;
            pose[key] = { type: ch.type, target: ch.target, value: v };
        }
        return pose;
    }

    /** Apply gesture sample to morphs and head offset */
    private applyGestureSample(g: ActiveGesture, u: number, entryEasing: number, morphs: Record<string, number>, head: { x: number; y: number; z: number }): void {
        for (const ch of g.def.channels) {
            let v = sampleChannel(ch, u);
            // Apply entry easing
            v *= entryEasing;

            if (ch.type === 'morph') {
                if (MOUTH_SET.has(ch.target)) continue; // never touch lipsync channels
                this.touchedMorphs.add(ch.target);
                morphs[ch.target] = Math.max(morphs[ch.target] ?? 0, Math.min(1, v));
            } else {
                const axis = ch.target.split('.')[1] as 'x' | 'y' | 'z';
                if (axis === 'x' || axis === 'y' || axis === 'z') head[axis] += v;
            }
        }
    }

    private resolveDuration(def: GestureDef, requested?: number): number {
        if (requested !== undefined && Number.isFinite(requested) && requested > 0 && requested <= 60) {
            return requested;
        }
        return def.defaultDuration;
    }
}

function clamp(v: number): number {
    return Math.max(-BONE_CLAMP, Math.min(BONE_CLAMP, v));
}
