/**
 * Chunk-structure inspector (read-only, no writes).
 *
 * Answers ONE question: do the ingested chunks keep a category header (e.g. "OJO")
 * together with the conditions listed under it, or did the header get separated
 * from its entries across a chunk boundary?
 *
 * Usage (run from the functions/ folder, where Firebase creds resolve):
 *   node scripts/inspect-chunks.mjs <namespaceOrAssistantId> [headerWord]
 *
 * Examples:
 *   node scripts/inspect-chunks.mjs grabovoi OJO
 *   node scripts/inspect-chunks.mjs <assistantId> OJO
 *
 * Auth: uses Application Default Credentials. If it errors on auth, run first:
 *   gcloud auth application-default login
 * (or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key).
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'strimearia';
const arg = process.argv[2];
const headerWord = (process.argv[3] || 'OJO').toUpperCase();
if (!arg) {
  console.error('Usage: node scripts/inspect-chunks.mjs <namespaceOrAssistantId> [headerWord]');
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

// A "category header" heuristic: a short line that is ALL-CAPS letters (an organ /
// system label like OJO, PIEL, CORAZON), 2..30 chars, optionally with spaces.
const HEADER_LINE = /^[A-ZAEIOUNU][A-Z .]{1,30}$/; // ASCII-safe; accents already stripped at ingest in many docs

async function resolveNamespace(a) {
  // If a doc exists at assistants/{a}, use its ragCollection; else treat a as the namespace.
  const asst = await db.collection('assistants').doc(a).get();
  if (asst.exists) {
    const ns = (asst.get('ragCollection') || '').toString().trim();
    if (ns) { console.log(`Resolved assistant "${a}" -> namespace "${ns}"`); return ns; }
  }
  return a;
}

function headerLinesIn(text) {
  return (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => HEADER_LINE.test(l) && l.length >= 2 && l.length <= 30);
}

async function main() {
  const ns = await resolveNamespace(arg);
  console.log(`\n=== Namespace: ${ns} ===`);

  // 1) Document status records: which chunk strategy was actually used at ingest?
  const docs = await db.collection('rag').doc(ns).collection('documents').get();
  if (docs.empty) {
    console.log('No documents found under rag/' + ns + '/documents.');
  } else {
    console.log(`\n-- Documents (${docs.size}) --`);
    for (const d of docs.docs) {
      const x = d.data() || {};
      console.log(`  ${d.id}: strategy=${x.strategy ?? '(unset)'} chunks=${x.chunks ?? '?'} filename=${x.filename ?? ''}`);
    }
  }

  // 2) Sample chunks (ordered by chunkIndex). We do NOT print embeddings.
  const SAMPLE = 400;
  const snap = await db.collection('rag').doc(ns).collection('chunks')
    .orderBy('chunkIndex').limit(SAMPLE).get();
  console.log(`\n-- Sampled ${snap.size} chunks (ordered by chunkIndex; cap ${SAMPLE}) --`);

  // 3) Catalog every header-looking line and which chunkIndex it sits in.
  const headerHits = []; // { header, chunkIndex, sameChunkCondCount }
  let targetReport = null;
  for (const c of snap.docs) {
    const text = (c.get('text') ?? '').toString();
    const idx = Number(c.get('chunkIndex') ?? -1);
    const headers = headerLinesIn(text);
    for (const h of headers) {
      // count lines AFTER this header within the SAME chunk that look like entries
      const after = text.slice(text.indexOf(h) + h.length);
      const entryLines = after.split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l && !HEADER_LINE.test(l)).length;
      headerHits.push({ header: h, chunkIndex: idx, sameChunkEntries: entryLines });
    }
    // Focused look at the requested header (e.g. OJO): match a WHOLE header LINE equal to
    // the word (not a substring inside another word), so we land on the real category.
    const hasExactHeaderLine = text.split(/\r?\n/)
      .some((l) => l.trim().toUpperCase() === headerWord);
    if (hasExactHeaderLine && !targetReport) {
      targetReport = { idx, text };
    }
  }

  console.log(`\n-- Header-looking lines found (${headerHits.length}) --`);
  for (const h of headerHits.slice(0, 60)) {
    console.log(`  [chunk ${h.chunkIndex}] "${h.header}"  (+${h.sameChunkEntries} entry-lines in same chunk)`);
  }

  // 4) Focused dump around the requested header so you can SEE header<->conditions.
  console.log(`\n-- Focused view for header "${headerWord}" --`);
  if (!targetReport) {
    console.log(`  "${headerWord}" not found in the sampled chunks.`);
  } else {
    console.log(`  Found in chunk index ${targetReport.idx}. First 900 chars of that chunk:\n`);
    console.log('  ' + targetReport.text.slice(0, 900).replace(/\n/g, '\n  '));
    console.log('\n  -> If the eye conditions (astigmatismo, cataratas, glaucoma, miopia...) appear');
    console.log('     in THIS SAME chunk under the header, the structure is PRESERVED.');
    console.log('     If the header is alone / conditions are missing here, it was SPLIT.');
  }

  console.log('\nDone (read-only).');
  process.exit(0);
}

main().catch((e) => { console.error('inspect-chunks failed:', e?.message ?? e); process.exit(1); });
