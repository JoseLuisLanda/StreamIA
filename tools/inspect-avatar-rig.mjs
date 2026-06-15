#!/usr/bin/env node
/**
 * Standalone GLB rig inspector — mirrors src/app/lib/avatars/rig-spec.ts but runs
 * in Node with zero dependencies (parses the GLB/glTF JSON chunk directly).
 *
 * Use it to generate the per-avatar blendshape/bone compatibility report for the
 * three catalog avatars without running the web app:
 *
 *   1. Download the GLBs from Firebase Storage (or any local copy):
 *        avatars/publicar3d@gmail.com/alex-ia.glb
 *        avatars/publicar3d@gmail.com/r-ai-ban.glb
 *        avatars/publicar3d@gmail.com/yisus.glb
 *   2. node tools/inspect-avatar-rig.mjs alex-ia.glb r-ai-ban.glb yisus.glb
 *      (or point it at a folder: node tools/inspect-avatar-rig.mjs ./avatars)
 *
 * Output: matched/missing ARKit morphs, resolved bones, and a conformance verdict
 * (full / remapped / partial / incompatible) per file.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const ARKIT_52 = [
  'browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight',
  'cheekPuff','cheekSquintLeft','cheekSquintRight','eyeBlinkLeft','eyeBlinkRight',
  'eyeLookDownLeft','eyeLookDownRight','eyeLookInLeft','eyeLookInRight','eyeLookOutLeft',
  'eyeLookOutRight','eyeLookUpLeft','eyeLookUpRight','eyeSquintLeft','eyeSquintRight',
  'eyeWideLeft','eyeWideRight','jawForward','jawLeft','jawOpen','jawRight','mouthClose',
  'mouthDimpleLeft','mouthDimpleRight','mouthFrownLeft','mouthFrownRight','mouthFunnel',
  'mouthLeft','mouthLowerDownLeft','mouthLowerDownRight','mouthPressLeft','mouthPressRight',
  'mouthPucker','mouthRight','mouthRollLower','mouthRollUpper','mouthShrugLower',
  'mouthShrugUpper','mouthSmileLeft','mouthSmileRight','mouthStretchLeft','mouthStretchRight',
  'mouthUpperUpLeft','mouthUpperUpRight','noseSneerLeft','noseSneerRight','tongueOut',
];
// Canonical mouth keys the lipsync needs (subset of ARKit) — keep in sync with viseme-map.ts
const REQUIRED_MOUTH = ['mouthClose','mouthPressLeft','mouthPressRight','jawOpen','mouthRollLower',
  'mouthUpperUpLeft','mouthUpperUpRight','tongueOut','mouthStretchLeft','mouthStretchRight',
  'mouthFunnel','mouthPucker','mouthSmileLeft','mouthSmileRight','mouthLowerDownLeft','mouthLowerDownRight'];
const MORPH_ALIASES = {
  jawOpen: ['mouthOpen','jaw_open','A25_Jaw_Open'],
  mouthClose: ['mouthClosed','A26_Mouth_Close'],
  mouthFunnel: ['A29_Mouth_Funnel'], mouthPucker: ['A30_Mouth_Pucker'],
  eyeBlinkLeft: ['eyesClosed_L','A02_Eye_Blink_Left'], eyeBlinkRight: ['eyesClosed_R','A05_Eye_Blink_Right'],
};
const BONE_WORDS = ['head','neck','spine','spine1','spine2'];

const slug = (n) => n.toLowerCase().replace(/^.*\./,'').replace(/[^a-z0-9]/g,'')
  .replace(/(left|lft)$/,'l').replace(/(right|rgt)$/,'r');

function parseGlb(buf) {
  // GLB: magic(0x46546C67) version length | chunk0(JSON) ...
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) {
    // maybe a .gltf JSON file
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error('Not a GLB/glTF file'); }
  }
  const len0 = buf.readUInt32LE(12);
  const json = buf.slice(20, 20 + len0).toString('utf8');
  return JSON.parse(json);
}

function collect(gltf) {
  const nodeNames = (gltf.nodes ?? []).map((n) => n.name).filter(Boolean);
  const morphs = new Set();
  for (const mesh of gltf.meshes ?? []) {
    const names = mesh.extras?.targetNames ?? [];
    for (const t of names) morphs.add(t);
    for (const prim of mesh.primitives ?? []) {
      for (const t of prim.extras?.targetNames ?? []) morphs.add(t);
    }
  }
  return { nodeNames, morphs: [...morphs] };
}

function inspect(file) {
  const gltf = parseGlb(readFileSync(file));
  const { nodeNames, morphs } = collect(gltf);
  const actual = new Set(morphs);
  const slugIndex = new Map();
  for (const m of morphs) if (!slugIndex.has(slug(m))) slugIndex.set(slug(m), m);

  const map = new Map(); let remapped = 0; const matched = [], missing = [];
  for (const canon of ARKIT_52) {
    if (actual.has(canon)) { map.set(canon, canon); matched.push(canon); continue; }
    const bySlug = slugIndex.get(slug(canon));
    if (bySlug) { map.set(canon, bySlug); matched.push(canon); if (bySlug !== canon) remapped++; continue; }
    let found;
    for (const a of MORPH_ALIASES[canon] ?? []) {
      if (actual.has(a)) { found = a; break; }
      const s = slugIndex.get(slug(a)); if (s) { found = s; break; }
    }
    if (found) { map.set(canon, found); matched.push(canon); remapped++; }
    else missing.push(canon);
  }

  const bones = {};
  for (const w of BONE_WORDS) {
    const hit = nodeNames.find((n) => n.toLowerCase().endsWith(w));
    bones[w] = hit ?? null;
  }
  const missingMouth = REQUIRED_MOUTH.filter((k) => !map.has(k));
  const mouthOk = missingMouth.length === 0;
  let verdict;
  if (morphs.length === 0) verdict = 'incompatible (no morph targets)';
  else if (mouthOk && remapped === 0 && missing.length === 0) verdict = 'full';
  else if (mouthOk) verdict = 'remapped';
  else if (matched.filter((k)=>REQUIRED_MOUTH.includes(k)).length >= REQUIRED_MOUTH.length/2) verdict = 'partial';
  else verdict = 'incompatible';

  console.log(`\n=== ${basename(file)} ===`);
  console.log(`verdict        : ${verdict}`);
  console.log(`morph targets  : ${morphs.length}`);
  console.log(`ARKit matched  : ${matched.length}/52  (remapped: ${remapped})`);
  console.log(`head bone      : ${bones.head ?? 'NOT FOUND'}  | neck: ${bones.neck ?? '-'} | spine: ${bones.spine ?? '-'}`);
  if (missingMouth.length) console.log(`missing mouth  : ${missingMouth.join(', ')}`);
  if (missing.length) console.log(`missing ARKit  : ${missing.join(', ')}`);
  console.log(`all morph names: ${morphs.sort().join(', ') || '(none)'}`);
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node tools/inspect-avatar-rig.mjs <file.glb | folder> ...');
  process.exit(1);
}
const files = [];
for (const a of args) {
  if (statSync(a).isDirectory()) {
    for (const f of readdirSync(a)) if (/\.(glb|gltf)$/i.test(f)) files.push(join(a, f));
  } else files.push(a);
}
for (const f of files) {
  try { inspect(f); } catch (e) { console.error(`\n=== ${basename(f)} ===\nERROR: ${e.message}`); }
}
