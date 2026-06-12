import { describe, it, expect } from 'vitest';
import { splitProgressive } from './progressive-split';

const g = (id: string, charIndex: number) => ({ id, charIndex });

describe('splitProgressive', () => {
    const long = 'Hola amigo mío querido. Esta es una respuesta bastante larga que sigue y sigue con muchas palabras adicionales para probar.';

    it('splits at the first sentence end', () => {
        const r = splitProgressive(long, [], 8)!;
        expect(r.partA).toBe('Hola amigo mío querido.');
        expect(r.partB.startsWith('Esta es una')).toBe(true);
    });

    it('caps a long first sentence at maxWords, never mid-word', () => {
        const text = 'una dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince.';
        const r = splitProgressive(text, [], 5)!;
        expect(r.partA).toBe('una dos tres cuatro cinco');
        expect(r.partB.startsWith('seis')).toBe(true);
        expect(text.slice(r.partBOffset).startsWith('seis')).toBe(true);
    });

    it('relocates Part-A gestures to the start of Part B (rule: nothing dropped)', () => {
        const r = splitProgressive(long, [g('yes', 5)], 8)!;
        expect(r.gesturesB).toHaveLength(1);
        expect(r.gesturesB[0].charIndex).toBe(0);
    });

    it('rebases Part-B gestures to B coordinates', () => {
        const idx = long.indexOf('larga');
        const r = splitProgressive(long, [g('no', idx)], 8)!;
        expect(r.gesturesB[0].charIndex).toBe(idx - r.partBOffset);
        expect(r.partB.slice(r.gesturesB[0].charIndex).startsWith('larga')).toBe(true);
    });

    it('returns null for short texts (normal path)', () => {
        expect(splitProgressive('Hola, ¿qué tal estás hoy?', [], 8)).toBeNull();
    });

    it('A + B reconstruct the original text content', () => {
        const r = splitProgressive(long, [], 8)!;
        expect((r.partA + ' ' + r.partB).replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
    });
});
