# Gesture Studio — Voice Recording, TTS Conversion & Lipsync-Aligned Playback
## Technical Plan

---

## 0. Executive Summary

The goal is to layer three capabilities on top of the existing gesture recording pipeline:

1. **Capture mic audio** during a recording session (same duration window as face tracking).
2. **Convert that audio** to the selected Piper/Azure TTS voice via STT → re-synthesis.
3. **Play back** the synthesized audio in time-lock with the recorded avatar motion, with mouth morphs driven by lipsync analysis of the synthesized audio rather than the captured mouth channel.

The plan covers two delivery phases:
- **Phase 1 — No-cloud**: Web Speech API (live STT) + Piper VITS (already in the project) + existing `textToVisemes()` rule-based lipsync.
- **Phase 2 — Azure Speech Services**: Azure STT on recorded audio + Azure Neural TTS with real-time viseme events → highest quality, production-grade Spanish/English support.

---

## 1. Current Architecture — Relevant Entry Points

### 1.1 Face-tracking capture
`MotionRecorderService.startRecording(durationSec, channels)` runs a rAF loop calling `captureFrame()` at ~30 fps. It reads from `FaceTrackingService.blendshapes()` and `.rotation()` and stores baseline-subtracted `MotionFrame[]`.

### 1.2 TTS + lipsync (existing)
`TtsLipsyncService.speak(text, opts)` does:
1. `textToVisemes(text, lang)` → relative `VisemeEvent[]`
2. `PiperClient.synthesizeWav(text, voiceId)` → `ArrayBuffer` (WAV) in a Web Worker
3. Decode WAV → `AudioBuffer`, measure actual `duration`
4. `scaleTimeline(events, duration)` → absolute `VisemeFrame[]`
5. Schedule `AudioBufferSourceNode` + set `this.active = { frames, anchor, clock: 'audio' }`
6. `AvatarTtsComponent` calls `getMouthWeights()` each rAF frame → sampled from `active.frames`

### 1.3 Gesture playback
`GesturePlayerService.trigger(id)` advances phase at `speedMultiplier / cycleDurationSec` cycles/sec. The compiled `GestureDef` has normalized keyframes (t: 0→1) and `cycleDurationSec` = recorded duration.

### 1.4 Mouth conflict guard
`shouldFilterMouth(allowMouthNow, target)` in `GesturePlayerService` blocks mouth morphs from gesture channels during normal play. Gestures compiled with `allowMouth: true` bypass the guard when `trigger()` auto-detects it — but TTS lipsync always owns the mouth when audio is playing.

---

## 2. Audio Capture Integration

### 2.1 Mic stream acquisition
The camera stream is already open in `FaceTrackingService`. We need a **separate** audio-only stream:

```typescript
// In MotionRecorderService.startRecording() — only when channels.voice === true
const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
```

Request this **before** the rAF loop starts, during `enableCamera()`. Store it as `private audioStream: MediaStream | null`.

### 2.2 MediaRecorder lifecycle

```typescript
private mediaRecorder: MediaRecorder | null = null;
private audioChunks: Blob[] = [];

startVoiceCapture(): void {
    if (!this.audioStream) return;
    // Prefer Opus in WebM (best compression, widely supported); fall back to browser default
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus' : '';
    this.mediaRecorder = new MediaRecorder(this.audioStream, mimeType ? { mimeType } : {});
    this.audioChunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
    };
    this.mediaRecorder.start(100); // 100 ms chunks → low latency on stop
}

async stopVoiceCapture(): Promise<ArrayBuffer | null> {
    if (!this.mediaRecorder) return null;
    return new Promise(resolve => {
        this.mediaRecorder!.onstop = async () => {
            const blob = new Blob(this.audioChunks, { type: this.mediaRecorder!.mimeType });
            resolve(await blob.arrayBuffer());
        };
        this.mediaRecorder!.stop();
    });
}
```

### 2.3 Integration with `startRecording()` / `stopRecording()`
Extend the `recordingComplete$` subject payload:

```typescript
recordingComplete$.next({
    frames,
    duration,
    channels: this.channelConfig,
    rawAudioData: audioArrayBuffer ?? undefined,   // NEW
});
```

`stopRecording()` becomes `async` (or splits into an immediate stop + async finalization callback).

### 2.4 `RecordChannelConfig` extension

