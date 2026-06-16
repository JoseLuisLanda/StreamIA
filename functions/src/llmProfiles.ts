/**
 * LLM config PROFILE management callables (admin-gated). Key VALUES live only in
 * Secret Manager; Firestore holds profile + LlmKeyRef metadata.
 *
 *   saveLlmProfile        create/update profile metadata (NOT keys/secrets)
 *   deleteLlmProfile      delete profile + all its key secrets
 *   setLlmProfileKey      add/replace a labeled key (writes Secret Manager + ref)
 *   setActiveLlmKey       metadata-only: choose the active key
 *   deleteLlmProfileKey   delete a key (secret + ref)
 *   setSystemDefaultProfile  mark one GLOBAL profile as system default
 *   testLlmProfile        tiny generation with the profile's active key
 *   migrateLegacyLlmConfig  one-time: config/llm -> a default global profile
 */
import { randomUUID } from 'crypto';
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';
import { VALID_PROVIDERS, LlmProviderId, loadLlmConfig } from './lib/llm-config';
import {
  PROFILES_COL,
  LlmConfigProfile,
  LlmKeyRef,
  loadProfile,
} from './lib/llm-profiles';
import { writeSecret, probeSecret, deleteSecret, profileSecretName } from './lib/secrets';
import { generateFromProfile } from './lib/llm';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

async function authorize(req: CallableRequest<unknown>): Promise<string> {
  const uid = assertSignedIn(req.auth);
  if (ENFORCE_ADMIN_ROLE) await assertAdmin(req.auth);
  return uid;
}

// ----------------------------------------------------------------- saveProfile

interface SaveProfileReq {
  id?: string;
  name: string;
  scope: 'global' | 'assistant';
  ownerAssistantId?: string;
  provider: LlmProviderId;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  topP?: number;
  baseUrl?: string;
}

export const saveLlmProfile = onCall<SaveProfileReq, Promise<{ id: string }>>(
  CALL_OPTS,
  async (req): Promise<{ id: string }> => {
    await authorize(req);
    const d = req.data;
    if (!d?.name?.trim()) throw new HttpsError('invalid-argument', 'Profile name is required.');
    if (!VALID_PROVIDERS.includes(d.provider)) {
      throw new HttpsError('invalid-argument', 'Unknown provider.');
    }
    const scope = d.scope === 'assistant' ? 'assistant' : 'global';
    if (scope === 'assistant' && !d.ownerAssistantId?.trim()) {
      throw new HttpsError('invalid-argument', 'A private profile requires ownerAssistantId.');
    }

    const id = (d.id || '').trim() || db.collection(PROFILES_COL).doc().id;
    const ref = db.collection(PROFILES_COL).doc(id);

    // Write ONLY non-key fields (merge) so existing keys are preserved. New docs
    // start with keys: [] (set via setLlmProfileKey).
    const exists = (await ref.get()).exists;
    const payload: any = {
      name: d.name.trim(),
      scope,
      ownerAssistantId: scope === 'assistant' ? d.ownerAssistantId!.trim() : null,
      provider: d.provider,
      model: (d.model || '').trim(),
      temperature: Number(d.temperature),
      maxOutputTokens: Number(d.maxOutputTokens),
      topP: d.topP == null ? null : Number(d.topP),
      baseUrl: d.baseUrl?.trim() || null,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!exists) {
      payload.keys = [];
      payload.isSystemDefault = false;
      payload.createdAt = FieldValue.serverTimestamp();
    }
    await ref.set(payload, { merge: true });
    return { id };
  },
);

// --------------------------------------------------------------- deleteProfile

export const deleteLlmProfile = onCall<{ id: string }, Promise<{ ok: true }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true }> => {
    await authorize(req);
    const id = (req.data?.id || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'id is required.');
    const p = await loadProfile(id);
    if (p) {
      for (const k of p.keys) {
        await deleteSecret(k.secretName).catch((e) =>
          logger.warn('deleteLlmProfile: secret delete failed', { secret: k.secretName, error: String(e) }),
        );
      }
    }
    await db.collection(PROFILES_COL).doc(id).delete();
    return { ok: true };
  },
);

