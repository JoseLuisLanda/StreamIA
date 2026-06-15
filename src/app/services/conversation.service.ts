import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { TtsLipsyncService, TtsProvider, TtsLang } from './tts-lipsync.service';
import { SpeechRecognitionService } from './speech-recognition.service';
import { LlmService, LLM_PROVIDER_LABELS } from './llm.service';
import { GesturePlayerService } from './gesture-player.service';
import { sanitizeLlmReply, truncateAtSentence } from '../lib/llm/llm-sanitizer';
import { GESTURE_MAP } from '../lib/gestures/gesture-library';
import { PlanCache } from '../lib/performance/plan-cache';
import { speechStartLine } from '../lib/performance/timing';
import { MediaItem, RagResponse } from '../lib/rag/rag.models';

/**
 * Conversation orchestrator: explicit state machine wiring
 * mic -> transcript -> LLM -> sanitizer -> TTS+gestures -> back to idle.
 * Single source of truth for the status pill, mic button, and chat panel.
 * Pure transition table lives in lib/conversation/conv-states.ts (unit tested).
 */
import { ConvState, canTransition, interruptTarget } from '../lib/conversation/conv-states';

export type { ConvState };
export { canTransition, interruptTarget };

export interface ConvMessage {
    /** unique per session — keys the replay plan cache */
    id: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    /** epoch ms */
    at: number;
    /** e.g. "Ollama (local) · llama3.2" or "modo directo" */
    meta?: string;
    kind?: 'info' | 'error';
    /** assistant messages with a cached/recompilable performance */
    replayable?: boolean;
    /** Lead-in gesture block played before TTS speech (stored for replay) */
    leadGesture?: string;
    /** Tail gesture block played after TTS speech ends (stored for replay) */
    tailGesture?: string;
    /** RAG informational mode: media references attached to this answer (lazy-fetched). */
    media?: MediaItem[];
}

export interface ConvTtsOpts {
    provider: TtsProvider;
    lang: TtsLang;
    voiceId?: string;
}

@Injectable({ providedIn: 'root' })
export class ConversationService {
    public state: WritableSignal<ConvState> = signal('idle');
    public messages: WritableSignal<ConvMessage[]> = signal([]);
    /** live streaming reply text (Ollama) */
    public streaming: WritableSignal<string> = signal('');
    /** continuous mode: re-open the mic after each spoken reply */
    public continuous = false;
    /** mic muted by the user */
    public muted = false;

    private tts = inject(TtsLipsyncService);
    private stt = inject(SpeechRecognitionService);
    private llm = inject(LlmService);
    private gestures = inject(GesturePlayerService);

    /** message currently being performed (highlight), or null */
    public speakingMsgId: WritableSignal<number | null> = signal(null);
    /** message whose text is being revealed karaoke-style (live turns only, never replays) */
    public revealingMsgId: WritableSignal<number | null> = signal(null);
    /** Lead-in gesture ID played immediately while the LLM is generating (covers latency).
     *  Set from the Response Editor lead-in dropdown before each live turn. */
    public liveLeadGesture: WritableSignal<string> = signal('');
    /** Tail gesture ID played after body speech ends in live turns.
     *  Set from the Response Editor tail dropdown before each live turn. */
    public liveTailGesture: WritableSignal<string> = signal('');
    /** When set (Text-Avatar RAG/informational mode), every turn is answered by
     *  the Cloud Function via this fetcher instead of the client LLM. null = LLM. */
    public ragFetcher: ((q: string) => Promise<RagResponse>) | null = null;

    /** generation token: bumping it makes any in-flight turn a no-op */
    private gen = 0;
    private lastOpts: ConvTtsOpts = { provider: 'piper', lang: 'es' };
    private msgSeq = 1;
    /** compiled performances for the last N assistant messages (replay) */
    private plans = new PlanCache(10);

    // ------------------------------------------------------------------ API

    /** Mic pressed. From speaking: interrupts and starts listening. */
    startListening(opts: ConvTtsOpts): void {
        if (this.muted || !this.stt.isSupported) return;
        this.lastOpts = opts;
        this.tts.warmup(opts); // pre-warm AudioContext + Piper session while the user talks
        if (this.state() === 'listening') { this.finishListening(); return; }
        this.interruptInternals(); // stops TTS + any in-flight turn (echo prevention)
        if (this.state() !== 'idle') this.setState(interruptTarget(this.state())); // pass through idle
        this.setState('listening');
        this.stt.start(opts.lang, t => this.dispatchTurn(t, opts));
    }

