import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import {
    textToVisemes, scaleTimeline, findSpeechBounds, VisemeFrame
} from '../lib/lipsync/text-to-visemes';
import { parseGestureMarkup } from '../lib/gestures/gesture-markup';
import { GESTURES_BODY_ENABLED } from '../lib/config/feature-flags';
import { speakNumericSequences, hasLongDigitRun } from '../lib/lipsync/number-speech';
import { GESTURE_MAP, CYCLE_BASE_SECONDS, SPEED_MULTIPLIER_MIN, SPEED_MULTIPLIER_MAX } from '../lib/gestures/gesture-library';
import { GesturePlayerService, now as wallNow } from './gesture-player.service';
import { Viseme, VISEME_TO_ARKIT, BlendWeights } from '../lib/lipsync/viseme-map';
import { buildSpeechTimeline, SpeechTimelineSegment, TimelineGesture, EXPRESSION_REGISTRY } from '../lib/lipsync/speech-timeline';
import {
    compilePerformance, expandSegments, planToJson, revealAtTime, ExpandedSegment, PerformancePlan, CompilerDeps
} from '../lib/performance/performance-compiler';
import { PiperClient } from '../lib/performance/piper-client';
import { TimingRecorder, speechStartLine, SpeechStartSummary } from '../lib/performance/timing';
import { splitProgressive } from '../lib/performance/progressive-split';

export type TtsProvider = 'piper' | 'webspeech';
export type TtsLang = 'es' | 'en';
export type TtsState = 'idle' | 'loading-engine' | 'synthesizing' | 'speaking';

export interface SpeakOptions {
    provider: TtsProvider;
    lang: TtsLang;
    /** Piper voice id, e.g. 'es_MX-claude-high' */
    voiceId?: string;
    /** instrumentation: reference t0 (e.g. llm_response_received, performance.now()) */
    timingStart?: number;
    /** instrumentation: called once when the first audio actually starts */
    onFirstAudio?: (summary: SpeechStartSummary) => void;
    /** Skip progressive early-start split and compile the full body as one plan.
     *  Use when a lead-in gesture/clip already covers synthesis latency. */
    singlePass?: boolean;
}

// Piper engine is an npm dependency: npm i @diffusionstudio/vits-web
// Synthesis runs in a Web Worker (src/app/workers/piper.worker.ts) so the
// render loop never blocks; falls back to main thread if workers fail.

export const PIPER_VOICES: Record<TtsLang, { id: string; label: string }[]> = {
    es: [
        { id: 'es_MX-claude-high', label: 'Claude (MX, alta calidad)' },
        { id: 'es_ES-davefx-medium', label: 'DaveFX (ES)' },
        { id: 'es_ES-sharvard-medium', label: 'Sharvard (ES)' },
        { id: 'es_MX-ald-medium', label: 'Ald (MX)' },
    ],
    en: [
        { id: 'en_US-hfc_female-medium', label: 'HFC Female (US)' },
        { id: 'en_US-ryan-high', label: 'Ryan (US, high)' },
    ],
};

/** Replies with total speech below this compile as ONE full plan up front. */
const FULL_PRECOMPILE_MAX_CHARS = 220;

/**
 * Max characters per progressive BODY (Part B) synthesis unit. Smaller -> each
 * unit synthesizes faster so prefetch stays ahead of playback (no inter-segment
 * stall); larger -> fewer boundaries. ~90 chars is roughly <=5 s of audio, whose
 * synth (~45% of audio duration) finishes well before the previous unit ends.
 * Tune here.
 */
const BODY_CHUNK_MAX_CHARS = 90;

/**
 * How many units to keep synthesizing AHEAD of the one currently playing. The
 * Piper worker is serial (FIFO) but accepts concurrent requests, so we keep a
 * sliding window of (SYNTH_LOOKAHEAD + 1) compiles in flight: the worker stays
 * continuously busy producing ahead of playback, so playback never catches up.
 * 1 = old behavior (marginal, caused ~1s underruns). 2 absorbs synth jitter. Tune here.
 */
const SYNTH_LOOKAHEAD = 2;

/**
 * Master switch for PROGRESSIVE (split + prefetch) playback. Default FALSE: the
 * (now short) summary is synthesized as ONE single-pass unit and played -- no
 * split, no concurrent prefetch, so only ONE main-thread timeline build happens
 * (no bunched bursts). Set true to re-enable the progressive/prefetch path.
 */
const PROGRESSIVE_ENABLED = false;

interface ActivePlayback {
    frames: VisemeFrame[];
    anchor: number;
    duration: number;
    clock: 'audio' | 'wall';
}

