import { describe, it, expect } from 'vitest';
import { sanitizeLlmReply, truncateAtSentence } from './llm-sanitizer';

const IDS = new Set(['yes', 'no', 'surprise', 'thinking', 'sigh', 'laugh']);

describe('sanitizeLlmReply (alias rescue)', () => {
    it('passes valid markup through untouched', () => {
        const r = sanitizeLlmReply('[sigh] Hola, claro que [yes]:[1] sí. Pero [no]:[2]:[slow] eso no.', IDS);
        expect(r.text).toBe('[sigh] Hola, claro que [yes]:[1] sí. Pero [no]:[2]:[slow] eso no.');
        expect(r.corrected).toBe(0);
        expect(r.removed).toBe(0);
    });

    it('rescues every documented tag alias', () => {
        expect(sanitizeLlmReply('claro [asentir] que sí', IDS).text).toBe('claro [yes]:[1] que sí');
        expect(sanitizeLlmReply('claro [nod] que sí', IDS).text).toBe('claro [yes]:[1] que sí');
        expect(sanitizeLlmReply('pues [negar] no', IDS).text).toBe('pues [no]:[1] no');
        expect(sanitizeLlmReply('pues [shake] no', IDS).text).toBe('pues [no]:[1] no');
        expect(sanitizeLlmReply('[sorpresa] qué fuerte', IDS).text).toBe('[surprise] qué fuerte');
        expect(sanitizeLlmReply('[wow] increíble', IDS).text).toBe('[surprise] increíble');
        expect(sanitizeLlmReply('[pensar] mmm', IDS).text).toBe('[thinking] mmm');
        expect(sanitizeLlmReply('[pensando] mmm', IDS).text).toBe('[thinking] mmm');
        expect(sanitizeLlmReply('[suspiro] vale', IDS).text).toBe('[sigh] vale');
        expect(sanitizeLlmReply('[risa] qué bueno', IDS).text).toBe('[laugh] qué bueno');
        expect(sanitizeLlmReply('[reir] qué bueno', IDS).text).toBe('[laugh] qué bueno');
    });

    it('bracketed [jaja]/[haha] become [laugh]; plain-text jaja is untouched', () => {
        const r = sanitizeLlmReply('[jaja] jaja qué risa [haha]', IDS);
        expect(r.text).toBe('[laugh] jaja qué risa [laugh]');
        expect(r.corrected).toBe(2);
    });

    it('alias keeps explicit params: [asentir]:[2] -> [yes]:[2]', () => {
        expect(sanitizeLlmReply('claro [asentir]:[2] que sí', IDS).text).toBe('claro [yes]:[2] que sí');
    });

    it('clamps repetitions to 1-3: [yes]:[5] -> [yes]:[3]', () => {
        const r = sanitizeLlmReply('[yes]:[5] sí', IDS);
        expect(r.text).toBe('[yes]:[3] sí');
        expect(r.corrected).toBe(1);
    });

    it('maps Spanish speed words: lento->slow, rapido/rápido->fast', () => {
        expect(sanitizeLlmReply('[no]:[2]:[lento] no', IDS).text).toBe('[no]:[2]:[slow] no');
        expect(sanitizeLlmReply('[yes]:[1]:[rapido] sí', IDS).text).toBe('[yes]:[1]:[fast] sí');
        expect(sanitizeLlmReply('[yes]:[1]:[rápido] sí', IDS).text).toBe('[yes]:[1]:[fast] sí');
    });

    it('still removes truly unknown tags, counted separately', () => {
        const r = sanitizeLlmReply('mira [dance]:[5] esto [asentir] bien', IDS);
        expect(r.text).toBe('mira esto [yes]:[1] bien');
        expect(r.removed).toBe(1);
        expect(r.corrected).toBe(1);
    });

    it('handles mixed valid + invalid + alias in one reply', () => {
        const r = sanitizeLlmReply('Claro [yes]:[2]:[slow] sí, [sorpresa] vaya, [baile] no sé, [no]:[9]:[lento] no.', IDS);
        expect(r.text).toBe('Claro [yes]:[2]:[slow] sí, [surprise] vaya, no sé, [no]:[3]:[slow] no.');
        expect(r.removed).toBe(1);
        expect(r.corrected).toBe(3); // sorpresa + reps 9->3 + lento->slow
    });

    it('never throws on garbage', () => {
        expect(() => sanitizeLlmReply('[[[]]]:::[*broken**[yes]:[', IDS)).not.toThrow();
    });
});

describe('truncateAtSentence', () => {
    it('returns null under the limit', () => {
        expect(truncateAtSentence('Hola. Qué tal.', 250)).toBeNull();
    });

    it('truncates at the last sentence boundary under the limit', () => {
        const text = Array(60).fill('palabra').join(' ') + '. ' + Array(60).fill('otra').join(' ') + '. final extra';
        const out = truncateAtSentence(text, 100);
        expect(out).not.toBeNull();
        expect(out!.endsWith('.')).toBe(true);
        expect(out!.split(/\s+/).length).toBeLessThanOrEqual(100);
    });
});
