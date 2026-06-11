import { describe, expect, it } from 'vitest';
import { buildSpeechTimeline, resolveGestureAnchors, TimedSpeechSegment } from './speech-timeline';
import type { ParsedGesture } from '../gestures/gesture-markup';
import { parseGestureMarkup } from '../gestures/gesture-markup';

const IDS = new Set(['yes', 'no', 'surprise', 'thinking', 'sigh', 'laugh']);

describe('buildSpeechTimeline', () => {
    it('turns comma into a 1s pause boundary', () => {
        const plan = buildSpeechTimeline('Bueno, seguimos', []);

        expect(plan.segments).toEqual([
            { kind: 'speech', text: 'Bueno', sourceStart: 0, sourceEnd: 5 },
            { kind: 'pause', symbol: ',', durationMs: 1000, sourceIndex: 5 },
            { kind: 'speech', text: 'seguimos', sourceStart: 7, sourceEnd: 15 },
        ]);
    });

    it('turns ascii ellipsis into one 2s pause before period parsing can consume it', () => {
        const plan = buildSpeechTimeline('Pienso... listo', []);

        expect(plan.segments.map(s => s.kind)).toEqual(['speech', 'pause', 'speech']);
        expect(plan.segments[1]).toMatchObject({ kind: 'pause', symbol: '...', durationMs: 2000 });
    });

    it('turns unicode ellipsis into a 2s pause', () => {
        const plan = buildSpeechTimeline('Pienso… listo', []);

        expect(plan.segments[1]).toMatchObject({ kind: 'pause', symbol: '…', durationMs: 2000 });
    });

    it('places tags adjacent to punctuation after the inserted pause', () => {
        const gestures: ParsedGesture[] = [{ id: 'yes', charIndex: 9, repetitions: 1, speed: 'slow' }];
        const timed: TimedSpeechSegment[] = [
            { segment: { kind: 'speech', text: 'Pienso', sourceStart: 0, sourceEnd: 6 }, start: 0, duration: 1, speechStart: 0, speechEnd: 1 },
            { segment: { kind: 'pause', symbol: '...', durationMs: 2000, sourceIndex: 6 }, start: 1, duration: 2 },
            { segment: { kind: 'speech', text: 'listo', sourceStart: 10, sourceEnd: 15 }, start: 3, duration: 1, speechStart: 0, speechEnd: 1 },
        ];

        const [anchor] = resolveGestureAnchors(gestures, timed);

        expect(anchor.at).toBe(3);
        expect(anchor.speed).toBe('slow');
    });

    it('replaces literal jaja with the laugh expression instead of speech text', () => {
        const plan = buildSpeechTimeline('Está bien jaja seguimos', []);

        expect(plan.segments).toEqual([
            { kind: 'speech', text: 'Está bien', sourceStart: 0, sourceEnd: 9 },
            { kind: 'expression', id: 'laugh', clipUrl: '/assets/audio/laugh.wav', gestureId: 'laugh', sourceIndex: 10 },
            { kind: 'speech', text: 'seguimos', sourceStart: 15, sourceEnd: 23 },
        ]);
    });

    it('handles mixed pause, command expression, trigger expression, and gesture anchors', () => {
        const parsed = parseGestureMarkup(
            'Bueno, déjame pensar... [sigh] esto es difícil, pero [laugh] jaja está bien [yes]:[2]:[slow] hagámoslo...',
            IDS
        );
        const plan = buildSpeechTimeline(parsed.cleanText, parsed.gestures);

        expect(plan.segments.map(s => s.kind)).toEqual([
            'speech', 'pause', 'speech', 'pause', 'expression', 'speech', 'pause', 'speech', 'expression', 'speech', 'pause',
        ]);
        expect(plan.segments.filter(s => s.kind === 'expression').map(s => (s as any).id)).toEqual(['sigh', 'laugh']);
        expect(plan.segments.filter(s => s.kind === 'speech').map(s => (s as any).text).join(' ')).not.toContain('jaja');
        expect(plan.gestures).toHaveLength(1);
        expect(plan.gestures[0]).toMatchObject({ id: 'yes', repetitions: 2, speed: 'slow' });
    });
});