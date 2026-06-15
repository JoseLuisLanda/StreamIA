/**
 * Default (development) environment -- CONSOLIDATED on the `strimearia` project.
 *
 * Client, Cloud Functions, Firestore, Storage and Auth all live in `strimearia`.
 *   - ragApiBase points at strimearia's HTTP `api` router (chatRag).
 *   - ragMediaBucket is '' so media resolves from the default app bucket.
 *   - ingestDocument callable is invoked by name (only its region matters).
 *
 * useEmulators: set true to develop fully locally against the Firebase Emulator
 * Suite (no cloud CORS / public-invoker needed). See CORS_FIX.md.
 */
export const environment = {
  production: false,

  /** Base URL of the strimearia HTTP Express router (chatRag is mounted on it). */
  ragApiBase: 'https://us-central1-strimearia.cloudfunctions.net/api',

  /** Route where chatRag is mounted on the router. */
  ragChatPath: '/chatRag',

  /** RAG media bucket. EMPTY = default app bucket (strimearia) via getStorage(app). */
  ragMediaBucket: '',

  /** Region of strimearia's callable Functions (ingestDocument) + HTTP api. */
  functionsRegion: 'us-central1',

  /**
   * ADMIN-ROLE GATING (mirror of the Functions ENFORCE_ADMIN_ROLE flag).
   * true (now): adminGuard validates the real `role:'admin'` custom claim /
   *   admins allowlist (your account is provisioned). Non-admins are redirected.
   * false: dev bypass -- any signed-in user passes (no claim required).
   */
  enforceAdminRole: true,

  /** Local dev only: route all Firebase SDK calls to local emulators. */
  useEmulators: false,
  emulatorHost: 'localhost',
};
