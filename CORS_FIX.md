# Fixing the "CORS / No Access-Control-Allow-Origin" error on ingestDocument

## What the error actually means
```
Access to fetch at 'https://us-central1-strimearia.cloudfunctions.net/ingestDocument'
from origin 'http://localhost:4200' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```
`ingestDocument` is a Firebase **callable** function. Callables handle CORS
automatically *when the request reaches the function*. "No Access-Control-Allow-Origin
on the preflight" means the browser's preflight `OPTIONS` was rejected **before**
reaching your code -- i.e. the deployed Cloud Run service returned a 403/404 with no
CORS headers. So this is NOT a frontend bug. One of these is true:

1. `ingestDocument` is **not deployed** (only `api`/`chatRag` was), or the deploy failed.
2. It is deployed but **not publicly invokable** (no `allUsers` Cloud Run Invoker),
   so the unauthenticated preflight is refused.

(The "error / internal" status you saw on the document is the callable SDK throwing
`functions/internal` because the request never completed -- consistent with the above.)

The app still enforces auth: `ingestDocument` checks `assertSignedIn(request.auth)`
inside the function, so making the endpoint publicly *invokable* does not make it
publicly *usable* -- unauthenticated callers are rejected by the code.

---

## Fix A (recommended): deploy + make the callable public

Run on your machine with the strimearia project active:

```bash
# 0) make sure required Google APIs are enabled (first time only)
gcloud config set project strimearia
gcloud services enable \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com aiplatform.googleapis.com eventarc.googleapis.com

# 1) build + deploy BOTH functions
firebase use strimearia
cd functions && npm install && npm run build && cd ..
firebase deploy --only functions
# confirm the output lists BOTH:  ingestDocument(us-central1)  and  api(us-central1)
```

`firebase deploy` normally grants the public invoker to callable/HTTPS functions
automatically. If the CORS error persists after a successful deploy, grant it
explicitly (Gen2 = Cloud Run):

```bash
gcloud functions add-invoker-policy-binding ingestDocument \
  --region=us-central1 --member=allUsers
gcloud functions add-invoker-policy-binding api \
  --region=us-central1 --member=allUsers
```

Then hard-refresh localhost:4200 and retry "Ingest".

> If `add-invoker-policy-binding` is refused with a "domain restricted sharing"
> org-policy error, your account blocks `allUsers`. On a personal Gmail project
> this normally does not apply; on a Workspace org, an admin must allow it (or you
> deploy behind an authenticated proxy). Flag this to me if you hit it.

After CORS is resolved, if ingest then fails with a real internal error, it's
almost always **Vertex AI not enabled** (`aiplatform.googleapis.com`) or the
functions runtime service account missing the **Vertex AI User** role:
```bash
gcloud projects add-iam-policy-binding strimearia \
  --member="serviceAccount:strimearia@appspot.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

---

## Fix B (fastest for local dev): use the Firebase Emulators

No cloud, no CORS, no IAM. The app now supports this via a flag.

1. In `src/environments/environment.ts` set `useEmulators: true`.
2. Start the emulators:
   ```bash
   gcloud auth application-default login   # so emulated functions can call Vertex AI
   cd functions && npm run build && cd ..
   firebase emulators:start
   ```
3. Run `ng serve` and open localhost:4200. All Auth/Firestore/Functions/Storage
   calls now go to local emulator ports (Auth 9099, Firestore 8080, Functions
   5001, Storage 9199) -- the cross-origin/preflight problem disappears.
4. Set `useEmulators` back to `false` before building for the cloud.

---

## What was changed in code (this pass)
- `firebase-client.ts`: added optional emulator wiring (`useEmulators`).
- `environment.ts` / `environment.prod.ts`: added `useEmulators` + `emulatorHost`.
- `functions/src/ingestDocument.ts`: added `cors: true` to the callable options
  (defensive; does not replace the public-invoker requirement above).

The HTTP `api`/`chatRag` function already sets explicit CORS for `localhost:4200`,
`*.web.app`, and `*.firebaseapp.com` -- but it ALSO needs the public invoker
(Fix A) to be reachable from the browser.
