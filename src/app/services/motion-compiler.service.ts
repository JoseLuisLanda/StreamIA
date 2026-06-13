import { Injectable } from '@angular/core';
import {
    GestureDef, GestureChannel, GestureKeyframe,
    EasingType,
} from '../lib/gestures/gesture-library';
import { MotionFrame, RecordingCategory } from '../lib/motion/motion.models';
import { decimateChannel, RdpPoint } from '../lib/motion/rdp-decimator';

/**
 * Minimum peak-absolute-value for a channel to be included in the compiled gesture.
 * Lowered from 0.04 → 0.015 so subtle channels (slight squints, micro-brow lifts,
 * small head tilts) are preserved. RDP decimation still removes redundant keyframes,
 * so the gesture file stays compact.
 */
const CHANNEL_ACTIVE_THRESHOLD = 0.015;

/** Maximum bone rotation per axis included (matches GesturePlayerService BONE_CLAMP) */
const BONE_CLAMP = 0.6;

export interface CompilerOptions {
    /** RDP simplification epsilon. Smaller = more keyframes. Default 0.015 */
    rdpEpsilon?: number;
    /** Override active threshold (default 0.04) */
    activeThreshold?: number;
    /** Allow mouth/jaw morph channels (expression clips only). Default false */
    allowMouth?: boolean;
    /** Override detected easing */
    forcedEasing?: { entryEasing: EasingType; exitEasing: EasingType };
}

@Injectable({ providedIn: 'root' })
export class MotionCompilerService {

    /**
     * Convert a raw MotionFrame[] into a GestureDef compatible with GesturePlayerService.
     * @param frames  Frames from MotionRecorderService (already baseline-subtracted).
     * @param id      Gesture id (will be prefixed with 'custom_' if not already).
     * @param opts    Compiler tuning options.
     */
    compile(frames: MotionFrame[], id: string, opts: CompilerOptions = {}): GestureDef {
        const epsilon = opts.rdpEpsilon ?? 0.015;
        const threshold = opts.activeThreshold ?? CHANNEL_ACTIVE_THRESHOLD;
        const allowMouth = opts.allowMouth ?? false;
        const gestureId = id.startsWith('custom_') ? id : `custom_${id}`;

        if (frames.length < 2) {
            return this.emptyGesture(gestureId);
        }

        const totalDuration = frames[frames.length - 1].t || 1;
        const channels: GestureChannel[] = [];

        // ---- morph channels ---------------------------------------------------
        const morphKeys = this.collectMorphKeys(frames, allowMouth);
        for (const key of morphKeys) {
            const rawPoints = this.extractMorphPoints(frames, key, totalDuration);
            const peak = rawPoints.reduce((m, p) => Math.max(m, Math.abs(p.v)), 0);
            if (peak < threshold) continue;

            const decimated = decimateChannel(rawPoints, epsilon);
            channels.push({
                type: 'morph',
                target: key,
                keyframes: this.clampMorphKeyframes(decimated),
            });
        }

        // ---- bone channels ---------------------------------------------------
        const boneAxes: Array<{ axis: 'x' | 'y' | 'z'; key: 'headX' | 'headY' | 'headZ' }> = [
            { axis: 'x', key: 'headX' },
            { axis: 'y', key: 'headY' },
            { axis: 'z', key: 'headZ' },
        ];

        for (const { axis, key } of boneAxes) {
            const rawPoints = this.extractBonePoints(frames, key, totalDuration);
            const peak = rawPoints.reduce((m, p) => Math.max(m, Math.abs(p.v)), 0);
            if (peak < threshold) continue;

            const decimated = decimateChannel(rawPoints, epsilon);
            channels.push({
                type: 'bone',
                target: `head.${axis}`,
                keyframes: this.clampBoneKeyframes(decimated),
            });
        }

        // ---- infer easing and timing -----------------------------------------
        const { entryEasing, exitEasing } = opts.forcedEasing
            ?? this.detectEasing(frames);

        const returnDuration = Math.max(0.25, totalDuration * 0.12);
        const category = this.detectCategory(channels);

        const def: GestureDef = {
            id: gestureId,
            defaultRepetitions: 1,
            defaultSpeed: 'normal',
            returnDuration,
            entryEasing,
            exitEasing,
            allowMouth: allowMouth || undefined,
            // Encode the actual recording length so GesturePlayerService plays at correct speed.
            // Without this, phaseVelocity falls back to CYCLE_BASE_SECONDS (1 s/cycle) and
            // a 3 s recording would play 3× too fast.
            cycleDurationSec: totalDuration,
            channels,
        };

        return def;
    }