// --------------------------------------------------------------- setProfileKey

interface SetKeyReq {
  profileId: string;
  keyId?: string; // replace this key's value; omit to add a new labeled key
  label: string;
  key: string;
}

export const setLlmProfileKey = onCall<SetKeyReq, Promise<{ ok: true; keyId: string }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true; keyId: string }> => {
    await authorize(req);
    const { profileId } = req.data ?? ({} as SetKeyReq);
    const label = (req.data?.label || '').trim();
    const key = (req.data?.key || '').trim();
    if (!profileId) throw new HttpsError('invalid-argument', 'profileId is required.');
    if (!label) throw new HttpsError('invalid-argument', 'A key label is required.');
    if (!key || key.length < 8) throw new HttpsError('invalid-argument', 'API key looks invalid.');

    const keyId = (req.data?.keyId || '').trim() || randomUUID();
    const secretName = profileSecretName(profileId, keyId);

    try {
      await writeSecret(secretName, key);
      await probeSecret(secretName); // verify read-back (separate IAM perm)
    } catch (e: any) {
      logger.error('setLlmProfileKey: secret write/read failed', { secretName, error: String(e?.message ?? e) });
      throw new HttpsError(
        'failed-precondition',
        `Could not store/read the key in Secret Manager: ${e?.message ?? e}. ` +
          'Grant the runtime service account roles/secretmanager.admin and enable the API.',
      );
    }

    // Update the profile's keys array in a transaction (add or replace ref).
    await db.runTransaction(async (tx) => {
      const ref = db.collection(PROFILES_COL).doc(profileId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Profile not found.');
      const data = snap.data() as any;
      const keys: LlmKeyRef[] = Array.isArray(data.keys) ? data.keys : [];
      const now = Date.now();
      const idx = keys.findIndex((k) => k.id === keyId);
      const refObj: LlmKeyRef = {
        id: keyId,
        label,
        secretName,
        active: idx >= 0 ? keys[idx].active : keys.length === 0, // first key becomes active
        updatedAt: now,
      };
      if (idx >= 0) keys[idx] = refObj;
      else keys.push(refObj);
      // Ensure at least one active.
      if (!keys.some((k) => k.active) && keys.length) keys[0].active = true;
      tx.set(ref, { keys, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });

    return { ok: true, keyId };
  },
);

// --------------------------------------------------------------- setActiveKey

export const setActiveLlmKey = onCall<{ profileId: string; keyId: string }, Promise<{ ok: true }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true }> => {
    await authorize(req);
    const { profileId, keyId } = req.data ?? ({} as any);
    if (!profileId || !keyId) throw new HttpsError('invalid-argument', 'profileId and keyId are required.');
    await db.runTransaction(async (tx) => {
      const ref = db.collection(PROFILES_COL).doc(profileId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Profile not found.');
      const keys: LlmKeyRef[] = (snap.data() as any).keys ?? [];
      if (!keys.some((k) => k.id === keyId)) throw new HttpsError('not-found', 'Key not found.');
      for (const k of keys) k.active = k.id === keyId;
      tx.set(ref, { keys, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    return { ok: true };
  },
);

// --------------------------------------------------------------- deleteKey

export const deleteLlmProfileKey = onCall<{ profileId: string; keyId: string }, Promise<{ ok: true }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true }> => {
    await authorize(req);
    const { profileId, keyId } = req.data ?? ({} as any);
    if (!profileId || !keyId) throw new HttpsError('invalid-argument', 'profileId and keyId are required.');
    let secretToDelete = '';
    await db.runTransaction(async (tx) => {
      const ref = db.collection(PROFILES_COL).doc(profileId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Profile not found.');
      const keys: LlmKeyRef[] = (snap.data() as any).keys ?? [];
      const target = keys.find((k) => k.id === keyId);
      if (!target) throw new HttpsError('not-found', 'Key not found.');
      secretToDelete = target.secretName;
      const remaining = keys.filter((k) => k.id !== keyId);
      if (target.active && remaining.length) remaining[0].active = true; // promote next
      tx.set(ref, { keys: remaining, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    if (secretToDelete) {
      await deleteSecret(secretToDelete).catch((e) =>
        logger.warn('deleteLlmProfileKey: secret delete failed', { secret: secretToDelete, error: String(e) }),
      );
    }
    return { ok: true };
  },
);

// --------------------------------------------------------------- systemDefault

export const setSystemDefaultProfile = onCall<{ id: string }, Promise<{ ok: true }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: true }> => {
    await authorize(req);
    const id = (req.data?.id || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'id is required.');
    const target = await loadProfile(id);
    if (!target) throw new HttpsError('not-found', 'Profile not found.');
    if (target.scope !== 'global') {
      throw new HttpsError('failed-precondition', 'Only a GLOBAL profile can be the system default.');
    }
    // Unset others, set this one (batched).
    const globals = await db.collection(PROFILES_COL).where('scope', '==', 'global').get();
    const batch = db.batch();
    globals.docs.forEach((doc) => {
      batch.set(doc.ref, { isSystemDefault: doc.id === id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    await batch.commit();
    return { ok: true };
  },
);

// --------------------------------------------------------------- testProfile

interface TestRes {
  ok: boolean;
  provider?: string;
  model?: string;
  key?: string;
  sample?: string;
  error?: string;
}

export const testLlmProfile = onCall<{ profileId: string }, Promise<TestRes>>(
  CALL_OPTS,
  async (req): Promise<TestRes> => {
    await authorize(req);
    const id = (req.data?.profileId || '').trim();
    const p = id ? await loadProfile(id) : null;
    if (!p) return { ok: false, error: 'Profile not found.' };
    try {
      const r = await generateFromProfile(
        p,
        'Responde exactamente: OK',
        'Esta es una prueba de conexion. Responde OK.',
        'es',
      );
      return { ok: true, provider: r.provider, model: r.model, key: r.key, sample: r.text.slice(0, 120) };
    } catch (e: any) {
      const meta = e?.meta ?? {};
      return { ok: false, provider: meta.provider, model: meta.model, key: meta.key, error: e?.message ?? String(e) };
    }
  },
);

// --------------------------------------------------------------- migration

export const migrateLegacyLlmConfig = onCall<unknown, Promise<{ ok: boolean; profileId?: string; message: string }>>(
  CALL_OPTS,
  async (req): Promise<{ ok: boolean; profileId?: string; message: string }> => {
    await authorize(req);

    // Skip if any global profile already exists.
    const existing = await db.collection(PROFILES_COL).where('scope', '==', 'global').limit(1).get();
    if (!existing.empty) {
      return { ok: false, message: 'Global profiles already exist; migration skipped.' };
    }
    const legacy = await loadLlmConfig();
    if (!legacy) {
      return { ok: false, message: 'No legacy config/llm found; nothing to migrate.' };
    }

    // Reuse the EXISTING secret (llm-key-<provider>) as the active labeled key, so
    // no key re-entry is needed.
    const legacySecret = `llm-key-${legacy.provider}`;
    const profileId = db.collection(PROFILES_COL).doc().id;
    const key: LlmKeyRef = {
      id: randomUUID(),
      label: 'Migrada (config/llm)',
      secretName: legacySecret,
      active: true,
      updatedAt: Date.now(),
    };
    const profile: Partial<LlmConfigProfile> & any = {
      name: `${legacy.provider} (migrado)`,
      scope: 'global',
      ownerAssistantId: null,
      provider: legacy.provider,
      model: legacy.model,
      temperature: legacy.temperature,
      maxOutputTokens: legacy.maxOutputTokens,
      topP: legacy.topP ?? null,
      baseUrl: legacy.baseUrl ?? null,
      keys: [key],
      isSystemDefault: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    await db.collection(PROFILES_COL).doc(profileId).set(profile);
    logger.info('migrateLegacyLlmConfig: created default profile', { profileId, provider: legacy.provider });
    return { ok: true, profileId, message: 'Migrated config/llm into a default global profile.' };
  },
);