    /** Mic pressed while listening: end the turn gracefully (flushes final). */
    finishListening(): void {
        if (this.state() !== 'listening') return;
        this.stt.finish();
        // state advances in runTurn; if nothing was said the STT
        // onend fires with no final -> watchdog below returns us to idle
        setTimeout(() => {
            if (this.state() === 'listening' && !this.stt.listening()) this.setState('idle');
        }, 900);
    }

    /** Stop button / mic during speech: cancel everything, back to idle. */
    interrupt(): void {
        this.interruptInternals();
        this.setState(interruptTarget(this.state()));
    }

    /**
     * Typed conversation input: EXACTLY the same turn as a final voice
     * transcript (same state transitions, history, sanitizer, compiler).
     * Sending while the avatar speaks interrupts playback, like the mic.
     */
    sendText(text: string, opts: ConvTtsOpts): void {
        const trimmed = text.trim();
        if (!trimmed) return;
        this.lastOpts = opts;
        this.tts.warmup(opts);
        this.interruptInternals();
        if (this.state() !== 'idle') this.setState(interruptTarget(this.state()));
        this.dispatchTurn(trimmed, opts);
    }

    /**
     * Route a transcript/typed turn to either the client LLM (runTurn) or the
     * RAG Function (runRagTurn) depending on whether informational mode is active.
     * Setting `ragFetcher` (from the Text-Avatar deployment) flips every voice +
     * typed turn to RAG without changing call sites.
     */
    private dispatchTurn(text: string, opts: ConvTtsOpts): void {
        if (this.ragFetcher) void this.runRagTurn(text, this.ragFetcher, opts);
        else void this.runTurn(text, opts);
    }

    private async runRagTurn(query: string, fetcher: (q: string) => Promise<RagResponse>, optsOverride?: ConvTtsOpts): Promise<void> {
        this.stt.stop();
        const gen = ++this.gen;
        const opts = optsOverride ?? this.lastOpts;

        this.push({ role: 'user', content: query, at: Date.now() });
        this.setState('sending');
        this.pushSystem('Consultando la base de conocimiento…');
        this.setState('waiting_llm');

        // Lead-in plays immediately, covering Function cold-start + RAG retrieval.
        const leadId = this.liveLeadGesture();
        if (leadId) {
            this.gestures.trigger(leadId, undefined, undefined, true);
        } else if (this.tts.waitingAnimsEnabled()) {
            this.gestures.triggerTransient('thinking', 1, 'slow');
        }

        const t0 = performance.now();
        try {
            const payload = await fetcher(query);
            if (gen !== this.gen) return; // interrupted while waiting
            const tReplyReceived = performance.now();
            this.pushSystem(`Respuesta recibida (${((tReplyReceived - t0) / 1000).toFixed(1)} s)`);

            // gestureCommands carries inline tags; fall back to plain body if absent.
            const spoken = (payload.gestureCommands || payload.body || '').trim();
            const sane = sanitizeLlmReply(spoken, new Set(GESTURE_MAP.keys()));
            for (const w of sane.warnings) console.warn('[rag-sanitizer]', w);
            const finalText = sane.text;

            const assistantMsg = this.push({
                role: 'assistant', content: finalText, at: Date.now(),
                meta: 'RAG', replayable: true, media: payload.media,
                leadGesture: leadId || undefined, tailGesture: this.liveTailGesture() || undefined,
            });
            this.setState('speaking');
            this.speakingMsgId.set(assistantMsg.id);
            if (opts.provider === 'piper') this.revealingMsgId.set(assistantMsg.id);

            await this.tts.speak(finalText, {
                ...opts,
                timingStart: tReplyReceived,
                onFirstAudio: summary => { if (gen === this.gen) this.pushSystem(speechStartLine(summary)); },
                singlePass: !!leadId, // lead-in already covered latency
            });
            if (this.tts.lastPerformance) this.plans.set(assistantMsg.id, this.tts.lastPerformance);
            this.speakingMsgId.set(null);
            this.revealingMsgId.set(null);
            if (gen !== this.gen) return;

            const tailId = this.liveTailGesture();
            if (tailId) this.gestures.trigger(tailId, undefined, undefined, true);
            this.afterSpeaking(opts);
        } catch (e: any) {
            if (gen !== this.gen) return;
            this.fail(e?.message ?? String(e));
            const fallback = opts.lang === 'es'
                ? 'Lo siento, no pude consultar la información en este momento.'
                : 'Sorry, I could not retrieve that information right now.';
            try { this.setState('speaking'); await this.tts.speak(fallback, opts); } catch { /* best-effort */ }
            if (gen === this.gen) this.setState('idle');
        }
    }