/**
 * Text -> TTS audio + viseme timeline.
 *
 * Piper path (compile -> play):
 *  1. PerformanceCompiler builds an immutable plan (all audio synthesized in a
 *     worker + decoded, speech windows measured, visemes + gestures on one
 *     absolute time axis) BEFORE playback.
 *  2. Playback is a dumb sampler: all AudioBufferSourceNodes scheduled up
 *     front against AudioContext.currentTime; per frame only the precomputed
 *     viseme track is sampled. Zero synthesis/decoding/fetching during play.
 *  Long replies use the hybrid: per-sentence units compiled in the worker
 *  while the previous unit plays (playback never reaches uncompiled audio:
 *  each unit is complete before it starts).
 * Expression clips are preloaded + decoded once at service init.
 */
@Injectable({ providedIn: 'root' })
export class TtsLipsyncService {
    public state: WritableSignal<TtsState> = signal('idle');
    public error: WritableSignal<string | null> = signal(null);
    public downloadProgress: WritableSignal<number | null> = signal(null);
    public currentViseme: WritableSignal<Viseme> = signal('sil');
    public gestureWarnings: WritableSignal<string[]> = signal([]);
    /** compile time of the last performance unit (ms) — perf visibility */
    public lastCompileMs: WritableSignal<number | null> = signal(null);
    /** compiled plans of the most recent piper speak() — consumers may cache for replay */
    public lastPerformance: PerformancePlan[] | null = null;
    /** true while waiting at a seam for the next part to finish compiling */
    public bridging: WritableSignal<boolean> = signal(false);
    /** karaoke: chars of the clean text spoken so far (page reveals up to here) */
    public revealedChars: WritableSignal<number> = signal(0);

    private gestures = inject(GesturePlayerService);

    private audioCtx: AudioContext | null = null;
    private piper = new PiperClient();
    private active: ActivePlayback | null = null;
    private currentSources: AudioBufferSourceNode[] = [];
    private pendingTimers: number[] = [];
    private pendingIntervals: number[] = [];
    private pendingTimerResolvers: Array<() => void> = [];
    private clipCache = new Map<string, Promise<AudioBuffer>>();
    private generation = 0;
    private timing: TimingRecorder | null = null;
    private timingOpts: SpeakOptions | null = null;
    private firstSynthMarked = false;
    private firstAudioReported = false;
    private speakStartMs = 0; // [tts.timing] call -> first segment audible
    private warmedVoice: string | null = null;

    constructor() {
        // Preload + decode expression clips once at init (they used to be
        // fetched/decoded on demand at trigger time -> first-use hitch).
        if (typeof window !== 'undefined' && typeof AudioContext !== 'undefined') {
            setTimeout(() => {
                try {
                    const ctx = this.ensureAudioCtx();
                    for (const e of Object.values(EXPRESSION_REGISTRY)) {
                        this.loadAudioClip(ctx, e.clipUrl).catch(err =>
                            console.warn('[tts] expression clip preload failed:', e.clipUrl, err?.message ?? err));
                    }
                } catch { /* no audio support */ }
            }, 0);
        }
    }

    // ---------------------------------------------------------------- public

