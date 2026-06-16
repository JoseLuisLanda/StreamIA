/**
 * generateResponses callable (admin) -- AI-assisted draft generation for the
 * conversational content editor. Returns DRAFTS only (never saved); the admin
 * reviews/edits/accepts in the UI.
 *
 * Uses the assistant's resolved LLM profile (system-default profile for the global
 * tab) via generateRawFromProfile. Output is parsed as a JSON array.
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';
import { loadProfile, loadSystemDefault, resolveProfileForAssistant } from './lib/llm-profiles';
import { generateRawFromProfile } from './lib/llm';

type Category = 'greetings' | 'infoAcknowledgements' | 'farewells' | 'suggestedPrompts';

interface GenReq {
  scope: 'global' | 'assistant';
  assistantId?: string;
  category: Category;
  count?: number;
  context?: {
    name?: string; role?: string; description?: string; topicTag?: string;
    language?: string; persona?: string;
  };
}

interface GenRes {
  ok: boolean;
  category: Category;
  phrases?: string[];
  prompts?: Array<{ label: string; prompt: string }>;
  provider?: string;
  model?: string;
  error?: string;
}

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

const CATEGORY_INTENT: Record<Category, string> = {
  greetings: 'saludos calidos y breves para iniciar la conversacion',
  infoAcknowledgements: 'frases cortas para decir mientras se busca informacion (relleno de espera)',
  farewells: 'despedidas amables y breves',
  suggestedPrompts: 'sugerencias de preguntas que el asistente puede responder desde su base de conocimiento',
};

export const generateResponses = onCall<GenReq, Promise<GenRes>>(
  CALL_OPTS,
  async (req: CallableRequest<GenReq>): Promise<GenRes> => {
    assertSignedIn(req.auth);
    if (ENFORCE_ADMIN_ROLE) await assertAdmin(req.auth);

    const d = req.data ?? ({} as GenReq);
    const category = d.category;
    if (!category) throw new HttpsError('invalid-argument', 'category is required.');
    const count = Math.min(Math.max(2, Math.floor(d.count ?? 5)), 10);

    // Resolve the profile + assistant context.
    let ctx = d.context ?? {};
    let profile;
    try {
      if (d.scope === 'assistant') {
        if (!d.assistantId) throw new HttpsError('invalid-argument', 'assistantId required for assistant scope.');
        const aSnap = await db.collection('assistants').doc(d.assistantId).get();
        const a = (aSnap.data() as any) ?? {};
        ctx = {
          name: ctx.name ?? a.name,
          role: ctx.role ?? a.role,
          description: ctx.description ?? a.description,
          topicTag: ctx.topicTag ?? a.topicTag,
          language: ctx.language ?? a.language ?? 'es',
          persona: ctx.persona ?? a.systemPrompt,
        };
        const r = await resolveProfileForAssistant(d.assistantId, (a.llmProfileId || '').toString().trim());
        profile = r.profile;
      } else {
        profile = await loadSystemDefault();
        if (!profile) throw new HttpsError('failed-precondition', 'No system-default LLM profile. Configure one in /llm-admin.');
      }
    } catch (e: any) {
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('not-found', e?.message ?? String(e));
    }
    if (!profile) throw new HttpsError('failed-precondition', 'No LLM profile resolved.');
    // Allow passing an explicit profileId override (rare).
    void loadProfile;

    const lang = (ctx.language === 'en' ? 'en' : 'es');
    const system = buildGenSystem(lang);
    const userText = buildGenUser(category, count, ctx, lang);

    try {
      const { text, provider, model } = await generateRawFromProfile(profile, system, userText);
      const parsed = parseArray(text);
      logger.info('generateResponses', { scope: d.scope, category, provider, model, n: parsed.length });
      if (category === 'suggestedPrompts') {
        const prompts = parsed
          .map((x: any) => (typeof x === 'object' ? { label: String(x.label ?? '').trim(), prompt: String(x.prompt ?? '').trim() } : null))
          .filter((x): x is { label: string; prompt: string } => !!x && !!x.label && !!x.prompt)
          .slice(0, count);
        return { ok: true, category, prompts, provider, model };
      }
      const phrases = parsed.map((x: any) => (typeof x === 'string' ? x : String(x?.text ?? ''))).map((s) => s.trim()).filter(Boolean).slice(0, count);
      return { ok: true, category, phrases, provider, model };
    } catch (e: any) {
      const meta = e?.meta ?? {};
      return { ok: false, category, provider: meta.provider, model: meta.model, error: e?.message ?? String(e) };
    }
  },
);

function buildGenSystem(lang: 'es' | 'en'): string {
  const L = lang === 'es' ? 'espanol' : 'English';
  return (
    `Generas contenido conversacional para un avatar. Responde SIEMPRE en ${L}. ` +
    `Reglas: cada frase debe ser pertinente al rol/descripcion del asistente; entre 8 y 18 palabras ` +
    `(equivale a 3-6 s de habla); sin groserias; variadas entre si; tono calido y natural. ` +
    `Para sugerencias de preguntas, cada item es un objeto {"label","prompt"} donde label es corto (1-4 palabras) ` +
    `y prompt es una pregunta que el asistente pueda responder desde su base de conocimiento. ` +
    `Devuelve UNICAMENTE un arreglo JSON valido, sin texto adicional, sin markdown.`
  );
}

function buildGenUser(category: Category, count: number, ctx: GenReq['context'], lang: 'es' | 'en'): string {
  const c = ctx ?? {};
  const ctxLines = [
    c.name ? `Nombre: ${c.name}` : '',
    c.role ? `Rol: ${c.role}` : '',
    c.description ? `Descripcion: ${c.description}` : '',
    c.topicTag ? `Tema: ${c.topicTag}` : '',
    c.persona ? `Persona: ${String(c.persona).slice(0, 400)}` : '',
  ].filter(Boolean).join('\n');
  const want = CATEGORY_INTENT[category];
  const shape = category === 'suggestedPrompts'
    ? `un arreglo JSON de ${count} objetos {"label","prompt"}`
    : `un arreglo JSON de ${count} cadenas de texto`;
  return `Contexto del asistente:\n${ctxLines || '(sin contexto)'}\n\nGenera ${shape}: ${want}. Idioma: ${lang}.`;
}

/** Extract the first JSON array from the model text (tolerates code fences/prose). */
function parseArray(text: string): any[] {
  if (!text) return [];
  let t = text.trim().replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
