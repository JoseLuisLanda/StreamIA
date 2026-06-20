/**
 * Assistant document SCHEMA VERSIONING + ordered migrations.
 *
 * Problem this solves: documents created before a field existed (e.g. `alexia`
 * predates `useCustomResponses`) lack that field, so resolvers fell back to
 * hardcodes. Instead of scattering "if field missing" checks everywhere, every
 * assistant doc carries `schemaVersion`; on read we apply the ordered migration
 * steps from the doc's version up to ASSISTANT_SCHEMA_VERSION, filling defaults.
 *
 * HOW TO ADD A FUTURE FIELD:
 *   1. Bump ASSISTANT_SCHEMA_VERSION.
 *   2. Append a MigrationStep whose `to` is the new version and whose `apply`
 *      fills the new field's default on an old doc (mutating `d` in place).
 *   3. Set the field on new docs in AssistantConfigService.save (it stamps the
 *      current version). Old docs self-heal on load (lazy write-back) and via the
 *      one-time backfillAssistants callable.
 */

/** Current assistant schema version. Bump when adding a migrated field. */
export const ASSISTANT_SCHEMA_VERSION = 4;

export interface MigrationStep {
  /** The version this step upgrades a doc TO. */
  to: number;
  /** Fill defaults for fields introduced at `to` (mutate `d` in place). */
  apply: (d: any) => void;
}

/**
 * Ordered steps. v0/v1 (pre-versioning) -> v2 adds `useCustomResponses` (so old
 * assistants inherit the global default responses) and ensures `contentModifiedAt`.
 */
export const ASSISTANT_MIGRATIONS: MigrationStep[] = [
  {
    to: 2,
    apply: (d) => {
      if (!d.useCustomResponses || typeof d.useCustomResponses !== 'object') {
        d.useCustomResponses = {
          greetings: false,
          infoAcknowledgements: false,
          farewells: false,
          suggestedPrompts: false,
        };
      }
      if (d.contentModifiedAt == null) d.__needsContentModified = true; // service stamps serverTimestamp
    },
  },
  {
    // v3 adds the capabilities/purpose flag (false => inherit the global default
    // capabilities config). The capabilities map itself is optional/absent until set.
    to: 3,
    apply: (d) => {
      if (!d.useCustomResponses || typeof d.useCustomResponses !== 'object') d.useCustomResponses = {};
      if (d.useCustomResponses.capabilities !== true) d.useCustomResponses.capabilities = false;
    },
  },
  {
    // v4 adds per-stage LLM profile overrides (summary/detail). null => unset =>
    // fall back to the global default (config/ragModels) then legacy profile.
    to: 4,
    apply: (d) => {
      if (d.summaryProfileId === undefined) d.summaryProfileId = null;
      if (d.detailProfileId === undefined) d.detailProfileId = null;
    },
  },
];

export interface MigrationResult {
  data: any;
  changed: boolean;
  fromVersion: number;
}

/**
 * Apply all migration steps newer than the doc's schemaVersion. Returns a NEW
 * object (does not mutate the input) plus whether anything changed.
 */
export function migrateAssistantData(raw: any): MigrationResult {
  const d = { ...(raw ?? {}) };
  const fromVersion = Number(d.schemaVersion ?? 0);
  let changed = false;
  for (const step of ASSISTANT_MIGRATIONS) {
    if (fromVersion < step.to) {
      step.apply(d);
      changed = true;
    }
  }
  if (changed) d.schemaVersion = ASSISTANT_SCHEMA_VERSION;
  return { data: d, changed, fromVersion };
}
