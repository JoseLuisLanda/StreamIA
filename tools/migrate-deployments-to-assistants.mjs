/**
 * One-time Firestore migration: copy `deployments/*` -> `assistants/*`.
 *
 * The app was renamed from "deployments" to "assistants". Existing docs (if any)
 * must be copied to the new collection so the client + chatRag (which now read
 * `assistants/{id}`) find them. Idempotent: re-running overwrites assistants docs
 * with the same id. It does NOT delete the old `deployments` docs (do that
 * manually after verifying, since this environment can't delete safely).
 *
 * Run on your machine (project `strimearia`) with Application Default Creds:
 *   gcloud auth application-default login
 *   gcloud auth application-default set-quota-project strimearia
 *   cd tools && npm i firebase-admin      # if not already available
 *   node migrate-deployments-to-assistants.mjs
 *
 * If `deployments` is empty (only the STATIC_ASSISTANTS fallback was ever used),
 * this prints "nothing to migrate" and you're done -- the new code already reads
 * `assistants`.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GCLOUD_PROJECT || 'strimearia';

initializeApp({ credential: applicationDefault(), projectId: PROJECT });
const db = getFirestore();

const snap = await db.collection('deployments').get();
if (snap.empty) {
  console.log('nothing to migrate: `deployments` is empty.');
  process.exit(0);
}

let n = 0;
const batchSize = 400;
let batch = db.batch();
for (const doc of snap.docs) {
  batch.set(db.collection('assistants').doc(doc.id), doc.data(), { merge: true });
  if (++n % batchSize === 0) {
    await batch.commit();
    batch = db.batch();
  }
}
if (n % batchSize !== 0) await batch.commit();

console.log(`migrated ${n} doc(s): deployments/* -> assistants/*`);
console.log('Verify assistants/* in the console, then delete the old deployments/* docs manually.');
process.exit(0);
