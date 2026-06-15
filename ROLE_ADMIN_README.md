# Role Admin — assign/revoke `admin` from the UI

Adds a `/role-admin` module to grant/revoke the `admin` custom claim without
scripts, a safe first-admin bootstrap, a `users/{uid}` registry for listing, and
confirms the dev access story (flag + Storage rules). Additive only.

## The authority model (what actually grants admin)

`admin` status is the Firebase Auth **custom claim** `role === 'admin'` (we also
set `admin: true`) PLUS a mirror doc `admins/{uid}`. Both are written ONLY
server-side by the role callables (Admin SDK, which bypasses security rules). The
`users/{uid}.role` field and the client `AdminService` are conveniences/UX — they
never grant privilege on their own. Firestore/Storage rules and the callables are
the real boundary.

A claim change takes effect only after the affected user's **ID token refreshes**
— sign out/in, or wait up to ~1 hour. The UI says this after every change, and
the client force-refreshes the token when the change targets the current user.

## 1. Bootstrap the first admin (one-time)

Chicken-and-egg: granting admin needs the Admin SDK, and the panel needs admin —
but nobody is admin yet. `bootstrapFirstAdmin` solves it safely:

- It grants the **caller** the admin claim ONLY if no admin exists yet
  (`admins/*` is empty), or the caller's email is on the optional
  `BOOTSTRAP_ADMIN_EMAILS` allowlist (Functions env). Once an admin exists and the
  caller isn't on the allowlist, it refuses — no arbitrary self-grant after setup.

Exact one-time step:

1. Deploy functions + rules: `firebase deploy --only functions,firestore:rules`.
2. (Recommended) set the allowlist so only your email can ever bootstrap:
   `firebase functions:secrets:set` is for secrets; for this simple allowlist use
   an env var at deploy, e.g. add `BOOTSTRAP_ADMIN_EMAILS=you@example.com` to
   `functions/.env` (or `--set-env-vars`). If left empty, bootstrap is allowed for
   any signed-in caller *only while no admin exists*.
3. Sign in as your account, open `/role-admin`, click **"Convertirme en el primer
   admin"** (shown because you're not admin yet). It calls `bootstrapFirstAdmin`.
4. Sign out and back in (token refresh) — you're now admin. Reload `/role-admin`;
   the user list loads and you can grant/revoke others.

## 2. Role callables (Admin SDK, server-side)

- `setUserRole({ uid?, email?, role })` — **always admin-only** (`assertAdmin`,
  never relaxed by the dev flag). Sets/clears the claim via
  `setCustomUserClaims`, mirrors `admins/{uid}` and `users/{uid}.role`. Accepts a
  uid or an email (resolved via `getUserByEmail`). Refuses to revoke the last
  remaining admin.
- `listUsers()` — admin-only; returns the Firestore `users/` registry (not the
  broad Admin SDK `listUsers()`), cross-checked against `admins/*` for the role.
- `bootstrapFirstAdmin()` — the gated one-time path above.

All exported from `functions/src/index.ts`.

## 3. `users/{uid}` registry

`AuthService` upserts `users/{uid}` (`email`, `lastLogin`) on every sign-in, so
the panel can list real users. It does NOT write `role` (that's authoritative only
via the claim/admins doc), so a self-write can't escalate. Firestore rule
(`users/{uid}`): dev = signed-in read + self-write; the commented PROD line
switches read to admin-only.

## 4. Role Admin UI (`/role-admin`)

Dark/purple theme, linked from the Admin Hub card and the admin top-navs, gated by
`enforceAdminRole` for route access. Features: user list (email/uid/role), filter
by email, per-user grant/revoke, "add by email", the bootstrap panel when you're
not admin yet, and the token-refresh note after changes.

## 5. Storage friction — already aligned, just redeploy

`storage.rules` is already dev-permissive: `avatars/models`, `avatars/thumbnails`,
`rag-media`, `rag-docs` allow **signed-in** writes (no admin claim required in
dev), matching Firestore + the `enforceAdminRole=false` posture. If you were
still blocked uploading GLB/PDF/media, the cause is almost certainly **stale
DEPLOYED rules** (an older admin-claim version). Fix:

```
firebase deploy --only storage,firestore:rules
```

PROD versions (admin-claim writes) are preserved in comments in both rules files.

## 6. Flag confirmation

`enforceAdminRole` is `false` in `src/environments/environment.ts`, and
`adminGuard` reads it: when off, any signed-in user passes the route guard (no
admin needed). The Functions mirror `ENFORCE_ADMIN_ROLE` defaults to `false`
unless set. So with the flag off, dev access is reliably open; the only
always-admin surface is the role callables themselves (by design) — for which the
bootstrap path exists.

## Production hardening (when ready)

1. Provision admins via `/role-admin` (claims persist across the flip).
2. Set `enforceAdminRole: true` (client `environment.ts`) and
   `ENFORCE_ADMIN_ROLE=true` (Functions env).
3. Restore the PROD (admin-claim) blocks in `firestore.rules` and `storage.rules`
   (replace the DEV blocks with the commented PROD lines).
4. Set `BOOTSTRAP_ADMIN_EMAILS` (or rely on "an admin already exists" → bootstrap
   refuses).
5. `firebase deploy --only functions,firestore:rules,storage` and `ng build`.

## Known limitations

- Build/deploy run locally (Windows node_modules, GCP creds); not runnable here.
- The user list shows accounts that have signed in at least once (registry-based).
- Claim changes need a token refresh to take effect (surfaced in the UI).
