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
   * DEV-PHASE GATING (mirror of the Functions ENFORCE_ADMIN_ROLE flag).
   * false (now): adminGuard allows ANY signed-in user (still redirects to /login
   *   when signed out). true (before production): restores admin-only.
   */
  enforceAdminRole: false,

  /** Local dev only: route all Firebase SDK calls to local emulators. */
  useEmulators: false,
  emulatorHost: 'localhost',
};