```typescript
export interface RecordChannelConfig {
    brows: boolean;
    eyes: boolean;
    head: boolean;
    mouth: boolean;
    voice: boolean;   // NEW — capture mic audio alongside face tracking
}

export const DEFAULT_CHANNEL_CONFIG: RecordChannelConfig = {
    brows: true, eyes: true, head: true, mouth: true, voice: false,
};
```

`voice: false` by default — opt-in, since mic permission adds a browser prompt.

---

## 3. Transcription & Voice Conversion Pipeline

### 3.1 Phase 1 — No cloud (Web Speech API + Piper)

**Constraint**: `SpeechRecognition` only accepts live mic, not pre-recorded files. Two options:

**Option A — Concurrent recognition during recording (recommended for Phase 1)**
Start a `SpeechRecognition` session at the same moment as `MediaRecorder`. It runs against the live mic stream in parallel:

```typescript
private recognition: SpeechRecognition | null = null;
private liveTranscript = '';

startSpeechRecognition(lang: 'es-MX' | 'es-ES' | 'en-US'): void {
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) return; // not available (Firefox, some mobile)
    this.recognition = new SpeechRec();
    this.recognition.lang = lang;
    this.recognition.interimResults = true;
    this.recognition.continuous = true;
    this.recognition.onresult = (e: any) => {
        // Accumulate final results
        let t = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) t += e.results[i][0].transcript + ' ';
        }
        if (t) this.liveTranscript += t;
    };
    this.recognition.start();
}

stopSpeechRecognition(): string {
    this.recognition?.stop();
    const result = this.liveTranscript.trim();
    this.liveTranscript = '';
    return result;
}
```

**Limitation**: Web Speech API sends audio to Google's servers. Requires internet. Works in Chrome/Edge; Firefox support varies.

**Option B — User types/confirms transcript post-recording**
A simpler fallback: show a text input pre-populated with "…" after recording stops. The user types or pastes the script they spoke. This is the reliable fallback when `SpeechRecognition` is unavailable.

**TTS re-synthesis (Phase 1)**
After transcript is confirmed:

```typescript
// In a new VoiceConversionService (or extend MotionRecorderService)
async convertToTtsVoice(
    transcript: string,
    voiceId: string,
    lang: TtsLang
): Promise<{ ttsAudioData: ArrayBuffer; ttsAudioDurationSec: number; lipsyncFrames: VisemeFrame[] }> {
    // 1. Synthesize via existing PiperClient
    const wavData = await this.piper.synthesizeWav(transcript, voiceId);

    // 2. Decode to measure actual duration
    const audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(wavData.slice(0));
    const ttsAudioDurationSec = audioBuffer.duration;
    audioCtx.close();

    // 3. Rule-based viseme timeline (same path as TtsLipsyncService.speak())
    const events = textToVisemes(transcript, lang);
    const lipsyncFrames = scaleTimeline(events, ttsAudioDurationSec);

    return { ttsAudioData: wavData, ttsAudioDurationSec, lipsyncFrames };
}
```

### 3.2 Phase 2 — Azure Speech Services (recommended for production)

**Why Azure over Phase 1:**
- STT works on recorded audio files — no concurrent recognition needed.
- TTS `SpeechSynthesizer` emits real-time viseme events with audio-offset timestamps.
- Supports `es-MX-DaliaNeural`, `es-US-PalomaNeural`, `en-US-AriaNeural`, etc.
- Single SDK handles both STT and TTS.

**Azure STT on recorded audio:**

```typescript
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';

async transcribe(audioData: ArrayBuffer, lang: string, key: string, region: string): Promise<string> {
    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(key, region);
    speechConfig.speechRecognitionLanguage = lang; // 'es-MX', 'es-US', 'en-US'

    // Push stream — feeds recorded bytes without re-accessing mic
    const pushStream = SpeechSDK.AudioInputStream.createPushStream();
    pushStream.write(audioData);
    pushStream.close();

    const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(pushStream);
    const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

    return new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(result => {
            recognizer.close();
            if (result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
                resolve(result.text);
            } else {
                reject(new Error(`STT failed: ${SpeechSDK.ResultReason[result.reason]}`));
            }
        });
    });
}
```

**Azure TTS with viseme events:**

