/**
 * listProviderModels callable (admin-gated).
 *
 * Lists the LIVE, currently-valid models for a provider, filtered to those that
 * can serve chat / generateContent. The provider API KEY is read SERVER-SIDE from
 * Secret Manager (the profile's active key) and is NEVER returned or logged.
 *
 * Request:  { provider, profileId, baseUrl? }
 * Response: { ok, models: string[], error? }   (models = bare ids, no "models/" prefix)
 *
 * Providers:
 *  - gemini-api: GET generativelanguage.googleapis.com/v1beta/models (x-goog-api-key)
 *                -> keep models whose supportedGenerationMethods includes generateContent.
 *  - openai:     GET {base}/models (Bearer) -> keep chat-capable ids only.
 *  - deepseek:   GET {base}/models (Bearer, OpenAI-compatible).
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';
import { VALID_PROVIDERS, LlmProviderId } from './lib/llm-config';
import { loadProfile, activeKey } from './lib/llm-profiles';
import { accessSecret } from './lib/secrets';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

interface ListReq {
  provider: LlmProviderId;
  profileId: string;
  baseUrl?: string;
}
interface ListRes {
  ok: boolean;
  models: string[];
  error?: string;
}

/** OpenAI ids that are NOT chat/completions (embeddings, audio, image, etc.). */
const OPENAI_EXCLUDE = [
  'embedding', 'whisper', 'tts', 'audio', 'image', 'dall-e', 'dalle', 'moderation',
  'realtime', 'transcribe', 'search', 'babbage', 'davinci', 'instruct',
];

export const listProviderModels = onCall<ListReq, Promise<ListRes>>(
  CALL_OPTS,
  async (req: CallableRequest<ListReq>): Promise<ListRes> => {
    assertSignedIn(req.auth);
    if (ENFORCE_ADMIN_ROLE) await assertAdmin(req.auth);

    const provider = req.data?.provider;
    const profileId = (req.data?.profileId || '').trim();
    const baseUrl = (req.data?.baseUrl || '').trim();
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      throw new HttpsError('invalid-argument', 'Unknown or missing provider.');
    }
    if (!profileId) {
      return { ok: false, models: [], error: 'Save the profile and add a key before listing models.' };
    }

    // Resolve the active key server-side (never returned to the client).
    const profile = await loadProfile(profileId);
    if (!profile) return { ok: false, models: [], error: 'Profile not found.' };
    const ak = activeKey(profile);
    if (!ak) return { ok: false, models: [], error: 'No active key on this profile. Add a key first.' };
    let apiKey = '';
    try {
      apiKey = await accessSecret(ak.secretName);
    } catch (e) {
      return { ok: false, models: [], error: `Key fetch failed: ${String((e as any)?.message ?? e)}` };
    }
    if (!apiKey) return { ok: false, models: [], error: 'The active key has no value. Set it first.' };

    try {
      let models: string[] = [];
      if (provider === 'gemini-api') {
        models = await listGemini(baseUrl, apiKey);
      } else if (provider === 'openai') {
        models = await listOpenAiCompatible(baseUrl || 'https://api.openai.com/v1', apiKey, 'openai');
      } else {
        // deepseek: list endpoint lives at the root, not under /v1.
        const base = (baseUrl || 'https://api.deepseek.com').replace(/\/v1\/?$/, '');
        models = await listOpenAiCompatible(base, apiKey, 'deepseek');
      }
      models = Array.from(new Set(models)).sort();
      logger.info('listProviderModels', { provider, profileId, count: models.length }); // never logs the key
      return { ok: true, models };
    } catch (e: any) {
      return { ok: false, models: [], error: e?.message ?? String(e) };
    }
  },
);

/** Gemini: keep only models that support generateContent; strip the "models/" prefix. */
async function listGemini(baseUrl: string, apiKey: string): Promise<string[]> {
  const base = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const res = await fetch(`${base}/models?pageSize=1000`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gemini list failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
  return (data.models ?? [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter((id) => id && !id.includes('embedding'));
}

/** OpenAI-compatible (openai/deepseek): GET {base}/models, keep chat-capable ids. */
async function listOpenAiCompatible(base: string, apiKey: string, kind: 'openai' | 'deepseek'): Promise<string[]> {
  const url = `${base.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${kind} list failed (HTTP ${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? []).map((m) => (m.id ?? '').trim()).filter(Boolean);
  if (kind === 'deepseek') return ids; // DeepSeek only lists chat models.
  // OpenAI: keep chat models (gpt-* or o-series), drop non-chat families.
  return ids.filter((id) => {
    const low = id.toLowerCase();
    if (OPENAI_EXCLUDE.some((x) => low.includes(x))) return false;
    return low.startsWith('gpt') || /^o[0-9]/.test(low) || low.startsWith('chatgpt');
  });
}