    async speak(text: string, opts: SpeakOptions): Promise<void> {
        const trimmed = text?.trim();
        if (!trimmed) return;
        const tSpeakStart = performance.now(); // [tts.timing] total speak() duration
        this.speakStartMs = tSpeakStart;       // reset per utterance for time-to-first-audio

        // interrupt previous playback but let a waiting (transient) gesture
        // survive synthesis — it dies at the actual audio start (kill switch)
        this.stopInternal(true);
        const gen = ++this.generation;
        this.error.set(null);

        // per-reply timing instrumentation
        this.timing = new TimingRecorder(opts.timingStart ?? performance.now());
        this.timingOpts = opts;
        this.firstSynthMarked = false;
        this.firstAudioReported = false;

        const parsed = parseGestureMarkup(trimmed, new Set(GESTURE_MAP.keys()));
        this.gestureWarnings.set(parsed.warnings);
        for (const w of parsed.warnings) console.warn('[gestures]', w);

        // Inline BODY gestures gate (debug): when off, build the timeline with NO
        // gestures so the cold path does no gesture timeline integration / scheduling
        // / clip load. cleanText (tag-free) is still spoken with lip-sync.
        const gIn = GESTURES_BODY_ENABLED ? parsed.gestures : [];
        const tTimeline = performance.now();
        const plan = buildSpeechTimeline(parsed.cleanText, gIn);
        console.log(`[tts.timing] buildSpeechTimeline: ${Math.round(performance.now() - tTimeline)} ms (segments=${plan.segments.length})`);
        this.timing.mark('parse_split_done');

        if (!plan.segments.some(s => s.kind === 'speech') && plan.segments.length === 0) {
            const t0 = wallNow();
            for (const g of plan.gestures) this.gestures.schedule(g.id, t0, g.repetitions, g.speed);
            return;
        }

        try {
            // PROGRESSIVE for ALL piper replies, including the RAG summary that used
            // singlePass (all-at-once). Part A = first sentence -> synthesized + spoken
            // ASAP; Part B = the rest -> synthesized in the worker WHILE A plays. This
            // cuts time-to-first-audio and keeps the main thread from waiting on the
            // whole response. Gestures-off + digit-by-digit keep segments small (the
            // digit rewrite happens at synth time, so it does NOT add segments), so
            // there is no synchronous stall between segments.
            // PROGRESSIVE_ENABLED master flag (default false) -> single-pass for now.
            const split = (PROGRESSIVE_ENABLED && opts.provider === 'piper' && this.progressiveEnabled())
                ? splitProgressive(parsed.cleanText, plan.gestures, this.partAMaxWords())
                : null;
            if (opts.provider === 'piper' && split) {
                await this.speakProgressive(split, opts, gen);
            } else if (opts.provider === 'piper') {
                await this.speakPiper(plan.segments, plan.gestures, opts, gen);
            } else {
                await this.speakWebSpeech(plan.segments, plan.gestures, opts, gen);
            }
        } catch (e: any) {
            if (gen !== this.generation) return;
            console.error('TTS error:', e);
            this.error.set(e?.message ?? String(e));
        } finally {
            if (gen === this.generation) {
                this.state.set('idle');
                this.active = null;
                this.currentViseme.set('sil');
            }
            // [tts.timing] total: call -> audio-ready (provider, input chars, digit-run flag).
            console.log(
                `[tts.timing] speak total: ${Math.round(performance.now() - tSpeakStart)} ms` +
                ` provider=${opts.provider} chars=${trimmed.length} longDigitRun=${hasLongDigitRun(trimmed)}`,
            );
        }
    }

    stop(): void {
        this.stopInternal(false);
    }

    private stopInternal(keepTransient: boolean): void {
        this.generation++;
        this.gestures.clear({ keepTransient });
        for (const source of this.currentSources) {
            try { source.stop(); } catch { /* already stopped */ }
        }
        this.currentSources = [];
        for (const timer of this.pendingTimers) window.clearTimeout(timer);
        this.pendingTimers = [];
        for (const iv of this.pendingIntervals) window.clearInterval(iv);
        this.pendingIntervals = [];
        this.bridging.set(false);
        for (const resolve of this.pendingTimerResolvers) resolve();
        this.pendingTimerResolvers = [];
        try { window.speechSynthesis?.cancel(); } catch { /* unavailable */ }
        this.active = null;
        this.state.set('idle');
        this.currentViseme.set('sil');
    }

    /** Per-frame mouth sampling against the precompiled viseme track. */
    getMouthWeights(): BlendWeights {
        const a = this.active;
        if (!a || a.frames.length === 0) return {};

        const now = a.clock === 'audio'
            ? (this.audioCtx ? this.audioCtx.currentTime - a.anchor : 0)
            : performance.now() / 1000 - a.anchor;

        if (now < 0 || now > a.duration + 0.15) return {};

        let frame: VisemeFrame | null = null;
        let next: VisemeFrame | null = null;
        for (let i = 0; i < a.frames.length; i++) {
            if (now >= a.frames[i].tStart && now < a.frames[i].tEnd) {
                frame = a.frames[i];
                next = a.frames[i + 1] ?? null;
                break;
            }
        }
        if (!frame) return {};
        this.currentViseme.set(frame.viseme);

        const base = VISEME_TO_ARKIT[frame.viseme];
        const XFADE = 0.06;
        if (next && frame.tEnd - now < XFADE) {
            const p = 1 - (frame.tEnd - now) / XFADE;
            return this.mix(base, VISEME_TO_ARKIT[next.viseme], p);
        }
        return base;
    }

    /**
     * Play a pre-synthesized audio buffer with its pre-computed viseme timeline.
     * Used by gesture-studio to play back a gesture's converted TTS voice in sync.
     * Fully replaces any active speech — mouth morphs are driven by `lipsyncFrames`
     * via the normal `getMouthWeights()` path.
     */
    async playVisemeTrack(audioData: ArrayBuffer, lipsyncFrames: VisemeFrame[]): Promise<void> {
        this.stopInternal(false);
        const ctx = this.ensureAudioCtx();
        // Resume AudioContext if suspended (browser autoplay policy)
        if (ctx.state === 'suspended') await ctx.resume();

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

        // Return a Promise that resolves when the audio node fires onended
        // (either natural end or external stop). This makes playVisemeTrack
        // truly await-able so callers can sequence lead-in → body → tail.
        return new Promise<void>((resolve) => {
            source.onended = () => {
                if (this.active?.anchor === anchor) {
                    this.active = null;
                    this.state.set('idle');
                    this.currentViseme.set('sil');
                }
                this.currentSources = this.currentSources.filter(x => x !== source);
                resolve();
            };
        });
    }

