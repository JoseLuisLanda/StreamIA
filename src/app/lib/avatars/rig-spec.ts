/**
 * Canonical rig specification + blendshape/bone normalization.
 *
 * The gesture studio and the TTS lipsync pipeline are written against ONE
 * canonical rig:
 *   - Morphs:  the 52 Apple ARKit blendshapes (e.g. jawOpen, mouthSmileLeft,
 *              browInnerUp, eyeBlinkLeft …). This is exactly what Ready Player Me
 *              exports with ?morphTargets=ARKit, and what every viseme/gesture
 *              channel in this app references.
 *   - Bones:   a head bone named `Head`, with optional `Neck` and
 *              `Spine`/`Spine1`/`Spine2` for breathing.
 *
 * Real avatars come from different tools (RPM, Character Creator/iClone, Mixamo,
 * VRoid/Perfect-Sync, Blender exports) and may name their morph targets and
 * bones differently. This module inspects a loaded model and produces a
 * RigNormalizer that maps the model's ACTUAL names onto the canonical channels,
 * plus a human-readable conformance report so missing channels degrade
 * gracefully (e.g. skip mouth but keep head motion) instead of failing silently.
 */

import * as THREE from 'three';

export const CANONICAL_RIG_VERSION = 'arkit-52-v1';

/** The 52 canonical ARKit blendshape names. */
export const ARKIT_52: readonly string[] = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'noseSneerLeft', 'noseSneerRight', 'tongueOut',
];

/**
 * Explicit aliases for known non-ARKit naming conventions, keyed by canonical
 * name → list of alternative source names. Matched case-insensitively *and*
 * after separator-stripping (see slug()), so you only need entries here when
 * the alternative is a genuinely different word (not just casing/separators).
 */
export const MORPH_ALIASES: Record<string, string[]> = {
  // jaw / mouth opening: many rigs call ARKit jawOpen "mouthOpen"
  jawOpen: ['mouthOpen', 'mouth_open', 'jaw_open', 'JawOpen', 'A25_Jaw_Open', 'v_open'],
  mouthClose: ['mouthClosed', 'mouth_close', 'A26_Mouth_Close'],
  mouthFunnel: ['v_explosive', 'mouth_funnel', 'A29_Mouth_Funnel'],
  mouthPucker: ['v_oh', 'mouth_pucker', 'A30_Mouth_Pucker', 'mouthPuckerOpen'],
  // Oculus/RPM viseme set → nearest ARKit mouth shape (used only when an avatar
  // exposes visemes but no ARKit mouth morphs). Best-effort, lossy.
  jawForward: ['v_dd', 'A22_Jaw_Forward'],
  mouthSmileLeft: ['mouthSmile_L', 'v_ee_L', 'A38_Mouth_Smile_Left'],
  mouthSmileRight: ['mouthSmile_R', 'v_ee_R', 'A39_Mouth_Smile_Right'],
  tongueOut: ['tongue_out', 'v_th', 'A52_Tongue_Out'],
  eyeBlinkLeft: ['eyesClosed_L', 'blink_L', 'A02_Eye_Blink_Left', 'eyeClose_L'],
  eyeBlinkRight: ['eyesClosed_R', 'blink_R', 'A05_Eye_Blink_Right', 'eyeClose_R'],
  browInnerUp: ['browsRaiseInner', 'A03_Brow_Inner_Up', 'browInnerUpLeft'],
};

/** Canonical bones the renderer drives, with alternative source names. */
export const BONE_ALIASES: Record<string, string[]> = {
  Head: ['Head', 'head', 'mixamorigHead', 'CC_Base_Head', 'J_Bip_C_Head', 'Bip01_Head'],
  Neck: ['Neck', 'neck', 'mixamorigNeck', 'CC_Base_NeckTwist01', 'J_Bip_C_Neck', 'Bip01_Neck'],
  Spine: ['Spine', 'spine', 'mixamorigSpine', 'CC_Base_Spine01', 'J_Bip_C_Spine', 'Bip01_Spine'],
  Spine1: ['Spine1', 'spine1', 'mixamorigSpine1', 'CC_Base_Spine02', 'J_Bip_C_Chest', 'Bip01_Spine1'],
  Spine2: ['Spine2', 'spine2', 'mixamorigSpine2', 'CC_Base_Spine02', 'J_Bip_C_UpperChest', 'Bip01_Spine2'],
};

