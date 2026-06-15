/**
 * LLM Admin callables (strimearia). Key-based providers only (Vertex removed).
 *
 *   - setLlmApiKey({ provider, apiKey })   -> store key in Secret Manager
 *                                             (write-only; never returned).
 *   - testLlmConnection({ override? })      -> tiny generation against the
 *                                             configured (or overridden) provider;
 *                                             returns the REAL provider error.
 *
 * Auth: always require sign-in; require admin when ENFORCE_ADMIN_ROLE=true
 * (mirrors ingestDocument). Keys go to Secret Manager only -- the non-secret
 * status metadata (updatedAt/updatedBy) is written to config/llm so the UI can
 * show "key configured" without ever reading the key back.
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';
import {
  LlmConfig,
  LlmProviderId,
  VALID_PROVIDERS,
  DEFAULT_LLM_CONFIG,
  loadLlmConfig,
  writeApiKey,
  getApiKey,
  probeSecretAccess,
} from './lib/llm-config';
import { createProvider } from './lib/llm-providers/factory';
import { buildSystemPrompt, errMessage } from './lib/llm-providers/contract';

interface SetKeyRequest {
  provider: LlmProviderId;
  apiKey: string;
}
interface SetKeyResponse {
  ok: true;
  provider: LlmProviderId;
}

interface TestRequest {
  /** Optional ad-hoc config to test before saving (params/model/provider). */
  override?: Partial<LlmConfig>;
}
interface TestResponse {
  ok: boolean;
  provider: string;
  model: string;
  sample?: string;
  error?: string;
}

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

async function authorize(req: CallableRequest<unknown>): Promise<string> {
  const uid = assertSignedIn(req.auth);
  if (ENFORCE_ADMIN_ROLE) await assertAdmin(req.auth);
  return uid;
}

export const setLlmApiKey = onCall<SetKeyRequest, Promise<SetKeyResponse>>(
  CALL_OPTS,
  async (req): Promise<SetKeyResponse> => {
    const uid = await authorize(req);
    const provider = req.data?.provider;
    const apiKey = (req.data?.apiKey ?? '').trim();

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      throw new HttpsError('invalid-argument', 'Unknown provider.');
    }
    if (!apiKey || apiKey.length < 8) {
      throw new HttpsError('invalid-argument', 'API key looks invalid.');
    }

    try {
      await writeApiKey(provider, apiKey);
    } catch (e) {
      logger.error('setLlmApiKey: secret write failed', { provider, error: errMessage(e) });
      throw new HttpsError(
        'internal',
        `Could not store the key in Secret Manager: ${errMessage(e)}. ` +
          'Check the runtime service account has Secret Manager permissions ' +
          '(roles/secretmanager.admin) and the Secret Manager API is enabled.',
      );
    }

    // Verify the key is READABLE back (versions.access is a separate IAM perm from
    // versions.add). This is the exact gap that yields "saved OK but chatRag can't
    // find the key" -- fail loudly here instead of a false success.
    try {
      await probeSecretAccess(provider);
    } catch (e) {
      logger.error('setLlmApiKey: write succeeded but read-back failed', { provider, error: errMessage(e) });
      throw new HttpsError(
        'failed-precondition',
        `Key stored, but the runtime service account cannot READ it back: ${errMessage(e)}. ` +
          'Grant roles/secretmanager.secretAccessor (or roles/secretmanager.admin) to the ' +
          'Functions runtime service account, then save again.',
      );
    }

    // Non-secret status only (no key material) so the UI can show "configured".
    await db.collection('config').doc('llm').set(
      {
        keyStatus: {
          [provider]: { updatedAt: FieldValue.serverTimestamp(), updatedBy: uid },
        },
      },
      { merge: true },
    );

    logger.info('setLlmApiKey: stored', { provider, by: uid });
    return { ok: true, provider };
  },
);

export const testLlmConnection = onCall<TestRequest, Promise<TestResponse>>(
  CALL_OPTS,
  async (req): Promise<TestResponse> => {
    await authorize(req);

    const base = (await loadLlmConfig()) ?? DEFAULT_LLM_CONFIG;
    const config: LlmConfig = { ...base, ...(req.data?.override ?? {}) };
    if (!VALID_PROVIDERS.includes(config.provider)) {
      config.provider = DEFAULT_LLM_CONFIG.provider;
    }

    let apiKey = '';
    try {
      apiKey = await getApiKey(config.provider);
    } catch {
      apiKey = '';
    }
    if (!apiKey) {
      return {
        ok: false,
        provider: config.provider,
        model: config.model,
        error: `No API key configured for "${config.provider}". Save a key first.`,
      };
    }

    try {
      const provider = createProvider(config, apiKey);
      const sample = await provider.generateAnswer({
        query: 'Responde exactamente: OK',
        context: 'Esta es una prueba de conexion. Responde OK.',
        language: 'es',
        system: buildSystemPrompt('es'),
        params: { temperature: 0, maxOutputTokens: 16, topP: config.topP },
      });
      return { ok: true, provider: config.provider, model: config.model, sample: sample.slice(0, 120) };
    } catch (e) {
      // Return the REAL provider error so the admin can diagnose before relying on it.
      return { ok: false, provider: config.provider, model: config.model, error: errMessage(e) };
    }
  },
);
