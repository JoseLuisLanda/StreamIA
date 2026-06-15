/**
 * REFERENCE ONLY -- not part of the Angular app build (lives under tools/).
 *
 * Express handler for the RAG orchestration Function that the Text-Avatar client
 * consumes. Copy/adapt into your *separate* Functions repo. It implements the
 * exact contract the client expects:
 *
 *   POST <endpoint>
 *   Authorization: Bearer <Firebase ID token>     // verified by validateFirebaseIdToken
 *   body: { query, assistantId, language, voice? }
 *   ->   { body, gestureCommands, media: [{ id,type,title,storagePath,thumbnailPath,caption }] }
 *
 * Stack: Vertex AI (Gemini) for generation + Firestore vector search for retrieval.
 * Secrets + LLM/RAG connectivity stay here, server-side. RAG is constrained to the
 * assistant's collection so a tampered client can't query another topic.
 */
import { Router, Request, Response } from 'express';
import { firestore } from 'firebase-admin';
// import { validateFirebaseIdToken, requireRole } from '../middleware/auth';
// import { VertexAI } from '@google-cloud/vertexai';

const router = Router();

// --- Body-only system contract: NO greeting/closing/CTA. Lead-in + tail are
//     added CLIENT-side from stored gestures. Emit inline gesture tags the client
//     parser understands: [thinking]:[1], [yes]:[2]:[slow], [laugh], [surprise].
const SYSTEM_PROMPT = `You answer ONLY the body of the response: no greeting, no
sign-off, no call to action. Write in {{LANGUAGE}}. Keep it concise and factual,
grounded strictly in the provided CONTEXT. Insert a few inline gesture tags using
this exact format so the avatar performs while speaking: a [thinking]:[1] while
introducing reasoning, [yes] or [surprise] for emphasis, [laugh] only if clearly
appropriate. Do not invent media. If the context is insufficient, say so briefly.`;

interface RagBody { query: string; assistantId: string; language?: string; voice?: string; }

// router.post('/rag/query', validateFirebaseIdToken, async (req, res) => { ... }
export async function ragQueryHandler(req: Request, res: Response): Promise<void> {
  const { query, assistantId, language = 'es' } = (req.body ?? {}) as RagBody;
  if (!query || !assistantId) {
    res.status(400).json({ error: 'query and assistantId are required' });
    return;
  }

  const db = firestore();

  // 1) Load the assistant to get the RAG collection (server-side scoping).
  const depSnap = await db.collection('assistants').doc(assistantId).get();
  if (!depSnap.exists) { res.status(404).json({ error: 'assistant not found' }); return; }
  const collection: string = depSnap.get('ragCollection') || assistantId;

  // 2) Embed the query + Firestore vector (KNN) search, scoped to the collection.
  //    const embedding = await embed(query);           // Vertex AI text-embedding
  //    const matches = await db.collection(`rag/${collection}/chunks`)
  //      .findNearest('embedding', embedding, { limit: 6, distanceMeasure: 'COSINE' }).get();
  //    const context = matches.docs.map(d => d.get('text')).join('\n---\n');
  //    const mediaDocs = matches.docs.flatMap(d => d.get('media') ?? []);
  const context = '';            // wire your retrieval here
  const mediaDocs: any[] = [];   // media metadata attached to retrieved chunks

  // 3) Generate the BODY (with inline gesture tags) via Gemini.
  //    const vertex = new VertexAI({ project, location });
  //    const model = vertex.getGenerativeModel({ model: 'gemini-1.5-flash' });
  //    const prompt = SYSTEM_PROMPT.replace('{{LANGUAGE}}', language)
  //                 + `\n\nCONTEXT:\n${context}\n\nQUESTION: ${query}`;
  //    const out = await model.generateContent(prompt);
  //    const gestureCommands = out.response.candidates[0].content.parts[0].text.trim();
  const gestureCommands = '';                 // model output (body + inline tags)
  const body = gestureCommands.replace(/\[[^\]]+\](:\[[^\]]*\])*/g, '').trim(); // tags stripped

  // 4) Return media as METADATA only (storagePath/thumbnailPath): never signed URLs.
  const media = mediaDocs.map((m, i) => ({
    id: m.id ?? `media_${i}`,
    type: m.type ?? 'image',
    title: m.title ?? '',
    storagePath: m.storagePath,                 // e.g. rag-media/<collection>/img_001.jpg
    thumbnailPath: m.thumbnailPath ?? '',
    caption: m.caption ?? '',
  }));

  res.json({ body, gestureCommands, media });
}

// Wiring example (in your app):
//   router.post('/rag/query', validateFirebaseIdToken, ragQueryHandler);
//   // admin-only content management:
//   router.post('/rag/content', validateFirebaseIdToken, requireRole('admin'), ...);
export default router;
