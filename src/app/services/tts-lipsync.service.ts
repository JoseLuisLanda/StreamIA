import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import {
    textToVisemes, scaleTimeline, findSpeechBounds, splitIntoChunksWithOffsets, TextChunk, VisemeFrame
} from '../lib/lipsync/text-to-visemes';
import { parseGestureMarkup, ParsedGesture } from '../lib/gestures/gesture-markup';
import { GESTURE_MAP } from '../lib/gestures/gesture-library';
import { GesturePlayerService, now as wallNow } from './gesture-player.service';
import { Viseme, VISEME_TO_ARKIT, BlendWeights } from '../lib/lipsync/viseme-map';

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
    private currentSource: AudioBufferSourceNode | null = null;
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

        // markup-only input: play gestures with no speech
        if (!parsed.cleanText) {
            const t0 = wallNow();
            for (const g of parsed.gestures) this.gestures.schedule(g.id, t0, g.duration);
            return;
        }

        try {
            if (opts.provider === 'piper') {
                await this.speakPiper(parsed.cleanText, parsed.gestures, opts, gen);
            } else {
                await this.speakWebSpeech(parsed.cleanText, parsed.gestures, opts, gen);
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
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch { /* already stopped */ }
            this.currentSource = null;
        }
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

    private async speakPiper(text: string, gestures: ParsedGesture[], opts: SpeakOptions, gen: number): Promise<void> {
        const tts = await this.ensurePiper(gen);
        const voiceId = opts.voiceId ?? PIPER_VOICES[opts.lang][0].id;
        const ctx = this.ensureAudioCtx();

        const chunks = splitIntoChunksWithOffsets(text);
        this.state.set('synthesizing');

        const synthesize = async (chunk: string): Promise<AudioBuffer> => {
            const blob: Blob = await tts.predict(
                { text: chunk.trim(), voiceId },
                (p: any) => {
                    if (p?.total) this.downloadProgress.set(Math.min(1, p.loaded / p.total));
                }
            );
            this.downloadProgress.set(null);
            const arr = await blob.arrayBuffer();
            return await ctx.decodeAudioData(arr);
        };

        // pipeline: synthesize next chunk while current plays
        let pending: Promise<AudioBuffer> = synthesize(chunks[0].text);
        for (let i = 0; i < chunks.length; i++) {
            const buffer = await pending;
            if (gen !== this.generation) return;
            if (i + 1 < chunks.length) pending = synthesize(chunks[i + 1].text);

            const bounds = findSpeechBounds(buffer);
            const frames = scaleTimeline(textToVisemes(chunks[i].text, opts.lang), bounds.start, bounds.end);

            this.state.set('speaking');
            await this.playBuffer(ctx, buffer, frames, gen, this.gesturesForChunk(gestures, chunks, i), bounds);
            if (gen !== this.generation) return;
            if (i + 1 < chunks.length) this.state.set('synthesizing');
        }
    }

    /** Gestures whose anchor falls inside chunk i, with anchor as 0..1 fraction of the chunk. */
    private gesturesForChunk(gestures: ParsedGesture[], chunks: TextChunk[], i: number):
        { id: string; frac: number; duration?: number }[] {
        const start = chunks[i].start;
        const end = i + 1 < chunks.length ? chunks[i + 1].start : Number.MAX_SAFE_INTEGER;
        const len = Math.max(1, chunks[i].text.length);
        return gestures
            .filter(g => g.charIndex >= start && g.charIndex < end)
            .map(g => ({ id: g.id, frac: Math.min(1, Math.max(0, (g.charIndex - start) / len)), duration: g.duration }));
    }

    private playBuffer(
        ctx: AudioContext, buffer: AudioBuffer, frames: VisemeFrame[], gen: number,
        chunkGestures: { id: string; frac: number; duration?: number }[] = [],
        bounds: { start: number; end: number } = { start: 0, end: buffer.duration }
    ): Promise<void> {
        return new Promise(resolve => {
            if (gen !== this.generation) { resolve(); return; }
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            this.currentSource = source;
            source.onended = () => {
                if (this.currentSource === source) this.currentSource = null;
                resolve();
            };
            const startAt = ctx.currentTime + 0.03; // small scheduling cushion
            source.start(startAt);
            this.active = { frames, anchor: startAt, duration: buffer.duration, clock: 'audio' };

            // schedule this chunk's gestures: map char fraction -> speech window -> wall clock
            const wallStart = wallNow() + (startAt - ctx.currentTime);
            const span = bounds.end - bounds.start;
            for (const g of chunkGestures) {
                this.gestures.schedule(g.id, wallStart + bounds.start + g.frac * span, g.duration);
            }
        });
    }

    // ------------------------------------------------------------- webspeech

    private async speakWebSpeech(text: string, gestures: ParsedGesture[], opts: SpeakOptions, gen: number): Promise<void> {
        const synth = window.speechSynthesis;
        if (!synth) throw new Error('Web Speech API not available in this browser');

        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = opts.lang === 'es' ? 'es-MX' : 'en-US';
        const voices = synth.getVoices().filter(v => v.lang.startsWith(opts.lang));
        if (voices.length) utter.voice = voices[0];

        // estimated duration: ~14 chars/sec for es, ~15 for en at rate 1
        const estDuration = Math.max(0.6, text.length / (opts.lang === 'es' ? 14 : 15));
        const frames = scaleTimeline(textToVisemes(text, opts.lang), 0, estDuration);

        this.state.set('speaking');
        await new Promise<void>((resolve, reject) => {
            utter.onstart = () => {
                if (gen !== this.generation) return;
                const anchor = performance.now() / 1000;
                this.active = { frames, anchor, duration: estDuration, clock: 'wall' };
                for (const g of gestures) {
                    const frac = Math.min(1, g.charIndex / Math.max(1, text.length));
                    this.gestures.schedule(g.id, anchor + frac * estDuration, g.duration);
                }
            };
            // word boundary events (when supported) re-anchor the timeline to fight drift
            utter.onboundary = (ev: SpeechSynthesisEvent) => {
                if (gen !== this.generation || !this.active || ev.name !== 'word') return;
                const progress = ev.charIndex / Math.max(1, text.length);
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

    private mix(a: BlendWeights, b: BlendWeights, p: number): BlendWeights {
        const out: BlendWeights = {};
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        keys.forEach(k => {
            out[k] = (a[k] ?? 0) * (1 - p) + (b[k] ?? 0) * p;
        });
        return out;
    }
}
