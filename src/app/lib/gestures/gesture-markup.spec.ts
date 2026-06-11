import { describe, it, expect } from 'vitest';
import { parseGestureMarkup } from './gesture-markup';

const IDS = new Set(['yes', 'no', 'surprise', 'thinking']);

describe('parseGestureMarkup', () => {
    // Backward compatibility: 2-param syntax should still work exactly
    it('parses a valid tag with bracketed duration (backward compat)', () => {
        const r = parseGestureMarkup('Hello there [yes]:[2] nice to meet you', IDS);
        expect(r.cleanText).toBe('Hello there nice to meet you');
        expect(r.gestures).toHaveLength(1);
        expect(r.gestures[0].id).toBe('yes');
        expect(r.gestures[0].duration).toBe(2);
        expect(r.gestures[0].speed).toBeUndefined();
        expect(r.warnings).toHaveLength(0);
    });

    it('uses default duration when omitted (backward compat)', () => {
        const r = parseGestureMarkup('Claro que sí [yes] amigo', IDS);
        expect(r.gestures[0].duration).toBeUndefined();
        expect(r.gestures[0].speed).toBeUndefined();
        expect(r.cleanText).toBe('Claro que sí amigo');
    });

    it('accepts unbracketed duration variant (backward compat)', () => {
        const r = parseGestureMarkup('Vale [no]:1.5 entiendo', IDS);
        expect(r.gestures[0].duration).toBeCloseTo(1.5);
        expect(r.gestures[0].speed).toBeUndefined();
    });

    // New: 3-param syntax with speed presets
    it('parses 3-param syntax with slow preset', () => {
        const r = parseGestureMarkup('Sure [yes]:[1.5]:[slow]', IDS);
        expect(r.gestures).toHaveLength(1);
        expect(r.gestures[0].id).toBe('yes');
        expect(r.gestures[0].duration).toBe(1.5);
        expect(r.gestures[0].speed).toBe('slow');
        expect(r.warnings).toHaveLength(0);
    });

    it('parses 3-param syntax with normal preset', () => {
        const r = parseGestureMarkup('[no]:[2]:[normal] ok', IDS);
        expect(r.gestures[0].speed).toBe('normal');
    });

    it('parses 3-param syntax with fast preset', () => {
        const r = parseGestureMarkup('[surprise]:[1]:[fast]', IDS);
        expect(r.gestures[0].speed).toBe('fast');
    });

    // New: 3-param syntax with numeric speed multiplier
    it('parses 3-param syntax with numeric speed multiplier (0.7)', () => {
        const r = parseGestureMarkup('[yes]:[1.5]:[0.7]', IDS);
        expect(r.gestures[0].duration).toBe(1.5);
        expect(r.gestures[0].speed).toBe(0.7);
        expect(r.warnings).toHaveLength(0);
    });

    it('parses 3-param syntax with numeric speed 0.1 (minimum)', () => {
        const r = parseGestureMarkup('[yes]:[1]:[0.1]', IDS);
        expect(r.gestures[0].speed).toBe(0.1);
    });

    it('parses 3-param syntax with numeric speed 3.0 (maximum)', () => {
        const r = parseGestureMarkup('[yes]:[1]:[3.0]', IDS);
        expect(r.gestures[0].speed).toBe(3.0);
    });

    // New: Invalid speed values
    it('rejects out-of-range numeric speed (too small) and warns', () => {
        const r = parseGestureMarkup('[yes]:[1]:[0.05]', IDS);
        expect(r.gestures[0].speed).toBeUndefined();
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings[0]).toContain('Invalid speed');
    });

    it('rejects out-of-range numeric speed (too large) and warns', () => {
        const r = parseGestureMarkup('[yes]:[1]:[5.0]', IDS);
        expect(r.gestures[0].speed).toBeUndefined();
        expect(r.warnings.length).toBeGreaterThan(0);
    });

    it('rejects invalid speed preset name and warns', () => {
        const r = parseGestureMarkup('[yes]:[1]:[turbo]', IDS);
        expect(r.gestures[0].speed).toBeUndefined();
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings[0]).toContain('turbo');
    });

    // Mixed: speed preset with unbracketed duration
    it('parses unbracketed duration with bracketed speed preset', () => {
        const r = parseGestureMarkup('[yes]:1.5:[slow]', IDS);
        expect(r.gestures[0].duration).toBe(1.5);
        expect(r.gestures[0].speed).toBe('slow');
    });

    it('parses unbracketed duration with unbracketed speed', () => {
        const r = parseGestureMarkup('[yes]:1.5:slow', IDS);
        expect(r.gestures[0].duration).toBe(1.5);
        expect(r.gestures[0].speed).toBe('slow');
    });

    // Existing tests
    it('falls back to default on malformed duration and warns', () => {
        const r = parseGestureMarkup('Hola [surprise]:[abc] mundo', IDS);
        expect(r.gestures).toHaveLength(1);
        expect(r.gestures[0].duration).toBeUndefined();
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.cleanText).toBe('Hola mundo');
    });

    it('ignores unknown gesture ids with a warning, still stripping the tag', () => {
        const r = parseGestureMarkup('Hola [backflip]:[2] mundo', IDS);
        expect(r.gestures).toHaveLength(0);
        expect(r.warnings[0]).toContain('backflip');
        expect(r.cleanText).toBe('Hola mundo');
    });

    it('handles multiple tags with mixed syntax (backward compat + new)', () => {
        const r = parseGestureMarkup('Sí [yes]:[1] pero no [no]:[2]:[slow] gracias [surprise]', IDS);
        expect(r.gestures.map(g => ({ id: g.id, dur: g.duration, sp: g.speed }))).toEqual([
            { id: 'yes', dur: 1, sp: undefined },
            { id: 'no', dur: 2, sp: 'slow' },
            { id: 'surprise', dur: undefined, sp: undefined },
        ]);
        expect(r.cleanText).toBe('Sí pero no gracias');
        expect(r.warnings).toHaveLength(0);
    });

    it('returns text unchanged when no markup is present', () => {
        const r = parseGestureMarkup('Texto normal sin gestos.', IDS);
        expect(r.cleanText).toBe('Texto normal sin gestos.');
        expect(r.gestures).toHaveLength(0);
        expect(r.warnings).toHaveLength(0);
    });

    it('rejects out-of-range durations', () => {
        const r = parseGestureMarkup('Hola [yes]:[0] y [no]:[999]', IDS);
        expect(r.gestures).toHaveLength(2);
        expect(r.gestures[0].duration).toBeUndefined();
        expect(r.gestures[1].duration).toBeUndefined();
        expect(r.warnings).toHaveLength(2);
    });
});
