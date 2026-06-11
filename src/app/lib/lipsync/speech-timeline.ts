import type { ParsedGesture } from '../gestures/gesture-markup';
import type { SpeedParam } from '../gestures/gesture-library';

export const PAUSE_MAP: Record<string, number> = {
    ',': 1000,
    '...': 2000,
    '…': 2000,
};

export interface ExpressionRegistryEntry {
    id: string;
    clipUrl: string;
    gestureId: string;
    triggers?: string[];
}

export const EXPRESSION_REGISTRY: Record<string, ExpressionRegistryEntry> = {
    sigh: {
        id: 'sigh',
        clipUrl: '/assets/audio/sigh.wav',
        gestureId: 'sigh',
    },
    laugh: {
        id: 'laugh',
        clipUrl: '/assets/audio/laugh.wav',
        gestureId: 'laugh',
        triggers: ['jaja', 'jeje', 'haha'],
    },
};

export const EXPRESSION_IDS = new Set(Object.keys(EXPRESSION_REGISTRY));

export type SpeechTimelineSegment =
    | { kind: 'speech'; text: string; sourceStart: number; sourceEnd: number }
    | { kind: 'pause'; symbol: string; durationMs: number; sourceIndex: number }
    | { kind: 'expression'; id: string; clipUrl: string; gestureId: string; sourceIndex: number };

export interface TimelineGesture {
    id: string;
    charIndex: number;
    repetitions?: number;
    speed?: SpeedParam;
}

export interface SpeechTimelinePlan {
    segments: SpeechTimelineSegment[];
    gestures: TimelineGesture[];
}

export interface TimedSpeechSegment {
    segment: SpeechTimelineSegment;
    start: number;
    duration: number;
    speechStart?: number;
    speechEnd?: number;
}

export interface ResolvedGestureAnchor extends TimelineGesture {
    at: number;
}

interface TimelineEvent {
    index: number;
    order: number;
    length: number;
    segment: Exclude<SpeechTimelineSegment, { kind: 'speech' }> | null;
}

const TRIGGER_WORDS = Object.values(EXPRESSION_REGISTRY).flatMap(e => e.triggers ?? []);
const TRIGGER_RE = TRIGGER_WORDS.length
    ? new RegExp(`\\b(${TRIGGER_WORDS.map(escapeRegExp).join('|')})\\b`, 'gi')
    : null;