```typescript
interface AzureVisemeEvent { audioOffsetMs: number; visemeId: number; }

// Azure uses 21 viseme IDs (0=sil, 1=PP, 2=FF, 3=TH, 4=DD, 5=kk, 6=CH,
//   7=SS, 8=nn, 9=RR, 10=aa, 11=E, 12=I, 13=O, 14=U, ...)
// Map to our Viseme type:
const AZURE_VISEME_TO_OUR: Record<number, Viseme> = {
    0: 'sil', 1: 'PP', 2: 'FF', 3: 'TH', 4: 'DD', 5: 'kk', 6: 'CH',
    7: 'SS', 8: 'nn', 9: 'RR', 10: 'aa', 11: 'E', 12: 'I', 13: 'O', 14: 'U',
    // 15-20 map to closest existing visemes
    15: 'aa', 16: 'O', 17: 'U', 18: 'SS', 19: 'nn', 20: 'sil',
};

async synthesizeWithVisemes(
    transcript: string, voiceName: string, key: string, region: string
): Promise<{ audioData: ArrayBuffer; visemeEvents: AzureVisemeEvent[] }> {
    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(key, region);
    speechConfig.speechSynthesisVoiceName = voiceName;
    speechConfig.speechSynthesisOutputFormat =
        SpeechSDK.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;

    const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, null);
    const visemeEvents: AzureVisemeEvent[] = [];

    synthesizer.visemeReceived = (s, e) => {
        visemeEvents.push({
            audioOffsetMs: e.audioOffset / 10000, // 100-ns ticks → ms
            visemeId: e.visemeId,
        });
    };

    return new Promise((resolve, reject) => {
        synthesizer.speakTextAsync(transcript, result => {
            synthesizer.close();
            if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
                resolve({ audioData: result.audioData, visemeEvents });
            } else {
                reject(new Error(result.errorDetails));
            }
        }, reject);
    });
}
```

**Building `VisemeFrame[]` from Azure events:**

```typescript
function azureVisemesToFrames(events: AzureVisemeEvent[], audioDurationSec: number): VisemeFrame[] {
    const frames: VisemeFrame[] = [];
    for (let i = 0; i < events.length; i++) {
        const tStart = events[i].audioOffsetMs / 1000;
        const tEnd = i + 1 < events.length
            ? events[i + 1].audioOffsetMs / 1000
            : audioDurationSec;
        frames.push({
            viseme: AZURE_VISEME_TO_OUR[events[i].visemeId] ?? 'sil',
            tStart,
            tEnd,
        });
    }
    return frames;
}
```

### 3.3 API key management
Both phases require externally supplied credentials. Store as Angular environment variables:

```typescript
// src/environments/environment.ts
export const environment = {
    azureSpeechKey: '',      // set by user in Settings UI
    azureSpeechRegion: '',   // e.g. 'eastus'
};
```

A small settings panel (or `localStorage`) lets the user enter keys once. Phase 1 (Web Speech + Piper) needs no keys.

---

## 4. Time Alignment — Gesture Duration vs. TTS Audio Duration

### 4.1 The problem
Recorded motion = `recordedDurationSec` (e.g. 3.0 s).
Synthesized TTS = `ttsAudioDurationSec` (e.g. 2.4 s — same words spoken faster by the TTS voice).

Keyframes in `compiledGesture` are normalized 0→1 and `cycleDurationSec = recordedDurationSec`.
Playing audio at 2.4 s while gesture runs for 3.0 s = desync.

### 4.2 Recommended strategy: Scale gesture to audio (Strategy A)

At playback time, before triggering the gesture, patch `cycleDurationSec`:

```typescript
// In gesture-studio.component.ts playPreview()
const attachment = rec.voiceAttachment;
if (attachment?.ttsAudioDurationSec && rec.compiledGesture) {
    // Temporarily override cycleDurationSec so phase velocity matches audio
    rec.compiledGesture.cycleDurationSec = attachment.ttsAudioDurationSec;
}
```

This is zero-cost — keyframes are already normalized, changing `cycleDurationSec` instantly adjusts how fast phase advances. No re-compilation needed.

**Trade-off**: motion plays slightly faster/slower than recorded. This is perceptually acceptable for ±20% delta; for larger deltas the user can re-record or use Strategy B.

### 4.3 Fallback strategy: Stretch audio to gesture (Strategy B)
Use `AudioBufferSourceNode.playbackRate` to stretch audio to match motion:

```typescript
sourceNode.playbackRate.value = attachment.ttsAudioDurationSec / rec.compiledGesture.cycleDurationSec;
```

Limitation: changes pitch (no pitch correction without extra DSP).

