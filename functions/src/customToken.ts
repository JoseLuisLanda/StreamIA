/**
 * Custom-token mint (strimearia) -- bridges a NATIVE Firebase Auth session into
 * the WebView's WEB Firebase Auth session for SSO.
 *
 * The Flutter app signs in ONCE natively. This callable runs with the caller's
 * already-verified ID token (the callable runtime verifies it and populates
 * req.auth), and returns a short-lived custom token. The embedded StreamIA
 * WebView then calls signInWithCustomToken(token) so the avatar is authenticated
 * WITHOUT a second login. No secrets are handled here; the Admin SDK uses the
 * runtime service account (see admin.ts).
 *
 * A Firebase ID token cannot be used with signInWithCustomToken -- hence the
 * mint step (createCustomToken -> signInWithCustomToken).
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { getAuth } from 'firebase-admin/auth';
import './admin'; // ensure Admin SDK is initialized for strimearia on cold start

const CALL_OPTS = { region: 'us-central1', cors: true } as const;

interface MintResponse {
  token: string;
}

export const mintWebViewToken = onCall<unknown, Promise<MintResponse>>(
  CALL_OPTS,
  async (req: CallableRequest<unknown>): Promise<MintResponse> => {
    // req.auth is present only when the client called with a valid ID token.
    const uid = req.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', 'Sign-in required to mint a token.');
    }

    // The minted token reuses the SAME uid, so the web session loads the same
    // account (email/displayName included) -- no extra claims needed.
    const token = await getAuth().createCustomToken(uid);
    logger.info('mintWebViewToken: minted', { uid });
    return { token };
  },
);
