/**
 * Inline gesture markup parser.
 *
 * Syntax:  [gestureId]:[repetitions]:[speed]   or   [gestureId]:[repetitions]   or   [gestureId]
 *   repetitions is an integer >= 1 (one full motion cycle each); clamped to MAX_REPETITIONS.
 *     non-integer values are floored (with a warning); invalid values fall back to the default.
 *   speed is optional: 'slow', 'normal', 'fast', or numeric (0.1-3.0) — controls how fast each
 *     cycle plays; total duration is the emergent result of repetitions / speed.
 *   e.g. "Hello there [yes]:[2] nice [no]:[3]:[slow] way [yes]:[1]:[0.7]"
 * Tolerated variant: [gestureId]:2  or  [gestureId]:2:slow  (unbracketed repetitions/speed)
 *
 * - Tags are stripped from the text (never sent to TTS).
 * - Each gesture is anchored to its character position in the CLEAN text,
 *   so playback can map it to the moment speech reaches that word.
 * - Unknown ids / malformed repetitions / invalid speeds produce warnings, never throws.
 */

import type { SpeedParam } from './gesture-library';

/** Maximum repetitions accepted from markup; higher counts are clamped down. */
export const MAX_REPETITIONS = 10;

export interface ParsedGesture {
    id: string;
    /** char index in the clean (stripped) text where the tag sat */
    charIndex: number;
    /** integer cycle count; undefined -> use the gesture's defaultRepetitions */
    repetitions?: number;
    /** speed preset or multiplier; undefined -> use the gesture's defaultSpeed */
    speed?: SpeedParam;
}

export interface ParseResult {
    cleanText: string;
    gestures: ParsedGesture[];
    warnings: string[];
}

// [id] optionally followed by :[number]:[speed] or :number:speed or similar
// Matches: [id], [id]:2, [id]:[2], [id]:2:slow, [id]:[2]:[slow], [id]:[2]:0.7, etc.
const TAG_RE = /\[([^\[\]]+)\](?:\s*:\s*(?:\[([^\[\]]*)\]|(\d+(?:[.,]\d+)?)))?\s*(?::\s*(?:\[?([^\[\]:]+)\]?))?/g;

/**
 * @param text       raw input possibly containing markup
 * @param knownIds   gesture ids accepted by the library (unknown -> warning, tag still stripped)
 */
export function parseGestureMarkup(text: string, knownIds: ReadonlySet<string>): ParseResult {
    const gestures: ParsedGesture[] = [];
    const warnings: string[] = [];
    let clean = '';
    let last = 0;

    for (const m of text.matchAll(TAG_RE)) {
        const [full, rawId, durBracketed, durPlain, rawSpeed] = m;
        const idx = m.index ?? 0;

        // text before the tag
        clean += text.slice(last, idx);
        last = idx + full.length;

        const id = rawId.trim().toLowerCase();
        const charIndex = trimEndLength(clean); // anchor at the word just spoken

        if (!knownIds.has(id)) {
            warnings.push(`Unknown gesture "[${rawId}]" ignored.`);
            continue;
        }

        let repetitions: number | undefined;
        const rawRep = durBracketed !== undefined ? durBracketed : durPlain;
        if (rawRep !== undefined) {
            const n = parseFloat(String(rawRep).replace(',', '.'));
            if (!Number.isFinite(n) || n < 1) {
                warnings.push(`Invalid repetitions "${rawRep}" for [${id}], using default (must be an integer >= 1).`);
            } else {
                const floored = Math.floor(n);
                const clamped = Math.min(MAX_REPETITIONS, floored);
                if (floored !== n) {
                    warnings.push(`Non-integer repetitions "${rawRep}" for [${id}] rounded down to ${clamped}.`);
                } else if (clamped !== floored) {
                    warnings.push(`Repetitions "${rawRep}" for [${id}] clamped to ${MAX_REPETITIONS}.`);
                }
                repetitions = clamped;
            }
        }

        let speed: SpeedParam;
        if (rawSpeed !== undefined) {
            const trimmedSpeed = rawSpeed.trim().toLowerCase();
            if (['slow', 'normal', 'fast'].includes(trimmedSpeed)) {
                speed = trimmedSpeed as any;
            } else {
                // Try parsing as numeric
                const numSpeed = parseFloat(trimmedSpeed);
                if (Number.isFinite(numSpeed) && numSpeed >= 0.1 && numSpeed <= 3.0) {
                    speed = numSpeed;
                } else {
                    warnings.push(`Invalid speed "${rawSpeed}" for [${id}], using default. Allowed: slow|normal|fast or 0.1-3.0`);
                    speed = undefined;
                }
            }
        }

        gestures.push({ id, charIndex, repetitions, speed });
    }

    clean += text.slice(last);
    const normalized = normalizeCleanText(clean);
    for (const g of gestures) g.charIndex = normalized.mapIndex(g.charIndex);

    return { cleanText: normalized.text, gestures, warnings };
}

function trimEndLength(s: string): number {
    return s.replace(/\s+$/, '').length;
}

function normalizeCleanText(text: string): { text: string; mapIndex: (index: number) => number } {
    const map: number[] = new Array(text.length + 1).fill(0);
    const start = text.length - text.trimStart().length;
    const end = text.trimEnd().length;
    let out = '';

    for (let i = 0; i <= start; i++) map[i] = 0;

    let i = start;
    while (i < end) {
        map[i] = out.length;
        const char = text[i];
        if (/\s/.test(char)) {
            const runStart = i;
            while (i < end && /\s/.test(text[i])) i++;
            const next = text[i] ?? '';
            if (out.length > 0 && i < end && !/[.,;:!?]/.test(next)) out += ' ';
            for (let j = runStart + 1; j <= i; j++) map[j] = out.length;
            continue;
        }

        out += char;
        i++;
        map[i] = out.length;
    }

    for (let j = end; j <= text.length; j++) map[j] = out.length;

    return {
        text: out,
        mapIndex: (index: number) => map[Math.max(0, Math.min(text.length, index))] ?? out.length,
    };
}