### 4.4 UI control
Add a toggle in `GestureDetailComponent`:
- "Gesture drives timing" (Strategy B — audio stretched to match motion)
- "Voice drives timing" (Strategy A — gesture scaled to match audio) ← **default**

---

## 5. Lipsync Integration — TTS Visemes vs. Recorded Mouth Channel

### 5.1 Priority model

| Condition | Mouth driven by |
|-----------|----------------|
| `voiceAttachment.lipsyncFrames` present + audio playing | TTS viseme track (highest priority) |
| No voice attachment, `allowMouth = true`, gesture playing | Recorded mouth keyframe channel |
| Neither | Idle (mouth stays at rest) |

The TTS viseme track **always wins** when audio is active. The recorded mouth channel exists only as a fallback for silent playback.

### 5.2 New `TtsLipsyncService` method: `playVisemeTrack()`

```typescript
/**
 * Play a pre-recorded voice attachment: schedules audio and sets up the
 * viseme timeline so getMouthWeights() drives the avatar's mouth correctly.
 * Called by gesture-studio when previewing a gesture with a voice attachment.
 */
async playVisemeTrack(audioData: ArrayBuffer, lipsyncFrames: VisemeFrame[]): Promise<void> {
    if (this.active) this.stopCurrent();

    const ctx = this.getAudioContext();
    const audioBuffer = await ctx.decodeAudioData(audioData.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const anchor = ctx.currentTime;
    source.start(anchor);
    this.currentSources = [source];

    this.active = {
        frames: lipsyncFrames,
        anchor,
        duration: audioBuffer.duration,
        clock: 'audio',
    };
    this.state.set('speaking');

    source.onended = () => {
        if (this.active?.anchor === anchor) {
            this.active = null;
            this.state.set('idle');
        }
    };
}
```

`getMouthWeights()` already samples `this.active` — no changes needed there.

### 5.3 Mouth channel conflict guard (unchanged)

`GesturePlayerService.shouldFilterMouth()` still filters gesture mouth morphs when `allowMouthNow = false`. When audio is playing via `playVisemeTrack()`, `TtsLipsyncService.state()` is `'speaking'`, so the TTS viseme track owns the mouth exclusively.

When there is no voice attachment (silent preview), `trigger()` auto-detects `allowMouth: true` and the recorded mouth keyframe channel plays normally — this is the existing bug-fixed behavior.

### 5.4 Synchronized trigger — gesture + audio together

```typescript
// In gesture-studio.component.ts
async playGestureWithVoice(rec: MotionRecording): Promise<void> {
    const attachment = rec.voiceAttachment;
    const def = rec.compiledGesture;
    if (!def) return;

    if (attachment?.ttsAudioData && attachment.lipsyncFrames) {
        // Scale gesture duration to audio duration (Strategy A)
        def.cycleDurationSec = attachment.ttsAudioDurationSec ?? def.cycleDurationSec;

        // Start audio + viseme track first (AudioContext scheduling guarantees sub-ms precision)
        await this.tts.playVisemeTrack(attachment.ttsAudioData, attachment.lipsyncFrames);

        // Trigger gesture immediately after — both start on the same event-loop tick
        this.player.trigger(def.id);
    } else {
        // Silent fallback
        this.player.trigger(def.id);
    }
}
```

---

## 6. Data Model Extension

### 6.1 `VoiceAttachment` interface (new in `motion.models.ts`)

```typescript
import { VisemeFrame } from '../lipsync/text-to-visemes';

export interface VoiceAttachment {
    /** Raw mic recording (ArrayBuffer stored in IndexedDB audioStore). */
    rawAudioData?: ArrayBuffer;
    /** MIME type of rawAudioData, e.g. 'audio/webm;codecs=opus' */
    rawAudioMimeType?: string;

    /** STT transcript — confirmed by user before re-synthesis. */
    transcript?: string;
    /** Whether the user has explicitly confirmed/edited the transcript. */
    transcriptConfirmed: boolean;

    /** Re-synthesized WAV (ArrayBuffer stored in IndexedDB audioStore). */
    ttsAudioData?: ArrayBuffer;
    /** Decoded duration of ttsAudioData in seconds. */
    ttsAudioDurationSec?: number;

    /** Pre-computed viseme timeline aligned to ttsAudioData. */
    lipsyncFrames?: VisemeFrame[];

    /** Voice ID used for synthesis (Piper voice ID or Azure voice name). */
    voiceId?: string;
    /** Provider: 'piper' | 'azure'. */
    provider?: 'piper' | 'azure';
}
```

