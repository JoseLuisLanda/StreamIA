/**
 * Rule-based text → viseme timeline.
 *
 * Spanish orthography is nearly phonetic, so a deterministic
 * grapheme→phoneme→viseme pass gives reliable mouth shapes.
 * English uses a rougher heuristic (documented limitation).
 *
 * Output durations are RELATIVE units; callers scale the timeline
 * to the real (measured) audio duration with `scaleTimeline()`.
 */

import { Viseme } from './viseme-map';

export interface VisemeEvent {
    viseme: Viseme;
    /** relative duration units */
    dur: number;
}

export interface VisemeFrame {
    viseme: Viseme;
    /** seconds, relative to audio start */
    tStart: number;
    tEnd: number;
}

// Relative duration units (roughly ms at normal speech rate)
const VOWEL = 95;
const CONS = 55;
const PAUSE_COMMA = 160;
const PAUSE_SENTENCE = 320;
const WORD_GAP = 25;

const VOWEL_VISEME: Record<string, Viseme> = {
    a: 'aa', á: 'aa',
    e: 'E', é: 'E',
    i: 'I', í: 'I', y: 'I',
    o: 'O', ó: 'O',
    u: 'U', ú: 'U', ü: 'U',
};

function isVowel(c: string): boolean {
    return c in VOWEL_VISEME;
}

/** Spanish grapheme → viseme sequence. */
export function spanishTextToVisemes(text: string): VisemeEvent[] {
    const out: VisemeEvent[] = [];
    const push = (v: Viseme, d: number) => out.push({ viseme: v, dur: d });
    const s = text.toLowerCase().normalize('NFC');

    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const next = s[i + 1] ?? '';

        if (isVowel(c)) { push(VOWEL_VISEME[c], VOWEL); continue; }

        switch (c) {
            case 'b': case 'v': case 'p': case 'm': push('PP', CONS); break;
            case 'f': push('FF', CONS); break;
            case 'd': case 't': push('DD', CONS); break;
            case 'c':
                if (next === 'h') { push('CH', CONS); i++; }
                else if ('eéií'.includes(next)) push('SS', CONS);
                else push('kk', CONS);
                break;
            case 'q':
                push('kk', CONS);
                if (next === 'u') i++; // "qu" → /k/, u is silent
                break;
            case 'g':
                if ('eéií'.includes(next)) push('kk', CONS); // ge/gi → jota
                else if (next === 'u' && 'eéií'.includes(s[i + 2] ?? '')) { push('kk', CONS); i++; } // gue/gui
                else push('kk', CONS);
                break;
            case 'j': case 'x': push('kk', CONS); break;
            case 'k': push('kk', CONS); break;
            case 's': case 'z': push('SS', CONS); break;
            case 'l':
                if (next === 'l') { push('CH', CONS); i++; } // ll → y sound
                else push('nn', CONS);
                break;
            case 'n': case 'ñ': push('nn', CONS); break;
            case 'r':
                if (next === 'r') { push('RR', CONS * 1.4); i++; }
                else push('RR', CONS);
                break;
            case 'w': push('U', CONS); break;
            case 'h': break; // silent in Spanish
            case ',': case ';': case ':': push('sil', PAUSE_COMMA); break;
            case '.': case '!': case '?': case '¡': case '¿': push('sil', PAUSE_SENTENCE); break;
            case ' ': case '\n': case '\t': push('sil', WORD_GAP); break;
            default: break; // digits/symbols ignored (TTS reads them, slight desync acceptable)
        }
    }
    return mergeSilences(out);
}

