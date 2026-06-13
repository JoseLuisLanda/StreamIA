# Gesture Studio — Architecture & Design Plan

**Component:** `/gesture-studio` page  
**Purpose:** Record avatar reactions from face-tracking, compile them into reusable `GestureDef` entries, manage and replay the library.  
**Constraint:** New files only — zero modifications to existing components.

---

## 1. Overview & Pipeline

```
MediaPipe (FaceTrackingService)
        │ blendshapes signal + rotation signal @ ~30 fps
        ▼
MotionRecorderService
        │ raw MotionFrame[] buffered for N seconds
        ▼
MotionCompilerService
        │ baseline subtraction → channel activity filter
        │ Ramer-Douglas-Peucker decimation → sparse keyframes
        │ time normalization t_raw/duration → 0..1
        ▼
CustomGestureRegistryService
        │ merges compiled GestureDef into runtime GESTURE_MAP
        │ persists raw recording + compiled def to IndexedDB
        ▼
GesturePlayerService.trigger(id)
        │ plays on AvatarTtsComponent (unchanged)
        ▼
gesture-studio page — record / edit / export UI
```

---

## 2. Data Structures

### 2.1 Raw Capture — `MotionFrame`

Captured once per `requestAnimationFrame` tick (~30 fps) while the recorder is active.

```typescript
// src/app/lib/motion/motion.models.ts

export interface MotionFrame {
  /** elapsed seconds from recording start */
  t: number;
  /**
   * ARKit blendshape weights captured from FaceTrackingService.blendshapes().
   * Only stores channels that deviate > CHANNEL_ACTIVE_THRESHOLD from baseline.
   * Key = ARKit category name (e.g. 'browInnerUp', 'eyeBlinkLeft').
   */
  morphs: Record<string, number>;
  /** additive head pitch offset from baseline (radians) */
  headX: number;
  /** additive head yaw offset from baseline (radians) */
  headY: number;
  /** additive head roll offset from baseline (radians) */
  headZ: number;
}
```