### 6.2 `MotionRecording` update

```typescript
export interface MotionRecording {
    id: string;
    label: string;
    category: RecordingCategory;
    duration: number;
    frameCount: number;
    fps: number;
    frames: MotionFrame[];
    compiledGesture: GestureDef | null;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    /** Optional — absent for silent (motion-only) recordings. */
    voiceAttachment?: VoiceAttachment;
}
```

### 6.3 IndexedDB — audio storage

`MotionStudioDB` currently stores `MotionRecording[]` inline. `ArrayBuffer` blobs (raw audio: ~200 KB–2 MB, TTS WAV: ~100–500 KB) must not be stored inline in the recording object — they bloat reads for every recording list load.

Add a separate `audioStore` (object store) keyed by `MotionRecording.id`:

```typescript
// In motion-db.service.ts
const DB_VERSION = 2; // bump from 1

request.onupgradeneeded = (e) => {
    const db = (e.target as IDBOpenDBRequest).result;
    if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('audio')) {  // NEW in v2
        db.createObjectStore('audio', { keyPath: 'id' });
    }
};

// audio store entry shape:
interface AudioEntry {
    id: string;           // same as MotionRecording.id
    rawAudioData?: ArrayBuffer;
    rawAudioMimeType?: string;
    ttsAudioData?: ArrayBuffer;
}
```

Save/load: when persisting a recording, strip `VoiceAttachment.rawAudioData` and `ttsAudioData` from the inline object, write them to `audioStore` separately. On load, merge them back.

---

## 7. Required UI Changes

### 7.1 `RecordingPanelComponent`

**New channel toggle: Voice**
```html
<label class="chk" [class.disabled]="recorder.isRecording()">
    <input type="checkbox" [(ngModel)]="channels.voice" [disabled]="recorder.isRecording()" />
    🎙 Voice
</label>
<p class="note" *ngIf="channels.voice">Captures mic audio for TTS voice conversion.</p>
```

**After recording — voice attachment section (shown when `channels.voice` was on)**:
```html
<div *ngIf="pendingAudio">
    <audio controls [src]="pendingAudioUrl" style="width:100%"></audio>

    <!-- Transcript: populated by Web Speech API or entered by user -->
    <label class="field-label">Transcript</label>
    <textarea [(ngModel)]="transcript" rows="2" placeholder="Type what you said…"></textarea>

    <!-- Voice selector -->
    <label class="field-label">Convert to voice</label>
    <select [(ngModel)]="selectedVoiceId">
        <option *ngFor="let v of piperVoices" [value]="v.id">{{ v.label }}</option>
    </select>

    <button class="btn" (click)="convertVoice()" [disabled]="converting || !transcript.trim()">
        {{ converting ? 'Converting…' : '🔄 Convert Voice' }}
    </button>

    <!-- Status: synth done -->
    <div *ngIf="ttsReady" class="status-ok">✅ Voice converted — {{ ttsAudioDurationSec.toFixed(1) }}s</div>
</div>
```

### 7.2 `GestureDetailComponent`

New collapsible **Voice** section:
- Raw audio player (`<audio>` with blob URL)
- Transcript (editable, "Re-synthesize" button)
- Synthesized audio player
- Duration comparison: `Gesture: Xs  /  Voice: Ys  /  Δ: ±Z%`
- Timing mode toggle: "Voice drives timing" ↔ "Gesture drives timing"

### 7.3 `GestureStudioComponent`

**Preview button** becomes "Preview + Audio" when `selectedRecording().voiceAttachment?.ttsAudioData` exists:
```html
<button class="btn" (click)="playPreview()" [disabled]="!canPreview()">
    {{ hasVoice() ? '▶ Preview + Audio' : '▶ Preview' }}
</button>
```

**Global voice selector** (persistent via localStorage) shown in the header or settings drawer for Azure provider selection.

### 7.4 Settings drawer (new — Azure keys only)

```html
<!-- Shown when provider === 'azure' -->
<div class="section-head">Azure Speech</div>
<input [(ngModel)]="azureKey" placeholder="Speech resource key" type="password" />
<input [(ngModel)]="azureRegion" placeholder="Region (e.g. eastus)" />
<button (click)="saveAzureConfig()">Save</button>
```

---

## 8. New Service: `VoiceConversionService`

