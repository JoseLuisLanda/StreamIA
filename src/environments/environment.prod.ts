/**
 * Production environment. Swapped in for environment.ts at build time via the
 * `fileReplacements` entry in angular.json (production configuration).
 * Consolidated on the `strimearia` project -- see environment.ts for details.
 */
export const environment = {
  production: true,

  ragApiBase: 'https://us-central1-strimearia.cloudfunctions.net/api',
  ragChatPath: '/chatRag',
  ragMediaBucket: '',
  functionsRegion: 'us-central1',
  // Admin claim is now provisioned -> enforce real role validation (the guard
  // checks the `role:'admin'` claim / admins allowlist; non-admins are redirected).
  enforceAdminRole: true,
  useEmulators: false,
  emulatorHost: 'localhost',
};
