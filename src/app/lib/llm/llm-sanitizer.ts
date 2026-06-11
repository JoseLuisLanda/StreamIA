/**
 * Sanitizes raw LLM output before it reaches the TTS/gesture pipeline.
 *
 * Strategy: RESCUE first, delete last.
 *  1. Alias map converts common wrong tags ([asentir], [nod], [jaja]...) into
 *     valid ones before validation (configurable, case-insensitive).
 *  2. Out-of-range params are CLAMPED, not stripped ([yes]:[5] -> [yes]:[3]);
 *     Spanish speed words are mapped (lento->slow, rapido->fast).
 *  3. Anything still unknown is removed with a warning.
 *  4. Markdown artifacts and emoji are stripped (they would be spoken).
 * Never throws; reports corrected/removed counters for UI process lines.
 */

export interface SanitizeResult {
    text: string;
    warnings: string[];
    /** tags rescued via alias map or param clamping */
    corrected: number;
    /** tags removed because no rescue was possible */
    removed: number;
}

/** Style limit for repetitions (the prompt asks for 1-3; pipeline tolerates 10). */
export const MAX_REPS = 3;

/**
 * Wrong tag -> replacement (replacement may include params).
 * Case/accent-insensitive on the key. Extend freely.
 */
export const TAG_ALIASES: Record<string, string> = {
    // yes
    asentir: 'yes]:[1', nod: 'yes]:[1', si: 'yes]:[1', 'sí': 'yes]:[1', afirmar: 'yes]:[1',
    // no
    negar: 'no]:[1', shake: 'no]:[1', negacion: 'no]:[1', 'negación': 'no]:[1',
    // surprise
    sorpresa: 'surprise', wow: 'surprise', sorprendido: 'surprise', asombro: 'surprise',
    // thinking
    pensar: 'thinking', think: 'thinking', pensando: 'thinking', pensativo: 'thinking',
    // sigh
    suspiro: 'sigh', suspirar: 'sigh', suspira: 'sigh',
    // laugh
    risa: 'laugh', reir: 'laugh', 'reír': 'laugh', jaja: 'laugh', jeje: 'laugh', haha: 'laugh', laughs: 'laugh',
};

/** Spanish/typo speed words -> canonical presets. */
export const SPEED_ALIASES: Record<string, string> = {
    lento: 'slow', lenta: 'slow', despacio: 'slow',
    'rápido': 'fast', rapido: 'fast', 'rápida': 'fast', rapida: 'fast', veloz: 'fast',
    medio: 'normal', media: 'normal',
};

const TAG_RE = /\[([^\[\]]*)\]((?:\s*:\s*(?:\[[^\[\]]*\]|[\w.,-]+))*)/g;
const PARAM_RE = /:\s*(?:\[([^\[\]]*)\]|([\w.,-]+))/g;
const SPEED_PRESETS = new Set(['slow', 'normal', 'fast']);

export function sanitizeLlmReply(raw: string, knownIds: ReadonlySet<string>): SanitizeResult {
    const warnings: string[] = [];
    let corrected = 0;
    let removed = 0;
    let text = raw ?? '';

    // 1) markdown + emoji cleanup
    text = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*•]\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
        .replace(/[*`#]+/g, ' ');

    // 2) validate / rescue / normalize tags
    text = text.replace(TAG_RE, (full: string, rawId: string, rawParams: string) => {
        let id = (rawId ?? '').trim().toLowerCase();

        // alias rescue
        if (!knownIds.has(id)) {
            const aliasKey = id.normalize('NFC');
            const mapped = TAG_ALIASES[aliasKey];
            if (mapped !== undefined) {
                warnings.push(`Etiqueta corregida: [${rawId}] -> [${mapped.split(']')[0]}]`);
                corrected++;
                // mapped may carry params, e.g. 'yes]:[1'
                const parts = mapped.split(']:[');
                id = parts[0];
                if (parts.length > 1 && !rawParams) rawParams = ':[' + parts.slice(1).join(']:[') + ']';
            } else {
                warnings.push(`Etiqueta desconocida eliminada: [${rawId}]`);
                removed++;
                return '';
            }
        }

        const params: string[] = [];
        if (rawParams) {
            for (const m of rawParams.matchAll(PARAM_RE)) {
                params.push(((m[1] ?? m[2]) ?? '').trim());
            }
        }
        let out = `[${id}]`;

        // repetitions: floor + clamp to 1..MAX_REPS (never strip if numeric)
        if (params.length >= 1 && params[0] !== '') {
            const n = parseFloat(params[0].replace(',', '.'));
            if (Number.isFinite(n)) {
                const reps = Math.min(MAX_REPS, Math.max(1, Math.floor(n)));
                if (reps !== n) { warnings.push(`Repeticiones ajustadas en [${id}]: ${params[0]} -> ${reps}`); corrected++; }
                out += `:[${reps}]`;
            } else {
                warnings.push(`Repeticiones inválidas en [${id}]: "${params[0]}" (omitidas)`);
            }
        }

        // speed: preset, Spanish alias, or clamped numeric
        if (params.length >= 2 && params[1] !== '') {
            const spRaw = params[1].toLowerCase();
            let valid: string | null = null;
            if (SPEED_PRESETS.has(spRaw)) {
                valid = spRaw;
            } else if (SPEED_ALIASES[spRaw]) {
                valid = SPEED_ALIASES[spRaw];
                warnings.push(`Velocidad corregida en [${id}]: ${spRaw} -> ${valid}`);
                corrected++;
            } else {
                const f = parseFloat(spRaw.replace(',', '.'));
                if (Number.isFinite(f)) {
                    const clamped = Math.min(3.0, Math.max(0.1, f));
                    valid = String(clamped);
                    if (clamped !== f) { warnings.push(`Velocidad ajustada en [${id}]: ${f} -> ${clamped}`); corrected++; }
                }
            }
            if (valid) {
                if (!out.includes(':[')) out += ':[1]';
                out += `:[${valid}]`;
            } else {
                warnings.push(`Velocidad inválida en [${id}]: "${params[1]}" (omitida)`);
            }
        }
        return out;
    });

    // 3) whitespace cleanup
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1').trim();

    return { text, warnings, corrected, removed };
}

/**
 * Length fallback: if the reply exceeds maxWords, truncate at the last
 * sentence boundary under the limit (or hard-cut as last resort).
 * Returns null when no truncation was needed.
 */
export function truncateAtSentence(text: string, maxWords = 250): string | null {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return null;
    const limitText = words.slice(0, maxWords).join(' ');
    const lastEnd = Math.max(limitText.lastIndexOf('.'), limitText.lastIndexOf('!'), limitText.lastIndexOf('?'));
    if (lastEnd > limitText.length * 0.3) return limitText.slice(0, lastEnd + 1);
    return limitText + '…';
}