/** Mesh node names that conventionally carry the face morph targets (RPM). */
export const KNOWN_HEAD_MESH_NAMES = [
  'Wolf3D_Head', 'Wolf3D_Teeth', 'Wolf3D_Beard', 'Wolf3D_Avatar', 'Wolf3D_Head_Custom',
];

/**
 * Normalize a morph/bone name to a comparison "slug":
 *  - lowercased, alphanumerics only (drops _, ., spaces, prefixes like "blendShape1.")
 *  - trailing left/right tokens collapsed to a single l / r so
 *    "mouthSmile_L", "mouthSmileLeft", "Mouth Smile L" all match.
 */
export function slug(name: string): string {
  let s = name.toLowerCase();
  // drop common export prefixes ("blendshape1.", "facial.", node-path dots)
  s = s.replace(/^.*\./, '');
  s = s.replace(/[^a-z0-9]/g, '');
  // collapse side tokens to single char
  s = s.replace(/(left|lft)$/, 'l').replace(/(right|rgt)$/, 'r');
  return s;
}

export type Conformance = 'full' | 'partial' | 'remapped' | 'incompatible';

export interface RigReport {
  /** mesh node names that exposed morph targets */
  morphMeshes: string[];
  /** total distinct morph-target names found on the model */
  totalMorphs: number;
  /** raw morph-target names found (union across meshes) */
  morphNames: string[];
  /** canonical ARKit names that resolved to an actual morph */
  matchedArkit: string[];
  /** canonical ARKit names with NO match on this model */
  missingArkit: string[];
  /** canonical mouth/lipsync keys that are present */
  matchedMouth: string[];
  /** canonical mouth/lipsync keys that are missing (lipsync degraded) */
  missingMouth: string[];
  /** canonical bones resolved → actual node name */
  bones: Record<string, string | null>;
  /** true when the head bone was resolved (head motion available) */
  hasHeadBone: boolean;
  /** number of canonical names that needed an alias (i.e. non-exact match) */
  remappedCount: number;
  /** overall classification */
  conformance: Conformance;
  /** human-readable warnings (missing channels etc.) */
  warnings: string[];
}

export interface NormalizedRig {
  /** canonical ARKit name → actual morph-target name on this model */
  morphMap: Map<string, string>;
  /** canonical bone name → resolved THREE node (or undefined) */
  boneNodes: Partial<Record<keyof typeof BONE_ALIASES, THREE.Object3D>>;
  report: RigReport;
}

interface InspectInput {
  /** meshes that have morphTargetDictionary */
  morphMeshes: { name: string; dict: Record<string, number> }[];
  /** all nodes by name (for bone resolution) */
  nodes: Record<string, THREE.Object3D>;
  /** canonical mouth keys the lipsync needs (subset of ARKit) */
  requiredMouthKeys: string[];
  /** canonical gesture morph keys the built-in gestures touch (subset of ARKit) */
  requiredGestureMorphs?: string[];
}

/**
 * Inspect a loaded model and build the canonical→actual mapping + report.
 */
