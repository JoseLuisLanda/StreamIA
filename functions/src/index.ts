/**
 * Cloud Functions entry point (strimearia).
 *
 * Exports:
 *   - `ingestDocument` (callable): PDF -> chunks -> embeddings.
 *   - `api` (HTTP Express router): mounts POST /chatRag (body-only RAG).
 *
 * Both run in the consolidated strimearia project (Admin SDK default creds,
 * bucket strimearia.firebasestorage.app). See FUNCTIONS_README.md.
 */
import './admin'; // initialize Admin SDK (default creds, strimearia) on cold start

export { ingestDocument } from './ingestDocument';
export { api } from './api';
export { setLlmApiKey, testLlmConnection } from './llmAdmin';
export { bootstrapFirstAdmin, setUserRole, listUsers } from './roleAdmin';
export {
  saveLlmProfile,
  deleteLlmProfile,
  setLlmProfileKey,
  setActiveLlmKey,
  deleteLlmProfileKey,
  setSystemDefaultProfile,
  testLlmProfile,
  migrateLegacyLlmConfig,
} from './llmProfiles';
export { generateResponses } from './generateResponses';
export { backfillAssistants } from './backfill';
export { listProviderModels } from './listProviderModels';
export { listNamespaces, createNamespace, deleteNamespace } from './ragNamespaces';
export { getPricing, updatePricingRate, projectAssistantCost } from './costing';
export { migrateDeepseekAliases } from './migrateDeepseek';
export { allocateQuota, getQuota, resetQuotaPeriod } from './quotaAdmin';