> **Baseline** = the first frame captured (the avatar's resting pose during that session). All subsequent frames store deltas from this, exactly matching how `GesturePlayerService` interprets `head.x/y/z` as additive offsets.

---

### 2.2 Stored Recording — `MotionRecording`

```typescript
export type RecordingCategory =
  | 'head'        // only bone channels moved significantly
  | 'expression'  // only morph channels
  | 'mixed';      // both

export interface MotionRecording {
  /** UUID v4 */
  id: string;
  /** User-supplied label: "sigh_v2", "surprise", etc. */
  label: string;
  category: RecordingCategory;
  /** Configured capture duration in seconds (e.g. 5) */
  duration: number;
  /** Actual captured frame count */
  frameCount: number;
  /** Approximate sample rate (frames / duration) */
  fps: number;
  frames: MotionFrame[];
  /**
   * Auto-compiled GestureDef, null until the user accepts compilation.
   * Once set, it is also registered in CustomGestureRegistryService.
   */
  compiledGesture: GestureDef | null;
  /** User tags for filtering: ['head', 'emotion', 'approved'] */
  tags: string[];
  createdAt: number;   // Date.now()
  updatedAt: number;
}
```

---

### 2.3 Compiled Output — `GestureDef` (existing type, no changes)

The compiler produces a standard `GestureDef` (from `gesture-library.ts`) so it is fully compatible with the existing `GesturePlayerService` without any modifications.

```typescript
// Example compiled output for a recorded "sigh":
{
  id: 'custom_sigh_v2',      // 'custom_' prefix for recorded gestures
  defaultRepetitions: 1,
  defaultSpeed: 'slow',
  returnDuration: 0.35,
  entryEasing: 'ease-in-out-cubic',
  exitEasing: 'ease-out-quad',
  channels: [
    {
      type: 'bone',
      target: 'head.x',
      keyframes: [
        { t: 0, v: 0 }, { t: 0.25, v: -0.12 }, { t: 0.72, v: 0.16 }, { t: 1, v: 0 }
      ]
    },
    {
      type: 'morph',
      target: 'eyeBlinkLeft',
      keyframes: [{ t: 0, v: 0 }, { t: 0.22, v: 0.75 }, { t: 0.62, v: 0.75 }, { t: 1, v: 0 }]
    }
    // ... other channels decimated from raw frames
  ]
}
```

---

## 3. New Services

### 3.1 `MotionRecorderService`

**File:** `src/app/services/motion-recorder.service.ts`

Responsibilities:
- Taps `FaceTrackingService.blendshapes()` and `FaceTrackingService.rotation()` signals.
- Runs a `requestAnimationFrame` capture loop when recording is active.
- Computes per-frame baseline delta on the first captured frame.
- Exposes Angular signals for UI binding: `isRecording`, `elapsed`, `frameCount`.
- On `stopRecording()`: emits the completed `MotionFrame[]` as an Observable/signal.

Key API:
```typescript
class MotionRecorderService {
  isRecording = signal(false);
  elapsed     = signal(0);            // seconds elapsed
  frameCount  = signal(0);

  /** Configurable max seconds; default = 5. */
  startRecording(durationSec: number, channels: RecordChannelConfig): void;
  stopRecording(): MotionFrame[];     // returns buffer immediately
  cancel(): void;
}

interface RecordChannelConfig {
  brows: boolean;
  eyes: boolean;
  head: boolean;
  mouth: boolean;   // off by default; mouth is reserved for lipsync
}
```

Implementation notes:
- Uses `effect()` or a polling loop (rAF outside NgZone) — same pattern as `AvatarTtsComponent.animate()`.
- A circular buffer of `maxFrames = durationSec * 60` pre-allocated at start to avoid GC mid-recording.
- Auto-stops after `durationSec` and emits via a Subject.

---

### 3.2 `MotionCompilerService`

**File:** `src/app/services/motion-compiler.service.ts`

Responsibilities: converts raw `MotionFrame[]` → `GestureDef`.

**Pipeline steps:**

1. **Baseline subtraction** — already done at capture time (frame[0] = zero). Verify.

2. **Channel activity detection** — skip channels whose peak absolute value < `CHANNEL_ACTIVE_THRESHOLD` (default `0.04`). Avoids adding noise channels.

3. **Ramer-Douglas-Peucker (RDP) decimation** — per channel, reduce 150+ frames to ~4–8 sparse keyframes. `epsilon` default `0.015`. This gives naturally sparse, smooth `{ t, v }` keyframes compatible with `sampleChannel()`.

4. **Time normalization** — `t_normalized = frame.t / totalDuration` → `0..1`.

5. **Head channel mapping** — `headX → bone:head.x`, `headY → bone:head.y`, `headZ → bone:head.z`.

6. **Easing detection heuristic** — scan the entry and exit slopes of each channel to suggest `entryEasing`/`exitEasing` (can be overridden in UI).

7. **returnDuration estimate** — `max(0.25, lastKeyframe_t_seconds * 0.15)`.

```typescript
class MotionCompilerService {
  compile(
    frames: MotionFrame[],
    id: string,
    opts?: CompilerOptions
  ): GestureDef;
}

interface CompilerOptions {
  activeThreshold?: number;   // default 0.04
  rdpEpsilon?: number;        // default 0.015
  allowMouth?: boolean;       // default false
  forcedEasing?: { entry: EasingType; exit: EasingType };
}
```

---

### 3.3 `CustomGestureRegistryService`

**File:** `src/app/services/custom-gesture-registry.service.ts`

Responsibilities:
- Maintains a `WritableSignal<GestureDef[]>` of dynamically registered gestures.
- On startup, loads compiled gestures from IndexedDB and registers them.
- Patches `GESTURE_MAP` at runtime: `GESTURE_MAP.set(def.id, def)`.
- Exposes `allGestures()` = `[...GESTURE_LIBRARY, ...customGestures()]` for the UI list.
- On unregister: `GESTURE_MAP.delete(id)`.

This means `GesturePlayerService.trigger('custom_sigh_v2')` works out of the box once registered — no changes to `GesturePlayerService`.

---

### 3.4 `MotionStoreService`

**File:** `src/app/services/motion-store.service.ts`

Wraps the existing `IndexedDbService` (at `pages/live/indexed-db.service.ts`) with a typed API for `MotionRecording`.

```typescript
class MotionStoreService {
  recordings = signal<MotionRecording[]>([]);

  load(): Promise<void>;
  save(rec: MotionRecording): Promise<void>;
  delete(id: string): Promise<void>;
  exportJson(id: string): string;           // download JSON blob
  importJson(json: string): MotionRecording | null;
}
```

IndexedDB store name: `'motionRecordings'` (separate from the existing `live` store, no collision).

---

## 4. New Angular Component — `/gesture-studio`

**Files:**
```
src/app/pages/gesture-studio/
  gesture-studio.component.ts        ← page shell + routing
  components/
    recording-panel.component.ts     ← controls: duration, channel toggles, record/stop
    gesture-list.component.ts        ← scrollable list: built-in + custom gestures
    motion-timeline.component.ts     ← SVG timeline editor for keyframe editing
    gesture-detail.component.ts      ← name, tags, easing pickers, export button
```

Route added to `app.routes.ts`:
```typescript
{
  path: 'gesture-studio',
  loadComponent: () => import('./pages/gesture-studio/gesture-studio.component')
    .then(m => m.GestureStudioComponent)
}
```

---

## 5. UI Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  🎭 Gesture Studio                                    [← Back] [?]  │
├──────────────────┬──────────────────────┬───────────────────────────┤
│  LIBRARY (left)  │   AVATAR VIEWPORT    │   RECORDING PANEL (right) │
│                  │   (AvatarTtsComp)    │                           │
│  Built-in        │                      │  Duration   [■■■■□] 5 s   │
│  ● yes           │                      │  Channels:                │
│  ● no            │                      │  ☑ Brows  ☑ Eyes          │
│  ● surprise      │                      │  ☑ Head   ☐ Mouth         │
│  ● sigh          │   ● idle avatar ●    │                           │
│  ● thinking      │                      │  ┌─────────────────────┐  │
│  ● laugh         │                      │  │  ⏺  RECORD  (5 s)   │  │
│  ──────────────  │                      │  └─────────────────────┘  │
│  Custom (3)      │                      │  ▓▓▓▓▓░░░░░  2.3 / 5.0 s │
│  ● custom_sigh2  │                      │  [■ Stop early]           │
│  ● custom_hmm    │                      │                           │
│  + Add new       │  [▶ Preview] [⏹]    │  FACE TRACKING            │
│                  │                      │  ○ OFF  (camera required) │
│  [Import JSON]   ├──────────────────────┤  [Enable Camera]          │
│                  │  TIMELINE            │                           │
│                  │  head.x ──●──●──●── │  SELECTED GESTURE         │
│                  │  eyeBlink ──●──●──  │  Label: [custom_sigh_v2]  │
│                  │  browInner ──●──●── │  Category: mixed          │
│                  │                      │  Easing:                  │
│                  │  [Simplify ε:0.015]  │   Entry [ease-in-out ▾]   │
│                  │  [Reset to raw]      │   Exit  [ease-out-quad ▾] │
│                  │                      │  [▶ Preview compiled]     │
│                  │                      │  [✔ Save to Library]      │
│                  │                      │  [↓ Export JSON]          │
│                  │                      │  [🗑 Delete]               │
└──────────────────┴──────────────────────┴───────────────────────────┘
```

### Key UX Flows

**Flow A — Record a new gesture:**
1. Set duration (slider, 1–10 s, default 5).
2. Toggle channel filters (brows/eyes/head; mouth off by default).
3. Enable camera → `FaceTrackingService.initialize()` starts.
4. Press **⏺ Record** → countdown "3…2…1…" overlay on avatar viewport.
5. Perform expression in front of camera.
6. Auto-stops at end OR user presses Stop Early.
7. Raw preview plays back immediately on avatar (direct morph writes, not via GesturePlayerService).
8. Compiler runs silently: `MotionCompilerService.compile()` produces a `GestureDef`.
9. Timeline panel renders the decimated keyframes.
10. User names it, adjusts easing, tweaks RDP epsilon → re-compiles on the fly.
11. **Save to Library** → stored in IndexedDB, registered in `CustomGestureRegistryService`.

**Flow B — Preview an existing gesture:**
1. Click any gesture in the list (built-in or custom).
2. `GesturePlayerService.trigger(id)` fires immediately on the embedded `AvatarTtsComponent`.

**Flow C — Edit keyframes:**
1. Select a custom recording.
2. Timeline shows each channel as a curve with draggable keyframe dots.
3. Drag a dot vertically → changes `v` value; horizontally → changes `t`.
4. Add/remove keyframe dots (double-click).
5. **Preview** triggers compiled result live.

**Flow D — Export / import:**
1. Export: downloads `{id}.gesture.json` containing the `GestureDef` + metadata.
2. Import: paste JSON → validates schema → shows preview → user saves.
3. Copy-to-source button: generates the TypeScript snippet to paste into `gesture-library.ts` for hardcoding.

---

## 6. Integration Points with Face-Tracking Pipeline

### What the recorder reads:

| Signal | Source | Recorder usage |
|--------|--------|----------------|
| `blendshapes()` | `FaceTrackingService` | ARKit morph weights per frame |
| `rotation()` | `FaceTrackingService` | `Euler.x/y/z` → additive head offsets |
| `isTracking()` | `FaceTrackingService` | Enables/disables record button |

The `FaceTrackingService` is `providedIn: 'root'`, so `MotionRecorderService` injects it directly. **Camera is only started when the user explicitly enables it in the panel** — the gesture studio can also be used without camera (for editing existing recordings).

### What the player writes:

After compilation, `GesturePlayerService.trigger('custom_xyz')` is the **only** playback path — the same service already driving `AvatarTtsComponent`. Zero new rendering code.

### Conflict avoidance:

- `AvatarTtsComponent` is also embedded in `/gesture-studio`. Since `TtsLipsyncService` won't be active (no TTS in the studio), the mouth channels are idle and gesture playback has full control.
- During raw frame playback (pre-compilation preview), the recorder bypasses `GesturePlayerService` and writes directly to the avatar's mesh morphs via a shared `AvatarTtsComponent` reference or an Output event.

---

## 7. File Map (new files only)

```
src/app/
├── lib/
│   └── motion/
│       ├── motion.models.ts              ← MotionFrame, MotionRecording interfaces
│       └── rdp-decimator.ts              ← Ramer-Douglas-Peucker implementation
├── services/
│   ├── motion-recorder.service.ts        ← rAF-based capture loop
│   ├── motion-compiler.service.ts        ← frames → GestureDef
│   ├── motion-store.service.ts           ← IndexedDB CRUD
│   └── custom-gesture-registry.service.ts← runtime GESTURE_MAP patching
└── pages/
    └── gesture-studio/
        ├── gesture-studio.component.ts   ← page shell, route /gesture-studio
        └── components/
            ├── recording-panel.component.ts
            ├── gesture-list.component.ts
            ├── motion-timeline.component.ts
            └── gesture-detail.component.ts
```

**Modified files (minimal):**
- `app.routes.ts` — add `/gesture-studio` lazy route.
- `home.component.ts` — add nav link to Gesture Studio.

---

## 8. Open Questions / Decisions Needed Before Coding

1. **Camera sharing**: Should the gesture studio start its own camera stream, or share the existing `FaceTrackingService` singleton (which means camera must not be already running in another tab)?  
   → Recommendation: share the singleton, same as `ArFaceTrackingComponent`.

2. **Keyframe editor depth**: Full draggable SVG timeline in Phase 1, or simple numeric table first?  
   → Recommendation: Phase 1 ships numeric table + preview; SVG timeline in Phase 2.

3. **Persistence of built-in gestures**: The 6 built-in gestures (`GESTURE_LIBRARY`) are compiled TypeScript. Should the studio allow editing them?  
   → Recommendation: read-only in UI, but "Fork" creates a `custom_*` copy.

4. **Mouth channel recording**: Mouth morphs conflict with lipsync visemes. Record them for expression clips (`allowMouth: true`), or block entirely?  
   → Recommendation: allow, gated behind the "Mouth" toggle, with a visible warning that these only play when TTS is silent.

5. **Auto-registration on startup**: Should all saved custom gestures be available immediately in `/text-avatar` (via `CustomGestureRegistryService` loading from IndexedDB at app boot)?  
   → Recommendation: yes — the registry service loads in its constructor and patches `GESTURE_MAP` before any gesture is triggered.
