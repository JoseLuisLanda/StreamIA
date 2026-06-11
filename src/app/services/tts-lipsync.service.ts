import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import {
    textToVisemes, scaleTimeline, findSpeechBounds, splitIntoChunksWithOffsets, TextChunk, VisemeFrame
} from '../lib/lipsync/text-to-visemes';
import { parseGestureMarkup } from '../lib/gestures/gesture-markup';
import { GESTURE_MAP, CYCLE_BASE_SECONDS, SPEED_MULTIPLIER_MIN, SPEED_MULTIPLIER_MAX } from '../lib/gestures/gesture-library';
import { GesturePlayerService, now as wallNow } from './gesture-player.service';
import { Viseme, VISEME_TO_ARKIT, BlendWeights } from '../lib/lipsync/viseme-map';
import { buildSpeechTimeline, SpeechTimelineSegment, TimelineGesture } from '../lib/lipsync/speech-timeline';

export type TtsProvider = 'piper' | 'webspeech';
export type TtsLang = 'es' | 'en';
export type TtsState = 'idle' | 'loading-engine' | 'synthesizing' | 'speaking';

export interface SpeakOptions {
    provider: TtsProvider;
    lang: TtsLang;
    /** Piper voice id, e.g. 'es_MX-claude-high' */
    voiceId?: string;
}

// Piper engine is an npm dependency: npm i @diffusionstudio/vits-web
// (engine code is bundled; voice models + onnx wasm are fetched at runtime and cached in OPFS)

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

interface ActivePlayback {
    frames: VisemeFrame[];
    /** AudioContext time at which buffer started, or wall-clock anchor for webspeech */
    anchor: number;
    duration: number;
    clock: 'audio' | 'wall';
}

type PlaybackSegment =
    | { kind: 'speech'; text: string; sourceStart: number; sourceEnd: number }
    | Exclude<SpeechTimelineSegment, { kind: 'speech' }>;

interface SynthesizedSpeechSegment {
    buffer: AudioBuffer;
    frames: VisemeFrame[];
    bounds: { start: number; end: number };
}

/**
 * Text -> TTS audio + viseme timeline, with provider abstraction.
 *
 * Stage 1 providers (no cloud):
 *  - 'piper': @diffusionstudio/vits-web (Piper ONNX, WASM). Fully offline after first use.
 *  - 'webspeech': browser SpeechSynthesis (OS voices). Zero download, estimated timing.
 *
 * A Stage 2 cloud provider (Azure viseme events) can implement the same
 * synthesize->frames contract and drop in without touching the animation layer.
 */
@Injectable({ providedIn: 'root' })
export class TtsLipsyncService {
    public state: WritableSignal<TtsState> = signal('idle');
    public error: WritableSignal<string | null> = signal(null);
    /** 0..1 model download progress (piper first run) */
    public downloadProgress: WritableSignal<number | null> = signal(null);
    public currentViseme: WritableSignal<Viseme> = signal('sil');
    /** parser warnings from the last speak() call (unknown gestures, bad durations) */
    public gestureWarnings: WritableSignal<string[]> = signal([]);

    private gestures = inject(GesturePlayerService);

    private audioCtx: AudioContext | null = null;
    private piperModule: any = null;
    private active: ActivePlayback | null = null;
    private currentSources: AudioBufferSourceNode[] = [];
    private pendingTimers: number[] = [];
    private pendingTimerResolvers: Array<() => void> = [];
    private clipCache = new Map<string, Promise<AudioBuffer>>();
    /** generation token - bump to cancel in-flight work */
    private generation = 0;

    // ---------------------------------------------------------------- public

    async speak(text: string, opts: SpeakOptions): Promise<void> {
        const trimmed = text?.trim();
        if (!trimmed) return;

        this.stop(); // interrupt anything playing
        const gen = ++this.generation;
        this.error.set(null);

        // strip gesture markup; tags are never sent to TTS
        const parsed = parseGestureMarkup(trimmed, new Set(GESTURE_MAP.keys()));
        this.gestureWarnings.set(parsed.warnings);
        for (const w of parsed.warnings) console.warn('[gestures]', w);

        const plan = buildSpeechTimeline(parsed.cleanText, parsed.gestures);

        // markup-only input: play gestures with no speech
        if (!plan.segments.some(s => s.kind === 'speech') && plan.segments.length === 0) {
            const t0 = wallNow();
            for (const g of plan.gestures) this.gestures.schedule(g.id, t0, g.repetitions, g.speed);
            return;
        }

        try {
            if (opts.provider === 'piper') {
                await this.speakPiper(plan.segments, plan.gestures, opts, gen);
            } else {
                await this.speakWebSpeech(plan.segments, plan.gestures, opts, gen);
            }
        } catch (e: any) {
            if (gen !== this.generation) return; // interrupted - not an error
            console.error('TTS error:', e);
            this.error.set(e?.message ?? String(e));
        } finally {
            if (gen === this.generation) {
                this.state.set('idle');
                this.active = null;
                this.currentViseme.set('sil');
            }
        }
    }