    /**
     * Replay a previous assistant performance: instant from the plan cache
     * (no re-synthesis); recompiles transparently if evicted. Pure
     * re-performance: no new chat message, no LLM history change.
     */
    async replayMessage(msgId: number, opts: ConvTtsOpts): Promise<void> {
        const msg = this.messages().find(m => m.id === msgId);
        if (!msg || msg.role !== 'assistant') return;
        if (this.state() !== 'idle') this.interrupt(); // replay only from idle
        const gen = ++this.gen;
        this.speakingMsgId.set(msgId);
        this.setState('speaking');
        try {
            const cached = this.plans.get(msgId);
            if (cached) {
                await this.tts.replayPerformance(cached);
            } else {
                await this.tts.speak(msg.content, opts); // transparent recompile
                if (gen === this.gen && this.tts.lastPerformance) this.plans.set(msgId, this.tts.lastPerformance);
            }
        } catch (e: any) {
            this.fail(e?.message ?? String(e));
        } finally {
            if (gen === this.gen) {
                this.speakingMsgId.set(null);
                if (this.state() !== 'idle') this.setState('idle');
            }
        }
    }

    /** Manual "Modo directo": speak typed text through the same pipeline + log it.
     *  lead/tail gesture IDs are stored on the message so replay can reconstruct the full sequence. */
    async sayManual(text: string, opts: ConvTtsOpts, lead?: string, tail?: string): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) return;
        this.lastOpts = opts;
        this.interruptInternals();
        const gen = ++this.gen;
        const msg = this.push({ role: 'assistant', content: trimmed, at: Date.now(), meta: 'preview', replayable: true, leadGesture: lead || undefined, tailGesture: tail || undefined });
        this.speakingMsgId.set(msg.id);
        if (opts.provider === 'piper') this.revealingMsgId.set(msg.id);
        this.setState('speaking');
        try {
            // singlePass: the lead-in gesture covers synthesis latency, so we
            // compile the full body as one plan rather than splitting early.
            await this.tts.speak(trimmed, { ...opts, singlePass: true });
        } catch (e: any) {
            this.fail('TTS: ' + (e?.message ?? e));
        } finally {
            if (gen === this.gen) {
                this.speakingMsgId.set(null);
                this.revealingMsgId.set(null);
                if (this.state() === 'speaking') this.setState('idle');
            }
        }
    }

    clear(): void {
        this.messages.set([]);
        this.streaming.set('');
        this.llm.clearConversation();
        this.plans.clear();
        this.speakingMsgId.set(null);
        this.revealingMsgId.set(null);
    }

    // ----------------------------------------------------------------- turn

    private async runTurn(transcript: string, optsOverride?: ConvTtsOpts): Promise<void> {
        this.stt.stop(); // hard off: never listen while we think & speak
        const gen = ++this.gen;
        const opts = optsOverride ?? this.lastOpts;
        const s = this.llm.settings();
        const cfg = s.providers[s.provider];
        const label = LLM_PROVIDER_LABELS[s.provider];

        this.push({ role: 'user', content: transcript, at: Date.now() });
        this.setState('sending');
        this.pushSystem(`Transcripción enviada a ${label} (${cfg.model})…`);
        this.setState('waiting_llm');
        const leadId = this.liveLeadGesture();
        if (leadId) {
            // Lead gesture plays immediately while the LLM generates, covering synthesis latency.
            // It blends out naturally when speak() calls stopInternal at audio start.
            this.gestures.trigger(leadId, undefined, undefined, true);
        } else if (this.tts.waitingAnimsEnabled()) {
            this.gestures.triggerTransient('thinking', 1, 'slow'); // waiting gesture: killed at audio start
        }

        const t0 = performance.now();
        try {
            const reply = await this.llm.sendChat(transcript, acc => {
                if (gen === this.gen) this.streaming.set(acc);
            });
            if (gen !== this.gen) return; // interrupted while waiting
            const tReplyReceived = performance.now(); // llm_response_received
            this.streaming.set('');
            this.pushSystem(`Respuesta recibida (${((tReplyReceived - t0) / 1000).toFixed(1)} s)`);

            const sane = sanitizeLlmReply(reply, new Set(GESTURE_MAP.keys()));
            for (const w of sane.warnings) console.warn('[llm-sanitizer]', w);
            if (sane.corrected || sane.removed) {
                this.pushSystem(`Sanitizado: ${sane.corrected} etiqueta(s) corregida(s), ${sane.removed} eliminada(s)`);
            }

            let finalText = sane.text;
            const truncated = truncateAtSentence(finalText, 130);
            if (truncated !== null) {
                finalText = truncated;
                this.pushSystem('Respuesta truncada (límite de longitud)');
            }

            const assistantMsg = this.push({ role: 'assistant', content: finalText, at: Date.now(), meta: `${label} · ${cfg.model}`, replayable: true });
            this.setState('speaking');
            this.speakingMsgId.set(assistantMsg.id);
            if (opts.provider === 'piper') this.revealingMsgId.set(assistantMsg.id);
            await this.tts.speak(finalText, {
                ...opts,
                timingStart: tReplyReceived,
                onFirstAudio: summary => {
                    if (gen === this.gen) this.pushSystem(speechStartLine(summary));
                },
                // singlePass: lead gesture covers synthesis latency, so no need to split early
                singlePass: !!leadId,
            });
            if (this.tts.lastPerformance) this.plans.set(assistantMsg.id, this.tts.lastPerformance);
            this.speakingMsgId.set(null);
            this.revealingMsgId.set(null);
            if (gen !== this.gen) return; // interrupted while speaking

            // Tail gesture (motion-only) plays after body speech completes
            const tailId = this.liveTailGesture();
            if (tailId) this.gestures.trigger(tailId, undefined, undefined, true);

            this.afterSpeaking(opts);
        } catch (e: any) {
            if (gen !== this.gen) return;
            this.streaming.set('');
            this.fail(e?.message ?? String(e));
            // short spoken fallback, then recover to idle (never stuck in Pensando)
            const fallback = opts.lang === 'es' ? 'Lo siento, no pude conectarme.' : 'Sorry, I could not connect.';
            try {
                this.setState('speaking');
                await this.tts.speak(fallback, opts);
            } catch { /* best-effort */ }
            if (gen === this.gen) this.setState('idle');
        }
    }

    private afterSpeaking(opts: ConvTtsOpts): void {
        if (this.continuous && !this.muted && this.stt.isSupported) {
            this.setState('listening');
            this.stt.start(opts.lang, t => this.dispatchTurn(t, opts));
        } else {
            this.setState('idle');
        }
    }

    // ------------------------------------------------------------ internals

    private interruptInternals(): void {
        this.gen++;            // any in-flight turn becomes a no-op
        this.tts.stop();       // cancels audio via the TTS generation token
        this.stt.stop();       // hard mic off
        this.streaming.set('');
        this.speakingMsgId.set(null);
        this.revealingMsgId.set(null); // interruption: bubble shows full text
    }

    private fail(msg: string): void {
        this.setState('error');
        this.push({ role: 'system', kind: 'error', content: 'Error: ' + msg, at: Date.now() });
    }

    private setState(to: ConvState): void {
        const from = this.state();
        if (!canTransition(from, to)) {
            console.warn(`[conversation] illegal transition ${from} -> ${to} (forced)`);
        }
        this.state.set(to);
    }

    private pushSystem(content: string): ConvMessage {
        return this.push({ role: 'system', content, at: Date.now() });
    }

    private push(m: Omit<ConvMessage, 'id'>): ConvMessage {
        const full: ConvMessage = {
            ...m,
            id: this.msgSeq++,
        };
        this.messages.update(msgs => [...msgs, full]);
        return full;
    }
}