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

// A digit, then zero+ of (optional single '-' or '.' separator, then a digit).
const SEQ_RE = /\d(?:[-.]?\d)*/g;

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