    // ------------------------------------------------- piper: compile -> play

    private async speakPiper(segments: SpeechTimelineSegment[], gestures: TimelineGesture[], opts: SpeakOptions, gen: number): Promise<void> {
        const voiceId = opts.voiceId ?? PIPER_VOICES[opts.lang][0].id;
        const ctx = this.ensureAudioCtx();
        const expanded = expandSegments(segments);

        const deps = this.makeDeps(ctx, voiceId);

        // hybrid: short replies -> ONE fully precompiled plan; long replies ->
        // per-segment units compiled in the worker while the previous unit plays.
        //
        // singlePass is the RAG-summary path: a lead-in/filler already covers the
        // synth latency, so we FULLY pre-synthesize the whole summary as ONE unit
        // before playback. This avoids the first-play "freeze at every comma" — the
        // per-segment route stalls at clause boundaries when the worker can't
        // compile the next unit before the current one finishes. Replay (cached
        // lastPerformance) was always smooth; now the first play matches it.
        const totalSpeechChars = expanded.reduce((a, s) => a + (s.kind === 'speech' ? s.text.length : 0), 0);
        const fullPrecompile = opts.singlePass === true || totalSpeechChars <= FULL_PRECOMPILE_MAX_CHARS;
        const units: ExpandedSegment[][] = fullPrecompile
            ? [expanded]
            : expanded.map(s => [s]);
        const unitGestures = this.assignGesturesToUnits(units, gestures);

        this.state.set('synthesizing');
        this.lastPerformance = null;
        this.revealedChars.set(0);
        const captured: PerformancePlan[] = [];
        await this.playUnits(ctx, units, unitGestures, opts, gen, deps, captured, 0);
    }

    /**
     * Progressive (two-phase) playback: Part A = first sentence (capped at
     * partAMaxWords), tag-free, synthesized first -> starts playing within
     * ~1-2 s. Part B (rest + gestures + clips) compiles in the worker while
     * A plays and is appended on the same timeline. If B isn't ready at the
     * seam, a bridge state holds (mouth closed, '…' pill, subtle thinking
     * micro-gesture) — never a freeze, never overlapping audio.
     * lastPerformance captures A+B plans, so ↻ replays the full stitched
     * reply with no progressive gap.
     */
    private async speakProgressive(
        split: { partA: string; partB: string; partBOffset: number; gesturesB: TimelineGesture[] },
        opts: SpeakOptions, gen: number
    ): Promise<void> {
        const voiceId = opts.voiceId ?? PIPER_VOICES[opts.lang][0].id;
        const ctx = this.ensureAudioCtx();
        const deps = this.makeDeps(ctx, voiceId);
        const t0 = performance.now();

        this.state.set('synthesizing');
        this.lastPerformance = null;
        this.revealedChars.set(0);
        const captured: PerformancePlan[] = [];

        // Part A: single light unit, no gestures (top priority in the worker queue)
        const tlA = buildSpeechTimeline(split.partA, []);
        const planAPromise = compilePerformance(expandSegments(tlA.segments), [], opts.lang, deps);

        // Part B: queued right behind A in the worker (FIFO). Chunk into SMALL units
        // (BODY_CHUNK_MAX_CHARS) so each synthesizes fast and prefetch stays ahead.
        const tlB = buildSpeechTimeline(split.partB, split.gesturesB);
        const expandedB = expandSegments(tlB.segments, BODY_CHUNK_MAX_CHARS);
        const unitsB: ExpandedSegment[][] = expandedB.map(seg => [seg]);
        const unitGesturesB = this.assignGesturesToUnits(unitsB, tlB.gestures);

        const planA = await planAPromise;
        if (gen !== this.generation) return;
        captured.push(planA);
        this.lastPerformance = captured;
        this.lastCompileMs.set(planA.compileMs);
        console.log(`[tts] progressive: part A (${split.partA.split(/\s+/).length} words) ready in ${(performance.now() - t0).toFixed(0)} ms — first word now`);

        this.state.set('speaking');
        const playA = this.playPlan(ctx, planA, gen, 0);
        // compile B's first unit while A plays
        await this.playUnitsAfter(playA, ctx, unitsB, unitGesturesB, opts, gen, deps, captured, split.partBOffset);
    }

