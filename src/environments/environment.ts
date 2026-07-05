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

  /**
   * Google Maps JavaScript API (feature /ar-assistant). BROWSER key -- the ONLY
   * key permitted in the client, and it MUST be restricted by HTTP referrer in
   * Google Cloud Console (see docs/AR_CONTENT_MANAGER_README.md). All other
   * keys stay in Secret Manager. Loaded dynamically ONLY on routes that use it
   * (google-maps-loader.service).
   */
  googleMapsApiKey: 'AIzaSyCuiVBBR4Mbpf667IdzXR5QqcUq5p0bOH4',
  /** Map ID (dark style) required by AdvancedMarkerElement. Empty = classic
   *  Marker fallback in the location picker. */
  googleMapsMapId: '2434a899ce8a8790684f7b33',

  /** GPS mode: max distance (m) at which tapping a beacon opens the content
   *  preview (FASE 3 reuses it for pin highlighting / announceNearby). */
  proximityThresholdMeters: 30,
};
