import { describe, it, expect } from 'vitest';
import { buildTimingSummary, speechStartLine, TimingMark } from './timing';

describe('speech-start timing', () => {
    const marks: TimingMark[] = [
        { name: 'start', t: 1000 },
        { name: 'sanitize_done', t: 1010 },
        { name: 'parse_split_done', t: 1015 },
        { name: 'synthA_started', t: 1020 },
        { name: 'synthA_done', t: 2620 },
        { name: 'decodeA_done', t: 2680 },
        { name: 'audio_scheduled', t: 2690 },
        { name: 'audio_started', t: 2715 },
    ];

    it('computes per-stage deltas, total, and the largest stage', () => {
        const s = buildTimingSummary(marks, false);
        expect(s.totalMs).toBe(1715);
        expect(s.largest.name).toBe('synthA_done');
        expect(s.largest.ms).toBe(1600);
        expect(s.stages).toHaveLength(7);
        expect(s.stages.find(x => x.name === 'audio_started')!.ms).toBe(25);
    });

    it('formats the chat process line', () => {
        const line = speechStartLine(buildTimingSummary(marks, false));
        expect(line).toContain('1.7 s');
        expect(line).toContain('síntesis');
        expect(line).toContain('sesión nueva');
        const cached = speechStartLine(buildTimingSummary(marks, true));
        expect(cached).toContain('sesión reutilizada');
    });

    it('is safe on degenerate inputs', () => {
        expect(buildTimingSummary([{ name: 'start', t: 5 }]).totalMs).toBe(0);
        expect(() => speechStartLine(buildTimingSummary([{ name: 'start', t: 5 }]))).not.toThrow();
    });
});
