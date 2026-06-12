/**
 * Performance compiler: turns sanitized reply text segments into ONE immutable
 * PerformancePlan on a single absolute time axis, BEFORE playback:
 *   - all speech synthesized + decoded + speech windows measured (energy),
 *   - expression clips resolved (preloaded buffers),
 *   - pauses as explicit silence events,
 *   - viseme track precomputed (absolute times, 'sil' during silence/clips),
 *   - gesture schedule anchored against MEASURED segment timings.
 * Playback then is a dumb sampler: schedule sources up front, sample tracks
 * per frame. No synthesis/decoding/fetching/allocation during playback.
 */

import {
    VisemeFrame, textToVisemes, scaleTimeline, splitIntoChunksWithOffsets, TextChunk
} from '../lipsync/text-to-visemes';
import { SpeechTimelineSegment, TimelineGesture } from '../lipsync/speech-timeline';
import { CYCLE_BASE_SECONDS, SPEED_MULTIPLIER_MIN, SPEED_MULTIPLIER_MAX, SpeedParam } from '../gestures/gesture-library';

export interface CompilerDeps {
    /** synthesize one speech chunk -> decoded AudioBuffer (worker-backed) */
    synthesize(text: string): Promise<AudioBuffer>;
    /** resolve a (preloaded) expression clip */
    getClip(url: string): Promise<AudioBuffer>;
    /** measure real speech window in a buffer (defaults to energy threshold) */
    measureBounds(buffer: AudioBuffer): { start: number; end: number };
}

export type PlanEvent =
    | { type: 'speech'; t0: number; t1: number; bufferId: string; text: string; srcStart: number; srcEnd: number }
    | { type: 'silence'; t0: number; t1: number; srcIndex: number }
    | { type: 'clip'; t0: number; t1: number; bufferId: string; gestureId: string; gestureSpeed: number; srcIndex: number };

export interface PlanGesture {
    /** seconds on the plan time axis */
    t: number;
    gestureId: string;
    repetitions?: number;
    speed?: SpeedParam | number;
    allowMouth?: boolean;
}

export interface PerformancePlan {
    events: PlanEvent[];
    gestures: PlanGesture[];
    /** absolute viseme track covering the whole plan (sil in gaps) */
    visemeTrack: VisemeFrame[];
    buffers: Map<string, AudioBuffer>;
    duration: number;
    compileMs: number;
}

/** Speech segments expanded into synthesizable chunks (<= maxLen, offsets kept). */
export type ExpandedSegment =
    | { kind: 'speech'; text: string; sourceStart: number; sourceEnd: number }
    | Exclude<SpeechTimelineSegment, { kind: 'speech' }>;

export function expandSegments(segments: SpeechTimelineSegment[], maxLen = 180): ExpandedSegment[] {
    const out: ExpandedSegment[] = [];
    for (const segment of segments) {
        if (segment.kind !== 'speech') { out.push(segment); continue; }
        const chunks: TextChunk[] = splitIntoChunksWithOffsets(segment.text, maxLen);
        for (const chunk of chunks) {
            out.push({
                kind: 'speech',
                text: chunk.text,
                sourceStart: segment.sourceStart + chunk.start,
                sourceEnd: segment.sourceStart + chunk.start + chunk.text.length,
            });
        }
    }
    return out;
}