    private makeDeps(ctx: AudioContext, voiceId: string): CompilerDeps {
        // Digit language follows the Piper voice id prefix (es_*, en_*).
        const lang: 'es' | 'en' = voiceId.toLowerCase().startsWith('en') ? 'en' : 'es';
        return {
            synthesize: async (text: string) => {
                // FIX: rewrite long digit runs to digit-by-digit BEFORE phonemization,
                // so Piper doesn't expand "71974131981" into a giant cardinal. Only the
                // SPOKEN text is changed here; the visible chat bubble is untouched.
                const spoken = speakNumericSequences(text, lang);
                const digitRun = hasLongDigitRun(text);
                const first = !this.firstSynthMarked;
                if (first) { this.firstSynthMarked = true; this.timing?.mark('synthA_started'); }
                const tSynth = performance.now();
                const wav = await this.piper.synthesizeWav(spoken, voiceId, p => this.downloadProgress.set(p));
                const synthMs = Math.round(performance.now() - tSynth);
                if (first) this.timing?.mark('synthA_done');
                this.downloadProgress.set(null);
                const buffer = await ctx.decodeAudioData(wav);
                if (first) this.timing?.mark('decodeA_done');
                // [tts.timing] per-segment: chars, long-digit-run flag, Piper synth ms
                // (text->phonemes->audio; vits-web does not expose the phonemize step
                // separately), audio duration, and the POST-normalization text Piper saw.
                console.log(
                    `[tts.timing] piper synth: chars=${text.length} longDigitRun=${digitRun}` +
                    ` synthMs=${synthMs} audioSec=${buffer.duration.toFixed(2)} post=${JSON.stringify(spoken)}`,
                );
                return buffer;
            },
            getClip: (url: string) => this.loadAudioClip(ctx, url),
            measureBounds: findSpeechBounds,
        };
    }

    /** Plays compiled units sequentially with prefetch + bridge handling. */
    private async playUnits(
        ctx: AudioContext, units: ExpandedSegment[][], unitGestures: TimelineGesture[][],
        opts: SpeakOptions, gen: number, deps: CompilerDeps,
        captured: PerformancePlan[], revealOffset: number
    ): Promise<void> {
        if (!units.length) return;
        const first = compilePerformance(units[0], unitGestures[0], opts.lang, deps);
        await this.playUnitsAfter(Promise.resolve(), ctx, units, unitGestures, opts, gen, deps, captured, revealOffset, first);
    }

    private async playUnitsAfter(
        previousPlayback: Promise<void>,
        ctx: AudioContext, units: ExpandedSegment[][], unitGestures: TimelineGesture[][],
        opts: SpeakOptions, gen: number, deps: CompilerDeps,
        captured: PerformancePlan[], revealOffset: number,
        firstPending?: Promise<PerformancePlan>
    ): Promise<void> {
        const debugPlan = localStorage.getItem('textAvatar.debugPlan') === '1';
        if (!units.length) { await previousPlayback; return; }

        // Sliding compile window: keep up to (SYNTH_LOOKAHEAD + 1) units synthesizing
        // AHEAD of playback so the serial worker stays continuously busy. Concurrent
        // compilePerformance calls are safe (worker client multiplexes by id, FIFO).
        const compiles: (Promise<PerformancePlan> | null)[] = new Array(units.length).fill(null);
        const startCompile = (idx: number): void => {
            if (idx < 0 || idx >= units.length || compiles[idx]) return;
            compiles[idx] = compilePerformance(units[idx], unitGestures[idx], opts.lang, deps);
        };
        if (firstPending) compiles[0] = firstPending;
        // Prime the window (units 0..SYNTH_LOOKAHEAD) -- these synthesize DURING
        // previousPlayback (e.g. Part A), so a buffer is ready before unit 0 plays.
        for (let k = 0; k <= SYNTH_LOOKAHEAD; k++) startCompile(k);

        await previousPlayback;
        if (gen !== this.generation) return;

        for (let i = 0; i < units.length; i++) {
            startCompile(i); // safety (normally already primed)
            const pending = compiles[i]!;

            // bridge: if unit i isn't compiled yet, hold naturally. The render loop +
            // idle motion keep ticking; mouth falls to neutral (getMouthWeights
            // returns {} with no active plan) -- never a freeze or pose reset.
            let resolved = false;
            pending.then(() => { resolved = true; }, () => { resolved = true; });
            await Promise.resolve(); // let an already-settled promise mark itself
            const underrunStart = resolved ? 0 : performance.now();
            if (!resolved) {
                this.bridging.set(true);
                if (this.waitingAnimsEnabled()) {
                    this.gestures.triggerTransient('thinking', 1, 'fast'); // subtle micro-gesture, killed at audio start
                }
            }
            const plan = await pending;
            this.bridging.set(false);
            if (underrunStart) {
                console.log(`[tts.timing] prefetch underrun: waited ${Math.round(performance.now() - underrunStart)} ms for next unit`);
            }
            if (gen !== this.generation) return;
            captured.push(plan);
            this.lastPerformance = captured;
            // Keep the window full: kick off the unit SYNTH_LOOKAHEAD beyond the next.
            startCompile(i + 1 + SYNTH_LOOKAHEAD);
            this.lastCompileMs.set(plan.compileMs);
            console.log(`[tts] unit ${i + 1}/${units.length}: compiled ${plan.duration.toFixed(1)} s audio in ${plan.compileMs.toFixed(0)} ms`);
            if (debugPlan) console.log('[tts] PerformancePlan', JSON.stringify(planToJson(plan), null, 2));

            this.state.set('speaking');
            await this.playPlan(ctx, plan, gen, revealOffset);
            if (gen !== this.generation) return;
        }
    }

