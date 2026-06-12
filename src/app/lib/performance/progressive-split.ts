/**
 * Progressive (two-phase) reply split for fast time-to-first-word.
 *
 * Part A = first sentence, capped at maxWords words (cut at a word boundary,
 * never mid-word). It plays as a light "opening": lipsync + idle only.
 * Part B = the remainder, compiled concurrently while A plays.
 *
 * TAG RELOCATION RULE (documented behavior): any gesture/expression whose
 * anchor falls inside Part A is RE-ANCHORED to the first word of Part B
 * (charIndex 0 in B coordinates). Nothing is dropped — the motion still
 * happens, just a moment later. Gestures already in Part B keep their
 * position (rebased to B coordinates).
 */

import { TimelineGesture } from '../lipsync/speech-timeline';

export interface ProgressiveSplit {
    partA: string;
    partB: string;
    /** char index in the ORIGINAL clean text where Part B starts */
    partBOffset: number;
    /** gestures rebased to Part B coordinates (relocated-from-A at 0) */
    gesturesB: TimelineGesture[];
}

/** Minimum total words for a split to be worth it. */
const MIN_TOTAL_WORDS = 12;

/**
 * @returns null when the text is too short to benefit (use the normal path).
 */
export function splitProgressive(
    cleanText: string,
    gestures: TimelineGesture[],
    maxWords = 8
): ProgressiveSplit | null {
    const text = cleanText ?? '';
    const totalWords = text.split(/\s+/).filter(Boolean).length;
    if (totalWords < MIN_TOTAL_WORDS) return null;

    // candidate boundary: end of the first sentence
    const sentenceEnd = text.search(/[.!?…](\s|$)/);
    let boundary = sentenceEnd >= 0 ? sentenceEnd + 1 : text.length;

    // cap Part A at maxWords words (cut at a word boundary, never mid-word)
    const wordRe = /\S+/g;
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(text)) !== null) {
        count++;
        if (count === maxWords) {
            const wordEnd = m.index + m[0].length;
            if (wordEnd < boundary) boundary = wordEnd;
            break;
        }
        if (m.index >= boundary) break;
    }

    const partA = text.slice(0, boundary).trim();
    // Part B starts at the next non-space char after the boundary
    let bStart = boundary;
    while (bStart < text.length && /\s/.test(text[bStart])) bStart++;
    const partB = text.slice(bStart).trim();
    if (!partA || !partB) return null;

    const gesturesB: TimelineGesture[] = gestures.map(g => ({
        ...g,
        charIndex: g.charIndex <= boundary ? 0 : Math.max(0, g.charIndex - bStart),
    }));

    return { partA, partB, partBOffset: bStart, gesturesB };
}
