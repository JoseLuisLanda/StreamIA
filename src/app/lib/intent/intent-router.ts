/**
 * Intent router (phase one: keyword/pattern based).
 *
 * Classifies a user utterance as a `greeting` (small talk -> instant predefined
 * reply, NO RAG call) or a `query` (information request -> goes to the assistant's
 * RAG namespace). When neither pattern clearly wins it returns `ambiguous`, and
 * the caller may fall back to a lightweight LLM classification.
 *
 * PHASE ONE: this is a fast local heuristic and can be improved later (better
 * tokenization, multilingual lists, ML). The lists are overridable per assistant
 * (merged with the global defaults below).
 */
export type Intent = 'greeting' | 'farewell' | 'query' | 'ambiguous';

/** Global default greeting / small-talk triggers (es + en). */
export const DEFAULT_GREETING_KEYWORDS: string[] = [
  'hola', 'holi', 'buenas', 'buenos dias', 'buen dia', 'buenas tardes', 'buenas noches',
  'que tal', 'como estas', 'como esta', 'como va', 'que onda', 'que hubo', 'saludos',
  'hey', 'hello', 'hi', 'good morning', 'good afternoon', 'good evening', 'how are you',
  'gracias', 'muchas gracias', 'thank you', 'thanks',
];

/** Global default farewell triggers (es + en). */
export const DEFAULT_FAREWELL_KEYWORDS: string[] = [
  'adios', 'hasta luego', 'hasta pronto', 'nos vemos', 'hasta la vista', 'chao', 'chau',
  'me voy', 'bye', 'goodbye', 'see you', 'see ya', 'farewell', 'good night', 'buenas noches me voy',
];

/** Global default query-verb / question triggers (es + en). */
export const DEFAULT_QUERY_VERBS: string[] = [
  'dame', 'dime', 'quiero', 'necesito', 'busco', 'muestrame', 'muestra', 'explicame',
  'explica', 'cuales', 'cual', 'que', 'quien', 'donde', 'cuando', 'como', 'cuanto', 'cuanta',
  'por que', 'porque', 'recomiendame', 'recomienda', 'tienes', 'hay', 'precio', 'medidas',
  'give', 'tell', 'show', 'want', 'need', 'which', 'what', 'who', 'where', 'when', 'how',
  'why', 'recommend', 'do you have', 'how much', 'list',
];

/** Normalize: lowercase, strip accents + punctuation, collapse spaces. */
export function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9\s?!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    const k = normalize(n);
    if (!k) continue;
    // phrase match if multi-word, else token-boundary match.
    if (k.includes(' ')) { if (haystack.includes(k)) return k; }
    else if (new RegExp('(^|\\s)' + k + '(\\s|$|\\?|!)').test(haystack)) return k;
  }
  return null;
}

export interface IntentLists {
  greetingKeywords?: string[];
  farewellKeywords?: string[];
  queryVerbs?: string[];
}

/**
 * Local fast classification. Returns 'greeting' | 'farewell' | 'query' | 'ambiguous'.
 *  - Question mark or a query verb -> query (info must reach RAG).
 *  - A farewell word and NO query verb on a short utterance -> farewell.
 *  - A greeting word and NO query verb on a short utterance -> greeting.
 *  - Otherwise ambiguous (caller may LLM-classify).
 */
export function classifyIntentLocal(text: string, lists: IntentLists = {}): Intent {
  const t = normalize(text);
  if (!t) return 'ambiguous';

  const greetings = [...DEFAULT_GREETING_KEYWORDS, ...(lists.greetingKeywords ?? [])];
  const farewells = [...DEFAULT_FAREWELL_KEYWORDS, ...(lists.farewellKeywords ?? [])];
  const verbs = [...DEFAULT_QUERY_VERBS, ...(lists.queryVerbs ?? [])];

  const isQuery = t.includes('?') || hasAny(t, verbs) !== null;
  const wordCount = t.split(' ').length;

  if (isQuery) return 'query';
  if (hasAny(t, farewells) !== null && wordCount <= 6) return 'farewell';
  if (hasAny(t, greetings) !== null && wordCount <= 6) return 'greeting';
  return 'ambiguous';
}