    /**
     * Re-perform previously compiled plans (replay button): instant, zero
     * synthesis — buffers are already decoded inside the plans.
     */
    async replayPerformance(plans: PerformancePlan[]): Promise<void> {
        if (!plans?.length) return;
        this.stop(); // interrupts anything playing (generation token)
        const gen = ++this.generation;
        const ctx = this.ensureAudioCtx();
        try {
            this.state.set('speaking');
            for (const plan of plans) {
                if (gen !== this.generation) return;
                await this.playPlan(ctx, plan, gen);
            }
        } finally {
            if (gen === this.generation) {
                this.state.set('idle');
                this.active = null;
                this.currentViseme.set('sil');
            }
        }
    }

    /** Each gesture goes to the first unit whose source range covers/follows it. */
    private assignGesturesToUnits(units: ExpandedSegment[][], gestures: TimelineGesture[]): TimelineGesture[][] {
        const ranges = units.map(unit => {
            let end = -1;
            for (const s of unit) {
                end = Math.max(end, s.kind === 'speech' ? s.sourceEnd : s.sourceIndex);
            }
            return end;
        });
        const out: TimelineGesture[][] = units.map(() => []);
        for (const g of gestures) {
            let idx = ranges.findIndex(end => g.charIndex <= end);
            if (idx < 0) idx = units.length - 1;
            out[idx].push(g);
        }
        return out;
    }

    /**
     * Dumb sampler playback: every source scheduled up front on the audio
     * clock; gestures scheduled on the wall clock; mouth sampled per frame
     * from the plan's viseme track. Nothing is computed during playback.
     */
    /** Audio scheduling slack: small cushion so start(base) is never in the past. */
    private static readonly SCHEDULING_SLACK_S = 0.025;

    private playPlan(ctx: AudioContext, plan: PerformancePlan, gen: number, revealOffset = 0): Promise<void> {
        return new Promise(resolve => {
            if (gen !== this.generation) { resolve(); return; }
            const base = ctx.currentTime + TtsLipsyncService.SCHEDULING_SLACK_S;
            const wallBase = wallNow() + TtsLipsyncService.SCHEDULING_SLACK_S;

            // AUDIO FIRST: schedule every source synchronously before any
            // gesture/reveal bookkeeping — speech start is gated ONLY on the
            // decoded plan being ready, never on animation state.
            for (const ev of plan.events) {
                if (ev.type === 'speech' || ev.type === 'clip') {
                    const buffer = plan.buffers.get(ev.bufferId);
                    if (!buffer) { console.warn('[tts] missing buffer in plan:', ev.bufferId); continue; }
                    const source = ctx.createBufferSource();
                    source.buffer = buffer;
                    source.connect(ctx.destination);
                    source.start(base + ev.t0);
                    this.currentSources.push(source);
                    source.onended = () => {
                        this.currentSources = this.currentSources.filter(x => x !== source);
                    };
                }
            }
            this.timing?.mark('audio_scheduled');

            // KILL SWITCH (parallel, never gates audio): waiting/bridge gestures
            // end exactly when this plan's audio starts
            const killAt = window.setTimeout(() => {
                this.pendingTimers = this.pendingTimers.filter(x => x !== killAt);
                this.gestures.cancelTransient();
                this.reportFirstAudio();
            }, Math.max(0, (base - ctx.currentTime) * 1000));
            this.pendingTimers.push(killAt);

            // karaoke reveal: sample spoken chars on a light interval
            const maxSrcEnd = plan.events.reduce((a, e) => e.type === 'speech' ? Math.max(a, e.srcEnd) : a, 0);
            const iv = window.setInterval(() => {
                const t = ctx.currentTime - base;
                if (t >= 0) {
                    const r = revealOffset + revealAtTime(plan.events, t);
                    if (r > this.revealedChars()) this.revealedChars.set(r);
                }
            }, 60);
            this.pendingIntervals.push(iv);

            for (const g of plan.gestures) {
                this.gestures.schedule(g.gestureId, wallBase + g.t, g.repetitions, g.speed as any, g.allowMouth ?? false);
            }

            this.active = { frames: plan.visemeTrack, anchor: base, duration: plan.duration, clock: 'audio' };

            const timer = window.setTimeout(() => {
                this.pendingTimers = this.pendingTimers.filter(t => t !== timer);
                this.pendingTimerResolvers = this.pendingTimerResolvers.filter(r => r !== resolve);
                window.clearInterval(iv);
                this.pendingIntervals = this.pendingIntervals.filter(x => x !== iv);
                if (maxSrcEnd > 0) {
                    const r = revealOffset + maxSrcEnd;
                    if (r > this.revealedChars()) this.revealedChars.set(r);
                }
                resolve();
            }, (plan.duration + 0.1) * 1000);
            this.pendingTimers.push(timer);
            this.pendingTimerResolvers.push(resolve);
        });
    }

