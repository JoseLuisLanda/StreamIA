import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { Auth, connectAuthEmulator, getAuth } from 'firebase/auth';
import { Firestore, connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { Functions, connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { FirebaseStorage, connectStorageEmulator, getStorage } from 'firebase/storage';
import { environment } from '../../environments/environment';
import { firebaseClientConfig, isFirebaseClientConfigReady } from '../firebase.config';

let cachedApp: FirebaseApp | null = null;
let emulatorsConnected = false;

export function getFirebaseApp(): FirebaseApp {
  if (cachedApp) {
    return cachedApp;
  }

  if (!isFirebaseClientConfigReady(firebaseClientConfig)) {
    throw new Error('Firebase client config is not set. Fill src/app/firebase.config.ts first.');
  }

  cachedApp = getApps().length > 0 ? getApp() : initializeApp(firebaseClientConfig);
  maybeConnectEmulators(cachedApp);
  return cachedApp;
}

/**
 * Local development against the Firebase Emulator Suite.
 *
 * When environment.useEmulators is true, all SDK calls (Auth, Firestore,
 * Functions, Storage) are pointed at localhost emulators. This removes the CORS /
 * public-invoker problem entirely for local dev: the browser talks to local
 * emulator ports instead of the deployed Cloud Functions. Run them with:
 *   cd functions && npm run build && firebase emulators:start
 * Requires Application Default Credentials if the functions call Vertex AI:
 *   gcloud auth application-default login
 */
function maybeConnectEmulators(app: FirebaseApp): void {
  if (emulatorsConnected || !environment.useEmulators) return;
  emulatorsConnected = true;
  const host = environment.emulatorHost || 'localhost';
  try {
    connectAuthEmulator(getAuth(app), `http://${host}:9099`, { disableWarnings: true });
  } catch { /* already connected */ }
  try {
    connectFirestoreEmulator(getFirestore(app), host, 8080);
  } catch { /* already connected */ }
  try {
    connectFunctionsEmulator(getFunctions(app, environment.functionsRegion || 'us-central1'), host, 5001);
  } catch { /* already connected */ }
  try {
    connectStorageEmulator(getStorage(app), host, 9199);
  } catch { /* already connected */ }
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

export function getFirebaseStorageClient(): FirebaseStorage {
  return getStorage(getFirebaseApp());
}

/** Firestore client for the consolidated app project (strimearia). */
export function getFirebaseFirestoreClient(): Firestore {
  return getFirestore(getFirebaseApp());
}

/**
 * Callable Functions client for the app project.
 *
 * Region comes from environment.functionsRegion (default us-central1). The
 * Firebase Auth ID token is attached automatically by the SDK on every callable
 * invocation, so admin-only callables (e.g. ingestDocument) are authenticated
 * without manual header wiring.
 *
 * NOTE: a CORS error on a CALLABLE means the deployed function is not reachable
 * as a public (unauthenticated-invoker) endpoint -- deploy it and grant the
 * public invoker (see CORS_FIX.md). Auth is still enforced inside the function.
 */
export function getFirebaseFunctionsClient(): Functions {
  const region = environment.functionsRegion || 'us-central1';
  return getFunctions(getFirebaseApp(), region);
}

/**
 * Storage client targeting a SPECIFIC bucket.
 *
 * Consolidated on strimearia: environment.ragMediaBucket is normally '' so this
 * resolves the default app bucket (strimearia). Pass a gs:// bucket only to
 * target a different bucket. Empty bucket -> default app bucket.
 */
export function getStorageForBucket(bucket?: string): FirebaseStorage {
  const app = getFirebaseApp();
  return bucket ? getStorage(app, bucket) : getStorage(app);
}
