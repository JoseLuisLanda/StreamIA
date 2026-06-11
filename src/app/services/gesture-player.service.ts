import { Injectable } from '@angular/core';
import { GESTURE_MAP, GestureDef, sampleChannel, applyEasing, SPEED_MULTIPLIERS, SPEED_MULTIPLIER_MIN, SPEED_MULTIPLIER_MAX, CYCLE_BASE_SECONDS } from '../lib/gestures/gesture-library';
import { MOUTH_KEYS } from '../lib/lipsync/viseme-map';

/**
 * Gesture playback scheduler — repetition-based, single-slot.
 *
 * - Receives gestures scheduled at an absolute wall-clock start, or immediate
 *   programmatic triggers via trigger().
 * - sample() is called once per render frame by the avatar component and returns
 *   ADDITIVE offsets: morph weights (brows/eyes) + head rotation. Mouth/jaw morphs
 *   are filtered out so lipsync visemes are owned exclusively by the audio timeline.
 *   The only exception is an expression gesture flagged `allowMouth`, and only while
 *   the scheduler was told no viseme audio is active (expression clips).
 *
 * Timing model:
 * - repetitions = number of full keyframe cycles to play (phase 0 -> 1 per cycle).
 * - speedMultiplier scales how fast phase advances; total play time is
 *   repetitions * CYCLE_BASE_SECONDS / speedMultiplier seconds.
 * - A gesture is NEVER cut by a time cap: it always completes its N cycles and ends
 *   at neutral (keyframes start/end at 0), then runs a short exit blend.
 *
 * Overlap policy (single slot): only ONE gesture is active at a time. Starting a new
 * gesture immediately cancels the current one — the cancelled gesture stops advancing
 * and its residual pose blends to neutral over returnDuration (no snapping) while the
 * new gesture enters. Pending future instances are dropped. There is no parallel merge.
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

interface ScheduledGesture {
    def: GestureDef;
    /** wall-clock seconds (performance.now()/1000) when it should become active */
    start: number;
    repetitions: number;
    speedMultiplier: number;
    allowMouthNow: boolean;
}

interface ActiveGesture {
    def: GestureDef;
    /** wall-clock seconds when it became active */
    start: number;
    repetitions: number;
    speedMultiplier: number; // 0.5 = slow, 1.0 = normal, 1.5 = fast
    /** accumulated phase in cycles (0..repetitions) */
    phase: number;
    allowMouthNow: boolean;
}

interface ExitingGesture {
    def: GestureDef;
    /** residual pose captured at the moment of cancel/completion */
    pose: Record<string, ChannelPose>;
    /** wall-clock seconds when the exit blend started */
    exitStart: number;
    allowMouthNow: boolean;
}

export const now = () => performance.now() / 1000;

@Injectable({ providedIn: 'root' })
export class GesturePlayerService {
    private scheduled: ScheduledGesture[] = [];
    private current: ActiveGesture | null = null;
    private exiting: ExitingGesture | null = null;
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

    /**
     * Schedule a gesture at an absolute wall-clock time (sec, performance.now()/1000 basis).
     * @param repetitions integer cycle count; undefined -> gesture's defaultRepetitions.
     * @param allowMouthNow only honoured for gestures flagged allowMouth (expression clips).
     */
    schedule(id: string, atWallSec: number, repetitions?: number, speed?: 'slow' | 'normal' | 'fast' | number, allowMouthNow = false): boolean {
        const def = GESTURE_MAP.get(id);
        if (!def) {
            console.warn(`[gestures] unknown gesture id "${id}" — skipped`);
            return false;
        }
        this.scheduled.push({
            def,
            start: atWallSec,
            repetitions: this.resolveRepetitions(def, repetitions),
            speedMultiplier: this.resolveSpeed(speed),
            allowMouthNow: allowMouthNow && def.allowMouth === true,
        });
        // keep schedule ordered by start time for deterministic promotion
        this.scheduled.sort((a, b) => a.start - b.start);
        return true;
    }

    /** Programmatic API: play a gesture immediately (repetitions cycles). */
    trigger(id: string, repetitions?: number, speed?: 'slow' | 'normal' | 'fast' | number): boolean {
        return this.schedule(id, now(), repetitions, speed);
    }

    /** Cancel everything (e.g. speech interrupted). Channels ease back via renderer smoothing. */
    clear(): void {
        this.scheduled = [];
        this.current = null;
        this.exiting = null;
    }

    get pendingOrActiveCount(): number {
        return this.scheduled.length + (this.current ? 1 : 0) + (this.exiting ? 1 : 0);
    }

    /** Currently playing gesture id, or null (testing/diagnostics). */
    get activeGestureId(): string | null {
        return this.current?.def.id ?? null;
    }

    /** Whether a cancelled/finished gesture is still blending back to neutral. */
    get isExiting(): boolean {
        return this.exiting !== null;
    }

