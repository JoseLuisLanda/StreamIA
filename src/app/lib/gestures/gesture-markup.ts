/**
 * Inline gesture markup parser.
 *
 * Syntax:  [gestureId]:[seconds]:[speed]   or   [gestureId]:[seconds]   or   [gestureId]
 *   speed is optional: 'slow', 'normal', 'fast', or numeric (0.1-3.0)
 *   e.g. "Hello there [yes]:[2] nice [no]:[1.5]:[slow] way [yes]:[1.5]:[0.7]"
 * Tolerated variant: [gestureId]:2  or  [gestureId]:2:slow  (unbracketed duration/speed)
 *
 * - Tags are stripped from the text (never sent to TTS).
 * - Each gesture is anchored to its character position in the CLEAN text,
 *   so playback can map it to the moment speech reaches that word.
 * - Unknown ids / malformed durations / invalid speeds produce warnings, never throws.
 */

import type { SpeedParam } from './gesture-library';

export interface ParsedGesture {
    id: string;
    /** char index in the clean (stripped) text where the tag sat */
    charIndex: number;
    /** seconds; undefined -> use the gesture's defaultDuration */
    duration?: number;
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

        let duration: number | undefined;
        const rawDur = durBracketed !== undefined ? durBracketed : durPlain;
        if (rawDur !== undefined) {
            const d = parseFloat(String(rawDur).replace(',', '.'));
            if (Number.isFinite(d) && d > 0 && d <= 60) {
                duration = d;
            } else {
                warnings.push(`Invalid duration "${rawDur}" for [${id}], using default.`);
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

        gestures.push({ id, charIndex, duration, speed });
    }

    clean += text.slice(last);
    // collapse double spaces left behind by stripped tags
    const collapsed = clean.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim();

    // re-map charIndex after whitespace collapsing (proportional, conservative)
    if (collapsed.length !== clean.trim().length) {
        const scale = collapsed.length / Math.max(1, clean.trim().length);
        for (const g of gestures) g.charIndex = Math.min(collapsed.length, Math.round(g.charIndex * scale));
    } else {
        const lead = clean.length - clean.trimStart().length;
        for (const g of gestures) g.charIndex = Math.max(0, Math.min(collapsed.length, g.charIndex - lead));
    }

    return { cleanText: collapsed, gestures, warnings };
}

function trimEndLength(s: string): number {
    return s.replace(/\s+$/, '').length;
}