export function buildSpeechTimeline(text: string, gestures: ParsedGesture[]): SpeechTimelinePlan {
    const expressionCommands = gestures
        .filter(g => EXPRESSION_IDS.has(g.id))
        .map((g, order) => ({ gesture: g, order }));
    const timelineGestures = gestures
        .filter(g => !EXPRESSION_IDS.has(g.id))
        .map(g => ({ id: g.id, charIndex: g.charIndex, repetitions: g.repetitions, speed: g.speed }));

    const events: TimelineEvent[] = [];

    for (const { gesture, order } of expressionCommands) {
        const entry = EXPRESSION_REGISTRY[gesture.id];
        events.push({
            index: gesture.charIndex,
            order,
            length: 0,
            segment: { kind: 'expression', id: entry.id, clipUrl: entry.clipUrl, gestureId: entry.gestureId, sourceIndex: gesture.charIndex },
        });
    }

    if (TRIGGER_RE) {
        for (const match of text.matchAll(TRIGGER_RE)) {
            const index = match.index ?? 0;
            const trigger = match[0].toLowerCase();
            const entry = Object.values(EXPRESSION_REGISTRY).find(e => (e.triggers ?? []).includes(trigger));
            if (!entry) continue;
            const adjacentCommand = expressionCommands.some(({ gesture }) =>
                gesture.id === entry.id && gesture.charIndex <= index && text.slice(gesture.charIndex, index).trim() === ''
            );
            events.push({
                index,
                order: 1000 + index,
                length: match[0].length,
                segment: adjacentCommand ? null : { kind: 'expression', id: entry.id, clipUrl: entry.clipUrl, gestureId: entry.gestureId, sourceIndex: index },
            });
        }
    }

    for (let i = 0; i < text.length; i++) {
        if (text.startsWith('...', i)) {
            events.push({ index: i, order: 2000 + i, length: 3, segment: { kind: 'pause', symbol: '...', durationMs: PAUSE_MAP['...'], sourceIndex: i } });
            i += 2;
            continue;
        }
        if (text[i] === '…') {
            events.push({ index: i, order: 2000 + i, length: 1, segment: { kind: 'pause', symbol: '…', durationMs: PAUSE_MAP['…'], sourceIndex: i } });
            continue;
        }
        if (text[i] === ',') {
            events.push({ index: i, order: 2000 + i, length: 1, segment: { kind: 'pause', symbol: ',', durationMs: PAUSE_MAP[','], sourceIndex: i } });
        }
    }

    events.sort((a, b) => a.index - b.index || b.length - a.length || a.order - b.order);

    const segments: SpeechTimelineSegment[] = [];
    let cursor = 0;
    let coveredUntil = -1;
    for (const event of events) {
        if (event.index < coveredUntil) continue;
        appendSpeechSegment(segments, text, cursor, event.index);
        if (event.segment) segments.push(event.segment);
        cursor = event.index + event.length;
        coveredUntil = cursor;
    }
    appendSpeechSegment(segments, text, cursor, text.length);

    return { segments: mergeAdjacentSpeech(segments), gestures: timelineGestures };
}

export function resolveGestureAnchors(gestures: TimelineGesture[], timedSegments: TimedSpeechSegment[]): ResolvedGestureAnchor[] {
    const totalDuration = timedSegments.reduce((max, item) => Math.max(max, item.start + item.duration), 0);
    return gestures.map(gesture => ({ ...gesture, at: resolveGestureTime(gesture.charIndex, timedSegments, totalDuration) }));
}

function resolveGestureTime(charIndex: number, timedSegments: TimedSpeechSegment[], totalDuration: number): number {
    for (const item of timedSegments) {
        const segment = item.segment;
        if (segment.kind !== 'speech') continue;
        if (charIndex >= segment.sourceStart && charIndex <= segment.sourceEnd) {
            const span = Math.max(1, segment.sourceEnd - segment.sourceStart);
            const frac = Math.min(1, Math.max(0, (charIndex - segment.sourceStart) / span));
            const speechStart = item.speechStart ?? 0;
            const speechEnd = item.speechEnd ?? item.duration;
            return item.start + speechStart + frac * Math.max(0, speechEnd - speechStart);
        }
    }

    for (const item of timedSegments) {
        const firstIndex = getFirstSourceIndex(item.segment);
        if (firstIndex >= charIndex) return item.start;
    }

    return totalDuration;
}

function appendSpeechSegment(segments: SpeechTimelineSegment[], text: string, start: number, end: number): void {
    if (end <= start) return;
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const textValue = raw.trim();
    if (!textValue) return;
    segments.push({ kind: 'speech', text: textValue, sourceStart: start + leading, sourceEnd: end - trailing });
}

function mergeAdjacentSpeech(segments: SpeechTimelineSegment[]): SpeechTimelineSegment[] {
    const out: SpeechTimelineSegment[] = [];
    for (const segment of segments) {
        const last = out[out.length - 1];
        if (segment.kind === 'speech' && last?.kind === 'speech') {
            last.text = `${last.text} ${segment.text}`.trim();
            last.sourceEnd = segment.sourceEnd;
        } else {
            out.push({ ...segment } as SpeechTimelineSegment);
        }
    }
    return out;
}

function getFirstSourceIndex(segment: SpeechTimelineSegment): number {
    return segment.kind === 'speech' ? segment.sourceStart : segment.sourceIndex;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}