    /** Detect overall motion category for the recording */
    detectCategory(channels: GestureChannel[]): RecordingCategory {
        const hasBone = channels.some(c => c.type === 'bone');
        const hasMorph = channels.some(c => c.type === 'morph');
        if (hasBone && hasMorph) return 'mixed';
        if (hasBone) return 'head';
        return 'expression';
    }

    // ---- private helpers ----------------------------------------------------

    private emptyGesture(id: string): GestureDef {
        return {
            id,
            defaultRepetitions: 1,
            defaultSpeed: 'normal',
            returnDuration: 0.3,
            entryEasing: 'ease-in-out-cubic',
            exitEasing: 'ease-out-quad',
            channels: [],
        };
    }

    private collectMorphKeys(frames: MotionFrame[], allowMouth: boolean): string[] {
        const keys = new Set<string>();
        for (const f of frames) {
            for (const k of Object.keys(f.morphs)) {
                if (!allowMouth && this.isMouthKey(k)) continue;
                keys.add(k);
            }
        }
        return Array.from(keys);
    }

    private isMouthKey(key: string): boolean {
        // Mouth/jaw keys contain 'mouth', 'jaw', 'tongue', 'lips' (lowercase check)
        const k = key.toLowerCase();
        return k.includes('mouth') || k.includes('jaw') || k.includes('tongue') || k.includes('lip');
    }

    private extractMorphPoints(frames: MotionFrame[], key: string, totalDuration: number): RdpPoint[] {
        return frames.map(f => ({
            t: f.t / totalDuration,
            v: Math.max(-1, Math.min(1, f.morphs[key] ?? 0)),
        }));
    }

    private extractBonePoints(frames: MotionFrame[], key: 'headX' | 'headY' | 'headZ', totalDuration: number): RdpPoint[] {
        return frames.map(f => ({
            t: f.t / totalDuration,
            v: Math.max(-BONE_CLAMP, Math.min(BONE_CLAMP, f[key])),
        }));
    }

    private clampMorphKeyframes(points: RdpPoint[]): GestureKeyframe[] {
        return points.map(p => ({ t: p.t, v: Math.max(0, Math.min(1, p.v)) }));
    }

    private clampBoneKeyframes(points: RdpPoint[]): GestureKeyframe[] {
        return points.map(p => ({ t: p.t, v: Math.max(-BONE_CLAMP, Math.min(BONE_CLAMP, p.v)) }));
    }

    /**
     * Heuristic easing detection: look at the slope of the first 15% and last 15% of the recording.
     * Fast entry slope → ease-in; slow entry slope → ease-in-out.
     */
    private detectEasing(frames: MotionFrame[]): { entryEasing: EasingType; exitEasing: EasingType } {
        if (frames.length < 6) {
            return { entryEasing: 'ease-in-out-cubic', exitEasing: 'ease-out-quad' };
        }
        const n = frames.length;
        const entryWindow = Math.max(2, Math.floor(n * 0.15));
        const exitWindow = Math.max(2, Math.floor(n * 0.15));

        // Measure total motion magnitude in entry and exit windows
        const entryMag = this.windowMagnitude(frames, 0, entryWindow);
        const exitMag = this.windowMagnitude(frames, n - exitWindow, n);
        const midMag = this.windowMagnitude(frames, entryWindow, n - exitWindow);

        const entryEasing: EasingType = entryMag > midMag * 0.5 ? 'ease-in-cubic' : 'ease-in-out-cubic';
        const exitEasing: EasingType = exitMag > midMag * 0.3 ? 'ease-out-cubic' : 'ease-out-quad';
        return { entryEasing, exitEasing };
    }

    private windowMagnitude(frames: MotionFrame[], start: number, end: number): number {
        let sum = 0;
        for (let i = start; i < end; i++) {
            const f = frames[i];
            sum += Math.abs(f.headX) + Math.abs(f.headY) + Math.abs(f.headZ);
            for (const v of Object.values(f.morphs)) sum += Math.abs(v);
        }
        return sum;
    }
}

export type { RecordingCategory };