    stop(): void {
        this.generation++;
        this.gestures.clear();
        for (const source of this.currentSources) {
            try { source.stop(); } catch { /* already stopped */ }
        }
        this.currentSources = [];
        for (const timer of this.pendingTimers) window.clearTimeout(timer);
        this.pendingTimers = [];
        for (const resolve of this.pendingTimerResolvers) resolve();
        this.pendingTimerResolvers = [];
        try { window.speechSynthesis?.cancel(); } catch { /* unavailable */ }
        this.active = null;
        this.state.set('idle');
        this.currentViseme.set('sil');
    }

    /**
     * Called every animation frame by the avatar component.
     * Returns target ARKit weights for the mouth, crossfaded between visemes.
     */
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
        const XFADE = 0.06; // 60 ms crossfade into next viseme
        if (next && frame.tEnd - now < XFADE) {
            const p = 1 - (frame.tEnd - now) / XFADE; // 0->1
            return this.mix(base, VISEME_TO_ARKIT[next.viseme], p);
        }
        return base;
    }

    // ----------------------------------------------------------------- piper

    private async ensurePiper(gen: number): Promise<any> {
        if (this.piperModule) return this.piperModule;
        this.state.set('loading-engine');
        let mod: any;
        try {
            mod = await import('@diffusionstudio/vits-web');
        } catch (e) {
            throw new Error(
                'Could not load the Piper TTS engine. Run: npm i @diffusionstudio/vits-web (then restart ng serve). ' +
                'Original error: ' + (e as Error)?.message
            );
        }
        if (gen !== this.generation) throw new Error('interrupted');
        this.piperModule = mod;
        return mod;
    }

    private async speakPiper(segments: SpeechTimelineSegment[], gestures: TimelineGesture[], opts: SpeakOptions, gen: number): Promise<void> {
        const tts = await this.ensurePiper(gen);
        const voiceId = opts.voiceId ?? PIPER_VOICES[opts.lang][0].id;
        const ctx = this.ensureAudioCtx();

        const playbackSegments = this.expandSpeechSegments(segments);
        this.state.set('synthesizing');

        const synthesize = async (segment: Extract<PlaybackSegment, { kind: 'speech' }>): Promise<SynthesizedSpeechSegment> => {
            const blob: Blob = await tts.predict(
                { text: segment.text.trim(), voiceId },
                (p: any) => {
                    if (p?.total) this.downloadProgress.set(Math.min(1, p.loaded / p.total));
                }
            );
            this.downloadProgress.set(null);
            const arr = await blob.arrayBuffer();
            const buffer = await ctx.decodeAudioData(arr);
            const bounds = findSpeechBounds(buffer);
            const frames = scaleTimeline(textToVisemes(segment.text, opts.lang), bounds.start, bounds.end);
            return { buffer, bounds, frames };
        };

        const pendingSpeech = new Map<number, Promise<SynthesizedSpeechSegment>>();
        const ensurePendingSpeech = (fromIndex: number) => {
            const nextIndex = this.nextSpeechIndex(playbackSegments, fromIndex);
            if (nextIndex >= 0 && !pendingSpeech.has(nextIndex)) {
                pendingSpeech.set(nextIndex, synthesize(playbackSegments[nextIndex] as Extract<PlaybackSegment, { kind: 'speech' }>));
            }
        };

        ensurePendingSpeech(0);
        for (let i = 0; i < playbackSegments.length; i++) {
            if (gen !== this.generation) return;
            const segment = playbackSegments[i];
            ensurePendingSpeech(i + 1);
            if (segment.kind === 'speech') {
                const pending = pendingSpeech.get(i) ?? synthesize(segment);
                const { buffer, frames, bounds } = await pending;
                if (gen !== this.generation) return;
                this.state.set('speaking');
                await this.playSpeechBuffer(ctx, buffer, frames, gen, this.gesturesForSpeechSegment(gestures, segment), bounds);
            } else if (segment.kind === 'pause') {
                this.state.set('speaking');
                await this.playSilence(segment.durationMs / 1000, gen);
            } else {
                this.state.set('speaking');
                await this.playExpressionClip(ctx, segment, gen);
            }
            if (gen !== this.generation) return;
            if (this.nextSpeechIndex(playbackSegments, i + 1) >= 0) this.state.set('synthesizing');
        }
    }

    /** Gestures whose anchor falls inside a speech segment, with anchor as 0..1 fraction. */
    private gesturesForSpeechSegment(gestures: TimelineGesture[], segment: Extract<PlaybackSegment, { kind: 'speech' }>):
        { id: string; frac: number; repetitions?: number; speed?: TimelineGesture['speed'] }[] {
        const start = segment.sourceStart;
        const end = segment.sourceEnd;
        const len = Math.max(1, end - start);
        return gestures
            .filter(g => g.charIndex >= start && g.charIndex <= end)
            .map(g => ({ id: g.id, frac: Math.min(1, Math.max(0, (g.charIndex - start) / len)), repetitions: g.repetitions, speed: g.speed }));
    }

    private playSpeechBuffer(
        ctx: AudioContext, buffer: AudioBuffer, frames: VisemeFrame[], gen: number,
        chunkGestures: { id: string; frac: number; repetitions?: number; speed?: TimelineGesture['speed'] }[] = [],
        bounds: { start: number; end: number } = { start: 0, end: buffer.duration }
    ): Promise<void> {
        return this.playAudioBuffer(ctx, buffer, frames, gen, (startAt) => {
            const wallStart = wallNow() + (startAt - ctx.currentTime);
            const span = bounds.end - bounds.start;
            for (const g of chunkGestures) {
                this.gestures.schedule(g.id, wallStart + bounds.start + g.frac * span, g.repetitions, g.speed);
            }
        });
    }

    private async playExpressionClip(ctx: AudioContext, segment: Extract<SpeechTimelineSegment, { kind: 'expression' }>, gen: number): Promise<void> {
        const buffer = await this.loadAudioClip(ctx, segment.clipUrl);
        if (gen !== this.generation) return;
        const frames: VisemeFrame[] = [{ viseme: 'sil', tStart: 0, tEnd: buffer.duration }];
        // play exactly one gesture cycle stretched to match the clip length
        const clipSpeed = Math.max(SPEED_MULTIPLIER_MIN, Math.min(SPEED_MULTIPLIER_MAX, CYCLE_BASE_SECONDS / Math.max(0.1, buffer.duration)));
        await this.playAudioBuffer(ctx, buffer, frames, gen, (startAt) => {
            const wallStart = wallNow() + (startAt - ctx.currentTime);
            this.gestures.schedule(segment.gestureId, wallStart, 1, clipSpeed, true);
        });
    }

    private playAudioBuffer(
        ctx: AudioContext,
        buffer: AudioBuffer,
        frames: VisemeFrame[],
        gen: number,
        onScheduled?: (startAt: number) => void
    ): Promise<void> {
        return new Promise(resolve => {
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
            onScheduled?.(startAt);
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

    // ------------------------------------------------------------- webspeech

    private async speakWebSpeech(segments: SpeechTimelineSegment[], gestures: TimelineGesture[], opts: SpeakOptions, gen: number): Promise<void> {
        const synth = window.speechSynthesis;
        if (!synth) throw new Error('Web Speech API not available in this browser');
        const ctx = this.ensureAudioCtx();
        const playbackSegments = this.expandSpeechSegments(segments);

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

    private async playWebSpeechSegment(
        segment: Extract<PlaybackSegment, { kind: 'speech' }>,
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
                for (const g of this.gesturesForSpeechSegment(gestures, segment)) {
                    this.gestures.schedule(g.id, anchor + g.frac * estDuration, g.repetitions, g.speed);
                }
            };
            utter.onboundary = (ev: SpeechSynthesisEvent) => {
                if (gen !== this.generation || !this.active || ev.name !== 'word') return;
                const progress = ev.charIndex / Math.max(1, segment.text.length);
                const expectedT = progress * estDuration;
                this.active.anchor = performance.now() / 1000 - expectedT;
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

    private expandSpeechSegments(segments: SpeechTimelineSegment[]): PlaybackSegment[] {
        const out: PlaybackSegment[] = [];
        for (const segment of segments) {
            if (segment.kind !== 'speech') {
                out.push(segment);
                continue;
            }
            const chunks: TextChunk[] = splitIntoChunksWithOffsets(segment.text);
            for (const chunk of chunks) {
                out.push({
                    kind: 'speech',
                    text: chunk.text,
                    sourceStart: segment.sourceStart + chunk.start,
                    sourceEnd: segment.sourceStart + chunk.start + chunk.text.length,
                });
            }
        }
        return out;
    }

    private nextSpeechIndex(segments: PlaybackSegment[], fromIndex: number): number {
        for (let i = fromIndex; i < segments.length; i++) {
            if (segments[i].kind === 'speech') return i;
        }
        return -1;
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