/** Heuristic English grapheme → viseme sequence (approximate). */
export function englishTextToVisemes(text: string): VisemeEvent[] {
    const out: VisemeEvent[] = [];
    const push = (v: Viseme, d: number) => out.push({ viseme: v, dur: d });
    const s = text.toLowerCase();

    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const next = s[i + 1] ?? '';
        switch (c) {
            case 'a': push('aa', VOWEL); break;
            case 'e': if (next === 'e') { push('I', VOWEL); i++; } else push('E', VOWEL); break;
            case 'i': push('I', VOWEL); break;
            case 'o': if (next === 'o') { push('U', VOWEL); i++; } else push('O', VOWEL); break;
            case 'u': push('U', VOWEL); break;
            case 'y': push('I', CONS); break;
            case 'b': case 'p': case 'm': push('PP', CONS); break;
            case 'f': case 'v': push('FF', CONS); break;
            case 't':
                if (next === 'h') { push('TH', CONS); i++; } else push('DD', CONS);
                break;
            case 'd': push('DD', CONS); break;
            case 'c':
                if (next === 'h') { push('CH', CONS); i++; }
                else if ('eiy'.includes(next)) push('SS', CONS);
                else push('kk', CONS);
                break;
            case 'k': case 'g': case 'q': case 'x': push('kk', CONS); break;
            case 's':
                if (next === 'h') { push('CH', CONS); i++; } else push('SS', CONS);
                break;
            case 'z': push('SS', CONS); break;
            case 'j': push('CH', CONS); break;
            case 'l': case 'n': push('nn', CONS); break;
            case 'r': push('RR', CONS); break;
            case 'w': push('U', CONS); break;
            case 'h': push('kk', CONS * 0.5); break;
            case ',': case ';': case ':': push('sil', PAUSE_COMMA); break;
            case '.': case '!': case '?': push('sil', PAUSE_SENTENCE); break;
            case ' ': case '\n': case '\t': push('sil', WORD_GAP); break;
            default: break;
        }
    }
    return mergeSilences(out);
}

function mergeSilences(events: VisemeEvent[]): VisemeEvent[] {
    const out: VisemeEvent[] = [];
    for (const e of events) {
        const last = out[out.length - 1];
        if (last && last.viseme === 'sil' && e.viseme === 'sil') last.dur += e.dur;
        else out.push({ ...e });
    }
    // trim leading/trailing silence — alignment window is speech-only
    while (out.length && out[0].viseme === 'sil') out.shift();
    while (out.length && out[out.length - 1].viseme === 'sil') out.pop();
    return out;
}

export function textToVisemes(text: string, lang: 'es' | 'en'): VisemeEvent[] {
    return lang === 'es' ? spanishTextToVisemes(text) : englishTextToVisemes(text);
}

/**
 * Scale relative viseme events into the measured speech window
 * [speechStart, speechEnd] (seconds within the audio buffer).
 */
export function scaleTimeline(events: VisemeEvent[], speechStart: number, speechEnd: number): VisemeFrame[] {
    const total = events.reduce((a, e) => a + e.dur, 0);
    if (total <= 0 || speechEnd <= speechStart) return [];
    const span = speechEnd - speechStart;
    const frames: VisemeFrame[] = [];
    let t = speechStart;
    for (const e of events) {
        const d = (e.dur / total) * span;
        frames.push({ viseme: e.viseme, tStart: t, tEnd: t + d });
        t += d;
    }
    return frames;
}

/**
 * Find speech start/end in an AudioBuffer by simple energy threshold.
 * DOWNSAMPLED: scans every `step`-th sample so a long buffer can't cause a long
 * synchronous main-thread loop. step=32 -> ~1.5 ms of position granularity at
 * 22 kHz, which is inaudible for viseme alignment but ~32x cheaper.
 */
export function findSpeechBounds(buffer: AudioBuffer, threshold = 0.01, step = 32): { start: number; end: number } {
    const data = buffer.getChannelData(0);
    const n = data.length;
    const s = Math.max(1, step | 0);
    let first = 0, last = n - 1;
    for (let i = 0; i < n; i += s) { if (Math.abs(data[i]) > threshold) { first = i; break; } }
    for (let i = n - 1; i >= 0; i -= s) { if (Math.abs(data[i]) > threshold) { last = i; break; } }
    if (last <= first) return { start: 0, end: buffer.duration };
    return { start: first / buffer.sampleRate, end: last / buffer.sampleRate };
}

