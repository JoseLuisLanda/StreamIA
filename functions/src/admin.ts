/**
 * Firebase Admin initialization -- CONSOLIDATED on `strimearia`.
 *
 * When the Function runs INSIDE the strimearia project, initializeApp() with no
 * args uses the project's DEFAULT credentials (the Cloud Functions runtime
 * service account) and infers projectId = strimearia. No cross-project
 * service-account key is needed (this reverts the earlier terapia-4bb02 setup).
 *
 * We set storageBucket explicitly so getStorage().bucket() resolves the
 * strimearia bucket without relying on env defaults.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

export const STORAGE_BUCKET = 'strimearia.firebasestorage.app';

if (!getApps().length) {
  initializeApp({
    // Default credentials + projectId are inferred from the runtime (strimearia).
    storageBucket: STORAGE_BUCKET,
  });
}

/** Firestore (default database) in strimearia. */
export const db = getFirestore();

/** Default Storage bucket (strimearia). */
export const bucket = getStorage().bucket();
