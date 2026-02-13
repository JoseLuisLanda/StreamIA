import { FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { Auth, getAuth } from 'firebase/auth';
import { FirebaseStorage, getStorage } from 'firebase/storage';
import { firebaseClientConfig, isFirebaseClientConfigReady } from '../firebase.config';

let cachedApp: FirebaseApp | null = null;

export function getFirebaseApp(): FirebaseApp {
  if (cachedApp) {
    return cachedApp;
  }

  if (!isFirebaseClientConfigReady(firebaseClientConfig)) {
    throw new Error('Firebase client config is not set. Fill src/app/firebase.config.ts first.');
  }

  cachedApp = getApps().length > 0 ? getApp() : initializeApp(firebaseClientConfig);
  return cachedApp;
}

export function getFirebaseAuth(): Auth {
  return getAuth(getFirebaseApp());
}

export function getFirebaseStorageClient(): FirebaseStorage {
  return getStorage(getFirebaseApp());
}
