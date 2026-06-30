/**
 * SSO bridge for the EMBEDDED (Flutter InAppWebView) context.
 *
 * The Flutter host loads:  .../text-avatar?assistant=<id>#ct=<customToken>
 *
 * This reads a one-time custom token from the URL FRAGMENT (the part after '#'),
 * signs the web Firebase Auth session in with it (signInWithCustomToken), then
 * strips it from the URL so it does not linger in history. Run as an
 * APP_INITIALIZER it completes BEFORE the router/authGuard, so the avatar route
 * sees an authenticated user without a second login.
 *
 * Why the fragment (and not a query param):
 *  - The fragment is NEVER sent to a server (no access/proxy logs leak it).
 *  - It is available synchronously at bootstrap (no race with a postMessage
 *    listener that might not be registered yet in a freshly loaded WebView).
 *  - We delete it immediately (before any await) via history.replaceState, so it
 *    is single-use and does not persist in the visible URL or back/forward state.
 *
 * Normal browser use (no '#ct=') is a no-op, so the standard web login flow is
 * completely untouched.
 */
import { signInWithCustomToken } from 'firebase/auth';
import { getFirebaseAuth } from './firebase-client';

const CT_KEY = 'ct';

function readCustomTokenFromHash(): string | null {
  try {
    const hash = window.location.hash || '';
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!raw) return null;
    const token = new URLSearchParams(raw).get(CT_KEY);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function stripCustomTokenFromHash(): void {
  try {
    const hash = window.location.hash || '';
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    const params = new URLSearchParams(raw);
    params.delete(CT_KEY);
    const rest = params.toString();
    const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
    window.history.replaceState(null, '', url);
  } catch {
    /* ignore */
  }
}

/**
 * If a custom token is present in the URL fragment, sign in with it. Safe no-op
 * otherwise. Never throws (a failure falls through to the normal auth guard,
 * which routes to /login).
 */
export async function initWebViewSso(): Promise<void> {
  const token = readCustomTokenFromHash();
  if (!token) return; // normal web use -> no-op

  // Remove the token from the URL BEFORE awaiting, so it cannot be re-read or
  // persist if the sign-in below throws.
  stripCustomTokenFromHash();

  try {
    await signInWithCustomToken(getFirebaseAuth(), token);
  } catch (err) {
    console.error('[webview-sso] signInWithCustomToken failed', err);
    // Fall through: authGuard will redirect to /login if still unauthenticated.
  }
}
