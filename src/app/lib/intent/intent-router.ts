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
export type Intent = 'greeting' | 'farewell' | 'capabilities' | 'query' | 'ambiguous';

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

/**
 * Global default "capabilities / purpose" triggers (es + en). These are mostly
 * multi-word PHRASES so they win over the generic query rule (they contain
 * query-verbs like "que"/"what" and often a "?") without swallowing real info
 * questions like "que informacion tienes sobre los precios".
 */
export const DEFAULT_CAPABILITY_KEYWORDS: string[] = [
  // ES (primary)
  'que puedes hacer', 'que sabes hacer', 'que puedes hacer por mi', 'que haces',
  'para que sirves', 'para que eres', 'para que estas', 'para que fuiste',
  'en que me puedes ayudar', 'en que me ayudas', 'en que puedes ayudarme', 'en que puedes ayudar',
  'como me puedes ayudar', 'como me ayudas', 'como puedes ayudarme',
  'que temas puedes', 'que temas manejas', 'que temas cubres', 'sobre que temas', 'de que temas',
  'que puedo preguntarte', 'que te puedo preguntar', 'que puedo preguntar',
  'cual es tu proposito', 'cual es tu funcion', 'cual es tu objetivo',
  'que informacion puedes', 'que informacion me puedes', 'que informacion manejas',
  'quien eres', 'que eres',
  // EN (secondary)
  'what can you do', 'what do you do', 'what are you for', 'what is your purpose',
  'how can you help', 'how do you help', 'how can you assist',
  'what topics', 'what can i ask', 'what info can you', 'what information can you',
  'who are you', 'what are you',
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
  capabilityKeywords?: string[];
  queryVerbs?: string[];
}

/**
 * Sub-mode of a 'query' intent for scripture-style assistants:
 *  - 'textual_quote'  -> the user wants the LITERAL passage (recite/read/quote, a
 *                        bare reference like "Salmo 23" / "Juan 3:16", "... completo").
 *  - 'interpretive'   -> the user wants meaning/explanation/advice.
 * Default is 'interpretive' when ambiguous.
 */
export type QueryMode = 'textual_quote' | 'interpretive';

/** Wants the literal scripture text (es + en). */
export const DEFAULT_TEXTUAL_QUOTE_KEYWORDS: string[] = [
  // ES
  'recita', 'recitame', 'cita', 'citame', 'lee', 'leeme', 'leer', 'transcribe', 'dame el texto',
  'que dice', 'que dice el', 'que dice la', 'texto de', 'texto completo', 'completo', 'completa',
  'versiculo', 'versiculos', 'capitulo', 'salmo', 'salmos', 'proverbio', 'proverbios', 'palabras de',
  // EN
  'read', 'recite', 'quote', 'full text', 'verbatim', 'what does it say', 'the text of',
  'verse', 'verses', 'chapter', 'psalm', 'psalms',
];

/** Wants meaning/explanation/advice (es + en). Checked BEFORE quote so "que SIGNIFICA
 *  el salmo 23" stays interpretive even though it names a reference. */
export const DEFAULT_INTERPRETIVE_KEYWORDS: string[] = [
  // ES
  'que significa', 'significa', 'significado', 'explica', 'explicame', 'explicacion',
  'que ensena', 'ensena sobre', 'que ensenanza', 'interpreta', 'interpretame', 'interpretacion',
  'reflexion', 'que quiere decir', 'que aprendemos', 'aplicacion', 'como aplico', 'que aplicacion',
  'analisis', 'analiza', 'comenta', 'comentario',
  // EN
  'what does it mean', 'meaning', 'explain', 'explanation', 'what does it teach', 'teach about',
  'interpret', 'interpretation', 'reflection', 'lesson', 'application', 'analyze', 'comment',
];

/**
 * A bare scripture reference signal. Takes BOTH the raw (lowercased) text and the
 * normalized text: the chapter:verse colon is stripped by normalize(), so "3:16"
 * is matched on `raw`, while the noun+number form is matched on the
 * accent-stripped `norm`.
 */
function hasScriptureReference(raw: string, norm: string): boolean {
  if (/\b\d+\s*:\s*\d+\b/.test(raw)) return true; // "3:16" (colon preserved on raw)
  // a scripture noun followed by a number -> "salmo 23", "capitulo 1", "psalm 23"
  if (/\b(salmo|salmos|capitulo|proverbio|proverbios|psalm|psalms|chapter|verse|versiculo)\s+\d+/.test(norm)) return true;
  return false;
}

/**
 * Sub-classify a 'query' as textual_quote vs interpretive. Interpretive wins on an
 * explicit meaning/explanation phrase; otherwise a quote keyword or a bare
 * reference selects textual_quote. Defaults to interpretive when neither is clear.
 */
export function classifyQueryMode(text: string, lists: { textualQuoteKeywords?: string[]; interpretiveKeywords?: string[] } = {}): QueryMode {
  const raw = (text || '').toLowerCase();
  const t = normalize(text);
  if (!t) return 'interpretive';
  const interp = [...DEFAULT_INTERPRETIVE_KEYWORDS, ...(lists.interpretiveKeywords ?? [])];
  const quote = [...DEFAULT_TEXTUAL_QUOTE_KEYWORDS, ...(lists.textualQuoteKeywords ?? [])];
  if (hasAny(t, interp) !== null) return 'interpretive';
  if (hasAny(t, quote) !== null || hasScriptureReference(raw, t)) return 'textual_quote';
  return 'interpretive';
}

/**
 * Local fast classification. Returns 'greeting' | 'farewell' | 'query' | 'ambiguous'.
 *  - A "capabilities/purpose" phrase -> capabilities (answered metadata-only, NO RAG).
 *  - Question mark or a query verb -> query (info must reach RAG).
 *  - A farewell word and NO query verb on a short utterance -> farewell.
 *  - A greeting word and NO query verb on a short utterance -> greeting.
 *  - Otherwise ambiguous (caller may LLM-classify).
 *
 * Capabilities is checked BEFORE the generic query rule on purpose: phrases like
 * "que puedes hacer?" contain a query-verb + "?" and would otherwise be classified
 * as a query. The phrases are specific enough not to swallow real info questions.
 */
export function classifyIntentLocal(text: string, lists: IntentLists = {}): Intent {
  const t = normalize(text);
  if (!t) return 'ambiguous';

  const greetings = [...DEFAULT_GREETING_KEYWORDS, ...(lists.greetingKeywords ?? [])];
  const farewells = [...DEFAULT_FAREWELL_KEYWORDS, ...(lists.farewellKeywords ?? [])];
  const capabilities = [...DEFAULT_CAPABILITY_KEYWORDS, ...(lists.capabilityKeywords ?? [])];
  const verbs = [...DEFAULT_QUERY_VERBS, ...(lists.queryVerbs ?? [])];

  // Capabilities/purpose wins over the generic query rule (see doc note above).
  if (hasAny(t, capabilities) !== null) return 'capabilities';

  const isQuery = t.includes('?') || hasAny(t, verbs) !== null;
  const wordCount = t.split(' ').length;

  if (isQuery) return 'query';
  if (hasAny(t, farewells) !== null && wordCount <= 6) return 'farewell';
  if (hasAny(t, greetings) !== null && wordCount <= 6) return 'greeting';
  return 'ambiguous';
}