/** Split long text into speakable chunks (sentence-ish, ≤ maxLen chars). */
export function splitIntoChunks(text: string, maxLen = 220): string[] {
    const sentences = text.match(/[^.!?¡¿]+[.!?]*/g) ?? [text];
    const chunks: string[] = [];
    let current = '';
    for (const s of sentences) {
        const piece = s.trim();
        if (!piece) continue;
        if ((current + ' ' + piece).trim().length <= maxLen) {
            current = (current + ' ' + piece).trim();
        } else {
            if (current) chunks.push(current);
            if (piece.length <= maxLen) { current = piece; }
            else {
                // hard-split very long sentences on word boundaries
                let rest = piece;
                while (rest.length > maxLen) {
                    let cut = rest.lastIndexOf(' ', maxLen);
                    if (cut < maxLen * 0.5) cut = maxLen;
                    chunks.push(rest.slice(0, cut).trim());
                    rest = rest.slice(cut).trim();
                }
                current = rest;
            }
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

export interface TextChunk {
    text: string;
    /** char offset of this chunk's start within the source text */
    start: number;
}

/** Like splitIntoChunks, but preserves each chunk's char offset in the source text. */
export function splitIntoChunksWithOffsets(text: string, maxLen = 220): TextChunk[] {
    const out: TextChunk[] = [];
    const re = /[^.!?\u00a1\u00bf]+[.!?]*/g;
    let current = '';
    let currentStart = -1;
    let m: RegExpExecArray | null;

    const flush = () => {
        if (current.trim()) out.push({ text: current.trim(), start: currentStart });
        current = ''; currentStart = -1;
    };

    while ((m = re.exec(text)) !== null) {
        const piece = m[0];
        const pieceStart = m.index + (piece.length - piece.trimStart().length);
        const trimmed = piece.trim();
        if (!trimmed) continue;
        if (current && (current.length + 1 + trimmed.length) > maxLen) flush();
        if (!current) currentStart = pieceStart;

        if (trimmed.length > maxLen) {
            flush();
            let rest = trimmed;
            let restStart = pieceStart;
            while (rest.length > maxLen) {
                let cut = rest.lastIndexOf(' ', maxLen);
                if (cut < maxLen * 0.5) cut = maxLen;
                out.push({ text: rest.slice(0, cut).trim(), start: restStart });
                restStart += cut;
                rest = rest.slice(cut);
                const lead = rest.length - rest.trimStart().length;
                restStart += lead; rest = rest.trimStart();
            }
            current = rest; currentStart = restStart;
        } else {
            current = current ? current + ' ' + trimmed : trimmed;
        }
    }
    flush();
    if (out.length === 0 && text.trim()) out.push({ text: text.trim(), start: 0 });
    return out;
}

/**
 * Split text into ONE chunk PER SENTENCE (offsets preserved), WITHOUT grouping
 * sentences together. Each chunk is a complete prosodic unit that Piper can
 * synthesize starting and ending in natural silence -- so progressive playback
 * joins clips at sentence boundaries (no mid-sentence/mid-word cut, which makes the
 * independent Piper clips sound slurred/garbled at the seam).
 *
 * Only a pathologically long single sentence (> hardMax) is sub-split, and then
 * ONLY at word boundaries (never mid-word) as a last resort to bound clip size.
 */
export function splitIntoSentencesWithOffsets(text: string, hardMax = 320): TextChunk[] {
    const out: TextChunk[] = [];
    const re = /[^.!?¡¿…]+[.!?…]*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const piece = m[0];
        const start = m.index + (piece.length - piece.trimStart().length);
        const trimmed = piece.trim();
        if (!trimmed) continue;
        if (trimmed.length <= hardMax) {
            out.push({ text: trimmed, start });
            continue;
        }
        // Last resort: a single sentence longer than hardMax -> split at word boundaries.
        let rest = trimmed;
        let restStart = start;
        while (rest.length > hardMax) {
            let cut = rest.lastIndexOf(' ', hardMax);
            if (cut < hardMax * 0.5) cut = hardMax; // no space found early -> hard cut
            out.push({ text: rest.slice(0, cut).trim(), start: restStart });
            restStart += cut;
            rest = rest.slice(cut);
            const lead = rest.length - rest.trimStart().length;
            restStart += lead;
            rest = rest.trimStart();
        }
        if (rest.trim()) out.push({ text: rest.trim(), start: restStart });
    }
    if (out.length === 0 && text.trim()) out.push({ text: text.trim(), start: 0 });
    return out;
}
