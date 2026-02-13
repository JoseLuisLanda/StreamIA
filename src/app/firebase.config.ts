export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId?: string;
  appId: string;
  measurementId?: string;
}

export const firebaseClientConfig: FirebaseClientConfig = {
  apiKey: "AIzaSyCyUoJq3iB40xBpCtmN7TTIOqGvDniCVKA",
  authDomain: "strimearia.firebaseapp.com",
  projectId: "strimearia",
  storageBucket: "strimearia.firebasestorage.app",
  messagingSenderId: "51000864485",
  appId: "1:51000864485:web:39d9853a1cae6c0bc36e0c",
  measurementId: "G-0M9X5LH200"
};

export function isFirebaseClientConfigReady(config: FirebaseClientConfig): boolean {
  return Boolean(
    config.apiKey &&
      config.authDomain &&
      config.projectId &&
      config.storageBucket &&
      config.appId
  );
}