export function buildNormalizedRig(input: InspectInput): NormalizedRig {
  // Union of all actual morph names, with a slug index for fuzzy matching.
  const actualNames = new Set<string>();
  for (const m of input.morphMeshes) {
    for (const k of Object.keys(m.dict)) actualNames.add(k);
  }
  const slugIndex = new Map<string, string>(); // slug → first actual name
  for (const name of actualNames) {
    const key = slug(name);
    if (!slugIndex.has(key)) slugIndex.set(key, name);
  }

  const morphMap = new Map<string, string>();
  const matchedArkit: string[] = [];
  const missingArkit: string[] = [];
  let remappedCount = 0;

  for (const canon of ARKIT_52) {
    // 1) exact name present
    if (actualNames.has(canon)) {
      morphMap.set(canon, canon);
      matchedArkit.push(canon);
      continue;
    }
    // 2) slug match (casing/separators/side differences)
    const bySlug = slugIndex.get(slug(canon));
    if (bySlug) {
      morphMap.set(canon, bySlug);
      matchedArkit.push(canon);
      if (bySlug !== canon) remappedCount++;
      continue;
    }
    // 3) explicit alias table
    const aliases = MORPH_ALIASES[canon] ?? [];
    let found: string | undefined;
    for (const a of aliases) {
      if (actualNames.has(a)) { found = a; break; }
      const s = slugIndex.get(slug(a));
      if (s) { found = s; break; }
    }
    if (found) {
      morphMap.set(canon, found);
      matchedArkit.push(canon);
      remappedCount++;
      continue;
    }
    missingArkit.push(canon);
  }

  // Bones
  const boneNodes: Partial<Record<keyof typeof BONE_ALIASES, THREE.Object3D>> = {};
  const boneReport: Record<string, string | null> = {};
  for (const canonBone of Object.keys(BONE_ALIASES) as (keyof typeof BONE_ALIASES)[]) {
    const resolved = resolveBone(canonBone, input.nodes);
    if (resolved) {
      boneNodes[canonBone] = resolved.node;
      boneReport[canonBone] = resolved.name;
    } else {
      boneReport[canonBone] = null;
    }
  }

  // Conformance classification
  const requiredMouth = input.requiredMouthKeys;
  const matchedMouth = requiredMouth.filter((k) => morphMap.has(k));
  const missingMouth = requiredMouth.filter((k) => !morphMap.has(k));
  const requiredGesture = input.requiredGestureMorphs ?? [];
  const missingGesture = requiredGesture.filter((k) => !morphMap.has(k));

  const warnings: string[] = [];
  if (input.morphMeshes.length === 0) {
    warnings.push('No meshes with blendshapes/morph targets were found — lipsync and facial gestures are unavailable.');
  }
  if (missingMouth.length) {
    warnings.push(
      `Missing ${missingMouth.length} lipsync mouth morph(s): ${missingMouth.join(', ')} — lip movement will be reduced or skipped.`
    );
  }
  if (missingGesture.length) {
    warnings.push(
      `Missing ${missingGesture.length} gesture morph(s): ${missingGesture.join(', ')} — affected facial gestures degrade to head motion only.`
    );
  }
  if (!boneNodes['Head']) {
    warnings.push('No head bone resolved — head nods/shakes/tilts are unavailable.');
  }

  let conformance: Conformance;
  const mouthOk = missingMouth.length === 0;
  const gestureOk = missingGesture.length === 0;
  if (input.morphMeshes.length === 0) {
    conformance = 'incompatible';
  } else if (mouthOk && gestureOk && remappedCount === 0) {
    conformance = 'full';
  } else if (mouthOk && gestureOk) {
    conformance = 'remapped';
  } else if (mouthOk || matchedMouth.length >= requiredMouth.length / 2) {
    conformance = 'partial';
  } else {
    conformance = 'incompatible';
  }

  const report: RigReport = {
    morphMeshes: input.morphMeshes.map((m) => m.name),
    totalMorphs: actualNames.size,
    morphNames: Array.from(actualNames).sort(),
    matchedArkit,
    missingArkit,
    matchedMouth,
    missingMouth,
    bones: boneReport,
    hasHeadBone: !!boneNodes['Head'],
    remappedCount,
    conformance,
    warnings,
  };

  return { morphMap, boneNodes, report };
}

function resolveBone(
  canonBone: keyof typeof BONE_ALIASES,
  nodes: Record<string, THREE.Object3D>
): { node: THREE.Object3D; name: string } | null {
  const aliases = BONE_ALIASES[canonBone];
  // 1) exact alias name
  for (const a of aliases) {
    if (nodes[a]) return { node: nodes[a], name: a };
  }
  // 2) suffix / contains match (e.g. "mixamorigHead", "CC_Base_Head")
  const targets = aliases.map((a) => a.toLowerCase());
  for (const [name, node] of Object.entries(nodes)) {
    const lower = name.toLowerCase();
    for (const t of targets) {
      // match when node name ends with the canonical token ("...head")
      if (lower.endsWith(t) || lower === t) return { node, name };
    }
  }
  // 3) loose: ends with the canonical bone word itself (Head/Neck/Spine…)
  const word = canonBone.toLowerCase();
  for (const [name, node] of Object.entries(nodes)) {
    if (name.toLowerCase().endsWith(word)) return { node, name };
  }
  return null;
}

/** One-line summary for logs / UI badges. */
export function conformanceLabel(c: Conformance): string {
  switch (c) {
    case 'full': return 'Fully conforms (ARKit-52)';
    case 'remapped': return 'Conforms via remapping';
    case 'partial': return 'Partial — some channels missing';
    case 'incompatible': return 'Incompatible — no usable face morphs';
  }
}
