/**
 * HTTP `api` Express router (strimearia), region us-central1.
 *
 * Deployed function name = `api`, so routes are reached at:
 *   https://us-central1-strimearia.cloudfunctions.net/api/chatRag
 *
 * CORS is handled by onRequest's `cors` option (app origins only -- never *).
 * chatRag is the only route for now; add future RAG HTTP routes here.
 */
import express from 'express';
import { onRequest } from 'firebase-functions/v2/https';
import './admin'; // ensure Admin SDK is initialized (strimearia)
import { validateFirebaseIdToken } from './lib/http-auth';
import { chatRagHandler } from './chatRag';

const app = express();
app.use(express.json({ limit: '1mb' }));

// Signed-in users only; no role required to answer.
app.post('/chatRag', validateFirebaseIdToken, chatRagHandler);

// Allowed browser origins for the SPA. Replace/add your production custom domain.
const CORS_ORIGINS: Array<string | RegExp> = [
  /^http:\/\/localhost:4200$/,
  /^https:\/\/localhost:4200$/,
  /\.web\.app$/,
  /\.firebaseapp\.com$/,
  // 'https://your-custom-domain.com',
];

export const api = onRequest({ region: 'us-central1', cors: CORS_ORIGINS }, app);