All audio processing lives in a single new service, keeping `MotionRecorderService` focused on motion:

```typescript
@Injectable({ providedIn: 'root' })
export class VoiceConversionService {
    private piper = new PiperClient();

    // Phase 1: Piper path
    async convertPiper(
        transcript: string, voiceId: string, lang: TtsLang
    ): Promise<VoiceAttachment> { ... }

    // Phase 2: Azure path
    async transcribeAzure(audioData: ArrayBuffer, lang: string): Promise<string> { ... }
    async convertAzure(
        transcript: string, voiceName: string
    ): Promise<VoiceAttachment> { ... }

    // Shared: decode audio duration
    async measureDuration(audioData: ArrayBuffer): Promise<number> {
        const ctx = new AudioContext();
        const buf = await ctx.decodeAudioData(audioData.slice(0));
        await ctx.close();
        return buf.duration;
    }
}
```

---

## 9. Implementation Phases & Task Breakdown

### Phase 1 (No cloud — complete foundation)

| # | Task | Files |
|---|------|-------|
| P1-1 | Add `voice` field to `RecordChannelConfig` + `DEFAULT_CHANNEL_CONFIG` | `motion.models.ts` |
| P1-2 | Add `VoiceAttachment` interface + `audioStore` to `MotionStudioDB` | `motion.models.ts`, `motion-db.service.ts` |
| P1-3 | `MotionRecorderService`: mic stream + `MediaRecorder` capture | `motion-recorder.service.ts` |
| P1-4 | `VoiceConversionService`: Piper path (`convertPiper`) | new `voice-conversion.service.ts` |
| P1-5 | `TtsLipsyncService.playVisemeTrack()` | `tts-lipsync.service.ts` |
| P1-6 | `gesture-studio.component.ts`: `playGestureWithVoice()` + updated preview | `gesture-studio.component.ts` |
| P1-7 | `RecordingPanelComponent`: voice toggle + transcript UI + convert button | `recording-panel.component.ts` |
| P1-8 | `GestureDetailComponent`: voice attachment section | `gesture-detail.component.ts` |

### Phase 2 (Azure — quality upgrade, additive)

| # | Task | Files |
|---|------|-------|
| P2-1 | Install `microsoft-cognitiveservices-speech-sdk` | `package.json` |
| P2-2 | `VoiceConversionService`: Azure STT + TTS with viseme events | `voice-conversion.service.ts` |
| P2-3 | `AZURE_VISEME_TO_OUR` mapping | new `lib/lipsync/azure-viseme-map.ts` |
| P2-4 | Settings drawer for Azure keys | `gesture-studio.component.ts` or new `settings-drawer.component.ts` |
| P2-5 | Azure voice list for `PIPER_VOICES` equivalent | `tts-lipsync.service.ts` |

---

## 10. Known Limitations & Edge Cases

| Issue | Mitigation |
|-------|-----------|
| Web Speech API requires Chrome/Edge and internet | Show fallback text input for transcript; Firefox users type manually |
| `SpeechRecognition` can miss words at start of recording | Add 200 ms pre-roll silence before recognition starts |
| TTS duration ≠ recording duration (typical ±15–30%) | Strategy A (scale gesture to audio) is default; UI toggle for Strategy B |
| Azure viseme IDs 15–20 have no direct equivalent | Mapped to nearest phonetically similar viseme; perceptually acceptable |
| Raw audio blob ~500 KB–2 MB in IndexedDB | Separate `audioStore`; strip from inline recording object on save |
| Piper synthesis blocks the worker for long transcripts | Already handled by existing `PiperClient` worker architecture |
| `playVisemeTrack()` called twice (double click) | Guard: `if (this.state() === 'speaking') return;` |
| Recording interrupted (tab hidden, camera lost) | `stopRecording()` path already handles early stop; audio chunks assembled from partial data |

---

## 11. Recommendation

For the first implementation sprint, build Phase 1 end-to-end:
- It requires zero new API keys.
- The Piper TTS path is already battle-tested in the project.
- The `textToVisemes()` rule-based lipsync already works well for Spanish.
- The foundation (data model, audio store, `playVisemeTrack()`, time alignment) is identical for Phase 2 — Azure is purely an additive upgrade to `VoiceConversionService`.

Once Phase 1 is validated with real recordings, add Phase 2 by replacing the STT and TTS internals of `VoiceConversionService` with Azure SDK calls, keeping all other layers (data model, player integration, UI) unchanged.
