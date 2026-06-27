/**
 * SPOKEN-TEXT number handling (Piper latency fix).
 *
 * Long digit runs (e.g. "71974131981") make Piper expand a giant cardinal
 * ("setenta y un mil...") which explodes phoneme/word count and synthesis time.
 * This rewrites such runs to be spoken DIGIT-BY-DIGIT instead. It applies ONLY to
 * the text handed to the synthesizer -- the visible chat bubble is never changed.
 *
 * RULE (see DIGIT_SEQUENCE_MIN_LEN):
 *   A "numeric sequence" is a maximal run of digits that may contain single
 *   internal '-' or '.' separators (NOT spaces). If the run's DIGIT count is
 *   >= DIGIT_SEQUENCE_MIN_LEN it is spoken one digit at a time (separators
 *   dropped). Shorter numbers are left untouched so years/prices/small counts
 *   keep their natural reading.
 *
 * THRESHOLD CHOICE: default 5 (not 4) so 4-digit YEARS like "2024" keep natural
 * reading, per the "years natural" requirement. Set it to 4 to also spell years,
 * or higher (e.g. 7) to only spell long codes/phone numbers. One constant, tune freely.
 *
 * SEPARATORS:
 *   - "71-974"        -> one run, 5 digits  -> "siete uno nueve siete cuatro"
 *   - "31.981"        -> one run, 5 digits  -> spoken digit-by-digit
 *   - "719 741 31981" -> SPACES split runs  -> "719" and "741" stay natural
 *                        (3 digits each), only "31981" is spoken digit-by-digit.
 *   To merge across spaces too, add '\\s' to the separator class in SEQ_RE.
 */

/** Min digits in a run to switch to digit-by-digit reading. Tune here.
 *  Default 5: 4-digit years stay natural; 5+ runs (codes/IDs) are spelled. */
export const DIGIT_SEQUENCE_MIN_LEN = 5;

const DIGIT_WORDS: Record<'es' | 'en', string[]> = {
  es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'],
  en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
};

// A digit, then zero+ of (optional single '-', '.' or '_' separator, then a digit).
// '_' is included so numeric-sequence separators (e.g. "219888_412_1289018") are spoken
// as one digit-by-digit run and the '_' itself is dropped from the spoken text (the avatar
// must NOT vocalize the underscore). The DISPLAY keeps the '_' (see stripMarkdown).
const SEQ_RE = /\d(?:[-._]?\d)*/g;

/** True if the text has a run of >= DIGIT_SEQUENCE_MIN_LEN consecutive digits. */
export function hasLongDigitRun(text: string): boolean {
  return new RegExp(`\\d{${DIGIT_SEQUENCE_MIN_LEN},}`).test(text ?? '');
}

/**
 * Rewrite long numeric sequences in `text` to digit-by-digit words in `lang`
 * (es primary, en secondary). Pure: returns a new string; shorter numbers and
 * all non-digit text are returned unchanged.
 */
export function speakNumericSequences(text: string, lang: 'es' | 'en'): string {
  if (!text) return text;
  const words = DIGIT_WORDS[lang] ?? DIGIT_WORDS.es;
  return text.replace(SEQ_RE, (m) => {
    const digits = m.replace(/[^0-9]/g, '');
    if (digits.length < DIGIT_SEQUENCE_MIN_LEN) return m; // keep natural reading
    return digits.split('').map((d) => words[+d]).join(' ');
  });
}

/** A unit for the TTS pipeline: either text to synthesize, or a real silence gap (ms). */
export interface SpeechPart { text?: string; silenceMs?: number; }

/** Numeric sequences that carry "_" separators (e.g. "888_412_1289018"). */
const UNDERSCORE_SEQ_SRC = '\\d+(?:_\\d+)+';

/** True if the text has a numeric sequence with "_" separators (-> needs real pauses).
 *  Uses a NON-global regex: a /g regex + .test() is stateful (lastIndex persists across
 *  calls) and would flip true/false between segments, skipping the silence path. */
export function hasUnderscoreSequence(text: string): boolean {
  return new RegExp(UNDERSCORE_SEQ_SRC).test(text ?? '');
}

/**
 * Split text into SpeechParts so the TTS pipeline can insert REAL silence where a numeric
 * sequence had "_" separators. Each "_"-delimited group is spoken digit-by-digit; a silence
 * of `silenceMs` is inserted between groups. Surrounding prose (and other long digit runs)
 * is spelled via speakNumericSequences. If there is no "_"-separated sequence, returns a
 * SINGLE text part (identical to today's single-synth path).
 */
export function tokenizeSpeechWithSilences(text: string, lang: 'es' | 'en', silenceMs: number): SpeechPart[] {
  const src = text ?? '';
  if (!hasUnderscoreSequence(src)) return [{ text: speakNumericSequences(src, lang) }];
  const words = DIGIT_WORDS[lang] ?? DIGIT_WORDS.es;
  const parts: SpeechPart[] = [];
  const re = new RegExp(UNDERSCORE_SEQ_SRC, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => { const s = speakNumericSequences(t, lang); if (s.trim()) parts.push({ text: s }); };
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) pushText(src.slice(last, m.index));
    const groups = m[0].split('_');
    groups.forEach((g, i) => {
      if (i > 0) parts.push({ silenceMs });
      const spelled = g.split('').map((d) => words[+d]).join(' ');
      if (spelled) parts.push({ text: spelled });
    });
    last = m.index + m[0].length;
  }
  if (last < src.length) pushText(src.slice(last));
  return parts.length ? parts : [{ text: speakNumericSequences(src, lang) }];
}