    /** Finalizes the per-reply timing summary at the actual audio start. */
    private reportFirstAudio(): void {
        if (this.firstAudioReported) return;
        this.firstAudioReported = true;
        // Perceived start: speak() call -> first segment audible (separate from total synth).
        console.log(`[tts.timing] time-to-first-audio: ${Math.round(performance.now() - this.speakStartMs)} ms (call -> first segment audible)`);
        if (!this.timing) return;
        this.timing.mark('audio_started');
        const summary = this.timing.summary(this.piper.lastSynthMeta?.sessionCached);
        if (localStorage.getItem('textAvatar.debugPlan') === '1' || localStorage.getItem('textAvatar.debugTiming') === '1') {
            console.log('[tts] speech-start timing', summary.totalMs.toFixed(0) + ' ms total');
            console.table(summary.stages.map(st => ({ stage: st.name, ms: Math.round(st.ms) })));
        }
        try { this.timingOpts?.onFirstAudio?.(summary); } catch { /* listener errors are not ours */ }
    }

    /**
     * Pre-warm the pipeline while the user is still talking/typing:
     * resumes the AudioContext and runs a tiny synthesis so the worker loads
     * the engine + model and (via the session cache) builds the ONNX session
     * once — the real reply then skips the dominant cold-start cost.
     */
    warmup(opts: SpeakOptions): void {
        try { this.ensureAudioCtx(); } catch { /* no audio support */ }
        if (opts.provider !== 'piper') return;
        const voiceId = opts.voiceId ?? PIPER_VOICES[opts.lang][0].id;
        if (this.warmedVoice === voiceId) return;
        this.warmedVoice = voiceId;
        const t0 = performance.now();
        this.piper.synthesizeWav('ok', voiceId)
            .then(() => console.log(`[tts] warmup(${voiceId}) done in ${(performance.now() - t0).toFixed(0)} ms`))
            .catch(err => { this.warmedVoice = null; console.warn('[tts] warmup failed:', err?.message ?? err); });
    }

    /** Waiting/bridge animations during pre-speech gaps (experiment flag, default OFF). */
    waitingAnimsEnabled(): boolean {
        return localStorage.getItem('textAvatar.waitingAnims') === '1';
    }

    /** localStorage flags for A/B testing the progressive mode */
    private progressiveEnabled(): boolean {
        return localStorage.getItem('textAvatar.progressive') !== '0';
    }
    private partAMaxWords(): number {
        const n = parseInt(localStorage.getItem('textAvatar.partAMaxWords') ?? '8', 10);
        return Number.isFinite(n) ? Math.max(3, Math.min(20, n)) : 8;
    }

    // ------------------------------------------------------------- webspeech
    // (Web Speech API cannot precompile - no audio buffers - so this path keeps
    //  the segment-by-segment player; clips are preloaded so it also avoids
    //  the on-demand decode hitch.)

    private async speakWebSpeech(segments: SpeechTimelineSegment[], gestures: TimelineGesture[], opts: SpeakOptions, gen: number): Promise<void> {
        const synth = window.speechSynthesis;
        if (!synth) throw new Error('Web Speech API not available in this browser');
        const ctx = this.ensureAudioCtx();
        const playbackSegments = expandSegments(segments);

        for (const segment of playbackSegments) {
            if (gen !== this.generation) return;
            this.state.set('speaking');
            if (segment.kind === 'speech') {
                await this.playWebSpeechSegment(segment, gestures, opts, gen);
            } else if (segment.kind === 'pause') {
                await this.playSilence(segment.durationMs / 1000, gen);
            } else {
                await this.playExpressionClip(ctx, segment, gen);
            }
        }
    }