export async function compilePerformance(
    segments: ExpandedSegment[],
    gestures: TimelineGesture[],
    lang: 'es' | 'en',
    deps: CompilerDeps
): Promise<PerformancePlan> {
    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const events: PlanEvent[] = [];
    const planGestures: PlanGesture[] = [];
    const visemeTrack: VisemeFrame[] = [];
    const buffers = new Map<string, AudioBuffer>();
    let cursor = 0;
    let bufSeq = 0;
    const anchored = new Set<TimelineGesture>();

    for (const segment of segments) {
        if (segment.kind === 'speech') {
            const buffer = await deps.synthesize(segment.text);
            const bufferId = `b${bufSeq++}`;
            buffers.set(bufferId, buffer);
            const bounds = deps.measureBounds(buffer);
            const frames = scaleTimeline(textToVisemes(segment.text, lang), bounds.start, bounds.end);
            for (const f of frames) visemeTrack.push({ viseme: f.viseme, tStart: cursor + f.tStart, tEnd: cursor + f.tEnd });

            // anchor gestures inside this chunk against the MEASURED window
            const span = Math.max(1, segment.sourceEnd - segment.sourceStart);
            const speechSpan = Math.max(0, bounds.end - bounds.start);
            for (const g of gestures) {
                if (anchored.has(g)) continue;
                if (g.charIndex >= segment.sourceStart && g.charIndex <= segment.sourceEnd) {
                    const frac = Math.min(1, Math.max(0, (g.charIndex - segment.sourceStart) / span));
                    planGestures.push({ t: cursor + bounds.start + frac * speechSpan, gestureId: g.id, repetitions: g.repetitions, speed: g.speed });
                    anchored.add(g);
                }
            }

            events.push({ type: 'speech', t0: cursor, t1: cursor + buffer.duration, bufferId, text: segment.text, srcStart: segment.sourceStart, srcEnd: segment.sourceEnd });
            cursor += buffer.duration;
        } else if (segment.kind === 'pause') {
            const dur = segment.durationMs / 1000;
            anchorBeforeSegment(gestures, anchored, planGestures, segment.sourceIndex, cursor);
            events.push({ type: 'silence', t0: cursor, t1: cursor + dur, srcIndex: segment.sourceIndex });
            visemeTrack.push({ viseme: 'sil', tStart: cursor, tEnd: cursor + dur });
            cursor += dur;
        } else {
            const buffer = await deps.getClip(segment.clipUrl);
            const bufferId = `b${bufSeq++}`;
            buffers.set(bufferId, buffer);
            const clipSpeed = Math.max(SPEED_MULTIPLIER_MIN, Math.min(SPEED_MULTIPLIER_MAX, CYCLE_BASE_SECONDS / Math.max(0.1, buffer.duration)));
            anchorBeforeSegment(gestures, anchored, planGestures, segment.sourceIndex, cursor);
            planGestures.push({ t: cursor, gestureId: segment.gestureId, repetitions: 1, speed: clipSpeed, allowMouth: true });
            events.push({ type: 'clip', t0: cursor, t1: cursor + buffer.duration, bufferId, gestureId: segment.gestureId, gestureSpeed: clipSpeed, srcIndex: segment.sourceIndex });
            visemeTrack.push({ viseme: 'sil', tStart: cursor, tEnd: cursor + buffer.duration });
            cursor += buffer.duration;
        }
    }

    // any gestures still unanchored (e.g. trailing tags) fire at the end
    for (const g of gestures) {
        if (!anchored.has(g)) planGestures.push({ t: cursor, gestureId: g.id, repetitions: g.repetitions, speed: g.speed });
    }
    planGestures.sort((a, b) => a.t - b.t);

    const compileMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
    return { events, gestures: planGestures, visemeTrack, buffers, duration: cursor, compileMs };
}

/** Gestures whose source position precedes this non-speech segment fire at its start. */
function anchorBeforeSegment(
    gestures: TimelineGesture[], anchored: Set<TimelineGesture>,
    planGestures: PlanGesture[], srcIndex: number, t: number
): void {
    for (const g of gestures) {
        if (anchored.has(g)) continue;
        if (g.charIndex <= srcIndex) {
            planGestures.push({ t, gestureId: g.id, repetitions: g.repetitions, speed: g.speed });
            anchored.add(g);
        }
    }
}

/**
 * Karaoke reveal sampler: how many chars of the plan's clean text have been
 * spoken at plan-time t. Speech events interpolate linearly between their
 * source char range over [t0, t1] (segment boundaries are exact/measured;
 * within-segment positions are linear estimates — visually smooth, error
 * well under typical word duration). Pause/clip events hold the last value.
 * Monotonic by construction.
 */
export function revealAtTime(events: PlanEvent[], t: number): number {
    let revealed = 0;
    for (const ev of events) {
        if (ev.type !== 'speech') continue;
        if (t >= ev.t1) {
            revealed = Math.max(revealed, ev.srcEnd);
        } else if (t >= ev.t0) {
            const frac = (t - ev.t0) / Math.max(1e-6, ev.t1 - ev.t0);
            revealed = Math.max(revealed, Math.round(ev.srcStart + frac * (ev.srcEnd - ev.srcStart)));
        }
    }
    return revealed;
}

/** Serializable view of a plan (buffers by id+duration) for the debug toggle. */
export function planToJson(plan: PerformancePlan): unknown {
    return {
        duration: round3(plan.duration),
        compileMs: Math.round(plan.compileMs),
        events: plan.events.map(e => ({
            ...e,
            t0: round3(e.t0), t1: round3(e.t1),
            ...(('bufferId' in e) ? { bufferSec: round3(plan.buffers.get(e.bufferId)?.duration ?? 0) } : {}),
        })),
        gestures: plan.gestures.map(g => ({ ...g, t: round3(g.t) })),
        visemeFrames: plan.visemeTrack.length,
    };
}

function round3(n: number): number { return Math.round(n * 1000) / 1000; }
