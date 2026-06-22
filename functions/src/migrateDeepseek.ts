/**
 * One-shot migration of the retiring DeepSeek aliases (strimearia) -- Admin SDK.
 *
 * DeepSeek retires the `deepseek-chat` and `deepseek-reasoner` aliases on
 * 2026-07-24 15:59 UTC; after that, API calls using those names error. Both now
 * route to V4 Flash, so this callable rewrites the configured model string in
 * every llm_profiles/{id} doc:
 *   deepseek-chat     -> deepseek-v4-flash   (non-thinking)
 *   deepseek-reasoner -> deepseek-v4-flash   (thinking mode; reasoner maps to FLASH, NOT Pro)
 *
 * This is a model-STRING change only: same provider, base URL and API key. The
 * OpenAI-compatible provider (lib/llm-providers/openai.ts) passes the model id
 * straight through, so no call-logic change is needed to send the new id.
 *
 * Idempotent: re-running finds nothing to change. Pass { dryRun: true } to report
 * what WOULD change without writing. Admin-gated (mirrors the other callables).
 *
 * NOTE: the per-assistant model is stored in llm_profiles/{id}.model;
 * assistants/{id} and config/ragModels only hold profile IDs (no model strings),
 * so this collection is the only place the alias lives in Firestore.
 */
import { onCall } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './admin';
import { assertSignedIn, assertAdmin } from './lib/auth';
import { ENFORCE_ADMIN_ROLE } from './lib/flags';

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

/** Retiring alias -> non-retiring id. */
const ALIAS_MAP: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
};

interface ChangedProfile { id: string; from: string; to: string; }

export const migrateDeepseekAliases = onCall<
  { dryRun?: boolean },
  Promise<{ changed: ChangedProfile[]; scanned: number; dryRun: boolean }>
>(
  CALL_OPTS,
  async (req): Promise<{ changed: ChangedProfile[]; scanned: number; dryRun: boolean }> => {
    assertSignedIn(req.auth);
    if (ENFORCE_ADMIN_ROLE) await assertAdmin(req.auth);
    const dryRun = req.data?.dryRun === true;

    const snap = await db.collection('llm_profiles').get();
    const changed: ChangedProfile[] = [];
    for (const d of snap.docs) {
      const model = (d.get('model') ?? '').toString();
      const to = ALIAS_MAP[model];
      if (!to) continue;
      changed.push({ id: d.id, from: model, to });
      if (!dryRun) {
        await d.ref.update({ model: to, updatedAt: FieldValue.serverTimestamp() });
      }
    }
    logger.info('migrateDeepseekAliases', {
      by: req.auth?.uid, dryRun, scanned: snap.size, changed: changed.length,
    });
    return { changed, scanned: snap.size, dryRun };
  },
);