    /** Per-frame sampling. Returns additive offsets for the current instant. */
    sample(t: number = now()): GestureSample {
        const morphs: Record<string, number> = {};
        const head = { x: 0, y: 0, z: 0 };

        const deltaTime = Math.max(0, t - this.lastFrameTime);
        this.lastFrameTime = t;

        // report released morphs as 0 once so smoothing can take them home
        for (const k of this.touchedMorphs) morphs[k] = 0;

        // 1) Promote any scheduled gesture whose start has arrived (latest wins, cancels current).
        this.promoteScheduled(t);

        // 2) Advance the active gesture; once all cycles are done, move it to the exit blend.
        if (this.current && t >= this.current.start) {
            const g = this.current;
            g.phase += this.phaseVelocity(g) * deltaTime;
            if (g.phase >= g.repetitions) {
                // completed all cycles — keyframes end at neutral, so exit from rest
                g.phase = g.repetitions;
                this.beginExit(g, t);
                this.current = null;
            } else {
                const u = g.phase % 1; // 0..1 within the current cycle
                const entryProgress = Math.min(1, (t - g.start) / Math.max(0.1, g.def.returnDuration * 0.5));
                const entryEasing = applyEasing(entryProgress, g.def.entryEasing);
                this.applyGestureSample(g, u, entryEasing, morphs, head);
            }
        }

        // 3) Blend any exiting (cancelled or completed) gesture back to neutral.
        if (this.exiting) {
            const ex = this.exiting;
            const exitElapsed = t - ex.exitStart;
            if (exitElapsed >= ex.def.returnDuration) {
                this.exiting = null;
            } else {
                const exitEasing = applyEasing(exitElapsed / ex.def.returnDuration, ex.def.exitEasing);
                for (const pose of Object.values(ex.pose)) {
                    const blended = pose.value * (1 - exitEasing); // neutral = 0
                    if (pose.type === 'morph') {
                        if (this.shouldFilterMouth(ex.allowMouthNow, pose.target)) continue;
                        this.touchedMorphs.add(pose.target);
                        morphs[pose.target] = Math.max(morphs[pose.target] ?? 0, Math.min(1, blended));
                    } else {
                        const axis = pose.target.split('.')[1] as 'x' | 'y' | 'z';
                        if (axis === 'x' || axis === 'y' || axis === 'z') head[axis] += blended;
                    }
                }
            }
        }

        head.x = clamp(head.x); head.y = clamp(head.y); head.z = clamp(head.z);

        // drop fully-released morphs from the touched set once neutral & idle
        if (!this.current && !this.exiting && this.touchedMorphs.size) {
            this.touchedMorphs.clear();
        }

        return { morphs, head };
    }

    /** Promote the latest scheduled gesture whose start has passed; cancel the current one. */
    private promoteScheduled(t: number): void {
        if (!this.scheduled.length) return;
        let promote: ScheduledGesture | null = null;
        const remaining: ScheduledGesture[] = [];
        for (const s of this.scheduled) {
            if (s.start <= t) promote = s; // latest due wins; earlier due items are superseded
            else remaining.push(s);
        }
        if (!promote) return;
        this.scheduled = remaining;

        // cancel the currently playing gesture: stop advancing, blend residual -> neutral
        if (this.current) this.beginExit(this.current, t);

        this.current = {
            def: promote.def,
            start: promote.start,
            repetitions: promote.repetitions,
            speedMultiplier: promote.speedMultiplier,
            phase: 0,
            allowMouthNow: promote.allowMouthNow,
        };
    }

    /** Capture an active gesture's current pose and move it into the exit blend slot. */
    private beginExit(g: ActiveGesture, t: number): void {
        this.exiting = {
            def: g.def,
            pose: this.capturePose(g),
            exitStart: t,
            allowMouthNow: g.allowMouthNow,
        };
    }

    /** cycles per second for this gesture at its speed */
    private phaseVelocity(g: ActiveGesture): number {
        return g.speedMultiplier / CYCLE_BASE_SECONDS;
    }

    /** Capture the current pose of all channels for a smooth exit blend. */
    private capturePose(g: ActiveGesture): Record<string, ChannelPose> {
        const pose: Record<string, ChannelPose> = {};
        const u = g.phase % 1;
        for (const ch of g.def.channels) {
            pose[`${ch.type}:${ch.target}`] = { type: ch.type, target: ch.target, value: sampleChannel(ch, u) };
        }
        return pose;
    }

    /** Apply a gesture sample to morphs and head offset (additive, mouth-filtered). */
    private applyGestureSample(g: ActiveGesture, u: number, entryEasing: number, morphs: Record<string, number>, head: { x: number; y: number; z: number }): void {
        for (const ch of g.def.channels) {
            const v = sampleChannel(ch, u) * entryEasing;
            if (ch.type === 'morph') {
                if (this.shouldFilterMouth(g.allowMouthNow, ch.target)) continue;
                this.touchedMorphs.add(ch.target);
                morphs[ch.target] = Math.max(morphs[ch.target] ?? 0, Math.min(1, v));
            } else {
                const axis = ch.target.split('.')[1] as 'x' | 'y' | 'z';
                if (axis === 'x' || axis === 'y' || axis === 'z') head[axis] += v;
            }
        }
    }

    private resolveRepetitions(def: GestureDef, requested?: number): number {
        if (requested !== undefined && Number.isFinite(requested) && requested >= 1) {
            return Math.floor(requested);
        }
        return def.defaultRepetitions;
    }

    /** Mouth/jaw morphs are owned by lipsync; only expression clips (allowMouthNow) may keep them. */
    private shouldFilterMouth(allowMouthNow: boolean, target: string): boolean {
        return MOUTH_SET.has(target) && !allowMouthNow;
    }
}

function clamp(v: number): number {
    return Math.max(-BONE_CLAMP, Math.min(BONE_CLAMP, v));
}