    private async playExpressionClip(ctx: AudioContext, segment: Extract<SpeechTimelineSegment, { kind: 'expression' }>, gen: number): Promise<void> {
        const buffer = await this.loadAudioClip(ctx, segment.clipUrl);
        if (gen !== this.generation) return;
        const frames: VisemeFrame[] = [{ viseme: 'sil', tStart: 0, tEnd: buffer.duration }];
        const clipSpeed = Math.max(SPEED_MULTIPLIER_MIN, Math.min(SPEED_MULTIPLIER_MAX, CYCLE_BASE_SECONDS / Math.max(0.1, buffer.duration)));
        await new Promise<void>(resolve => {
            if (gen !== this.generation) { resolve(); return; }
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            this.currentSources.push(source);
            source.onended = () => {
                this.currentSources = this.currentSources.filter(s => s !== source);
                resolve();
            };
            const startAt = ctx.currentTime + 0.03;
            source.start(startAt);
            this.active = { frames, anchor: startAt, duration: buffer.duration, clock: 'audio' };
            const wallStart = wallNow() + (startAt - ctx.currentTime);
            this.gestures.schedule(segment.gestureId, wallStart, 1, clipSpeed, true);
        });
    }

    private playSilence(duration: number, gen: number): Promise<void> {
        return new Promise(resolve => {
            if (gen !== this.generation) { resolve(); return; }
            const anchor = performance.now() / 1000;
            this.active = { frames: [{ viseme: 'sil', tStart: 0, tEnd: duration }], anchor, duration, clock: 'wall' };
            const timer = window.setTimeout(() => {
                this.pendingTimers = this.pendingTimers.filter(t => t !== timer);
                this.pendingTimerResolvers = this.pendingTimerResolvers.filter(r => r !== resolve);
                resolve();
            }, duration * 1000);
            this.pendingTimers.push(timer);
            this.pendingTimerResolvers.push(resolve);
        });
    }

    private async playWebSpeechSegment(
        segment: Extract<ExpandedSegment, { kind: 'speech' }>,
        gestures: TimelineGesture[],
        opts: SpeakOptions,
        gen: number
    ): Promise<void> {
        const synth = window.speechSynthesis;
        const utter = new SpeechSynthesisUtterance(segment.text);
        utter.lang = opts.lang === 'es' ? 'es-MX' : 'en-US';
        const voices = synth.getVoices().filter(v => v.lang.startsWith(opts.lang));
        if (voices.length) utter.voice = voices[0];

        const estDuration = Math.max(0.6, segment.text.length / (opts.lang === 'es' ? 14 : 15));
        const frames = scaleTimeline(textToVisemes(segment.text, opts.lang), 0, estDuration);

        await new Promise<void>((resolve, reject) => {
            utter.onstart = () => {
                if (gen !== this.generation) return;
                const anchor = performance.now() / 1000;
                this.active = { frames, anchor, duration: estDuration, clock: 'wall' };
                const start = segment.sourceStart;
                const len = Math.max(1, segment.sourceEnd - segment.sourceStart);
                for (const g of gestures) {
                    if (g.charIndex >= start && g.charIndex <= segment.sourceEnd) {
                        const frac = Math.min(1, Math.max(0, (g.charIndex - start) / len));
                        this.gestures.schedule(g.id, anchor + frac * estDuration, g.repetitions, g.speed);
                    }
                }
            };
            utter.onboundary = (ev: SpeechSynthesisEvent) => {
                if (gen !== this.generation || !this.active || ev.name !== 'word') return;
                const progress = ev.charIndex / Math.max(1, segment.text.length);
                this.active.anchor = performance.now() / 1000 - progress * estDuration;
            };
            utter.onend = () => resolve();
            utter.onerror = (e) => {
                if ((e as any).error === 'interrupted' || (e as any).error === 'canceled') resolve();
                else reject(new Error('SpeechSynthesis error: ' + (e as any).error));
            };
            synth.speak(utter);
        });
    }

    // ----------------------------------------------------------------- utils

    private ensureAudioCtx(): AudioContext {
        if (!this.audioCtx) this.audioCtx = new AudioContext();
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        return this.audioCtx;
    }

    private loadAudioClip(ctx: AudioContext, url: string): Promise<AudioBuffer> {
        const cached = this.clipCache.get(url);
        if (cached) return cached;
        const pending = fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`Expression audio not found: ${url} (HTTP ${res.status})`);
                return res.arrayBuffer();
            })
            .then(arr => ctx.decodeAudioData(arr));
        this.clipCache.set(url, pending);
        return pending;
    }

    private mix(a: BlendWeights, b: BlendWeights, p: number): BlendWeights {
        const out: BlendWeights = {};
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        keys.forEach(k => {
            out[k] = (a[k] ?? 0) * (1 - p) + (b[k] ?? 0) * p;
        });
        return out;
    }
}
