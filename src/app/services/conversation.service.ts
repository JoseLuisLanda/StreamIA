import { Injectable, inject, signal, WritableSignal } from '@angular/core';
import { TtsLipsyncService, TtsProvider, TtsLang } from './tts-lipsync.service';
import { SpeechRecognitionService } from './speech-recognition.service';
import { LlmService, LLM_PROVIDER_LABELS } from './llm.service';
import { GesturePlayerService } from './gesture-player.service';
import { sanitizeLlmReply, truncateAtSentence } from '../lib/llm/llm-sanitizer';
import { GESTURE_MAP } from '../lib/gestures/gesture-library';

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
    role: 'user' | 'assistant' | 'system';
    content: string;
    /** epoch ms */
    at: number;
    /** e.g. "Ollama (local) · llama3.2" or "modo texto" */
    meta?: string;
    kind?: 'info' | 'error';
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

    /** generation token: bumping it makes any in-flight turn a no-op */
    private gen = 0;
    private lastOpts: ConvTtsOpts = { provider: 'piper', lang: 'es' };

    // ------------------------------------------------------------------ API

    /** Mic pressed. From speaking: interrupts and starts listening. */
    startListening(opts: ConvTtsOpts): void {
        if (this.muted || !this.stt.isSupported) return;
        this.lastOpts = opts;
        if (this.state() === 'listening') { this.finishListening(); return; }
        this.interruptInternals(); // stops TTS + any in-flight turn (echo prevention)
        if (this.state() !== 'idle') this.setState(interruptTarget(this.state())); // pass through idle
        this.setState('listening');
        this.stt.start(opts.lang, t => this.onFinalTranscript(t));
    }

    /** Mic pressed while listening: end the turn gracefully (flushes final). */
    finishListening(): void {
        if (this.state() !== 'listening') return;
        this.stt.finish();
        // state advances in onFinalTranscript; if nothing was said the STT
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

    /** Manual "Modo texto": speak typed text through the same pipeline + log it. */
    async sayManual(text: string, opts: ConvTtsOpts): Promise<void> {
        const trimmed = text.trim();
        if (!trimmed) return;
        this.lastOpts = opts;
        this.interruptInternals();
        const gen = ++this.gen;
        this.push({ role: 'assistant', content: trimmed, at: Date.now(), meta: 'modo texto' });
        this.setState('speaking');
        try {
            await this.tts.speak(trimmed, opts);
        } catch (e: any) {
            this.fail('TTS: ' + (e?.message ?? e));
        } finally {
            if (gen === this.gen && this.state() === 'speaking') this.setState('idle');
        }
    }

    clear(): void {
        this.messages.set([]);
        this.streaming.set('');
        this.llm.clearConversation();
    }

    // ----------------------------------------------------------------- turn

    private async onFinalTranscript(transcript: string): Promise<void> {
        this.stt.stop(); // hard off: never listen while we think & speak
        const gen = ++this.gen;
        const opts = this.lastOpts;
        const s = this.llm.settings();
        const cfg = s.providers[s.provider];
        const label = LLM_PROVIDER_LABELS[s.provider];

        this.push({ role: 'user', content: transcript, at: Date.now() });
        this.setState('sending');
        this.pushSystem(`Transcripción enviada a ${label} (${cfg.model})…`);
        this.setState('waiting_llm');
        this.gestures.trigger('thinking', 1, 'slow');

        const t0 = performance.now();
        try {
            const reply = await this.llm.sendChat(transcript, acc => {
                if (gen === this.gen) this.streaming.set(acc);
            });
            if (gen !== this.gen) return; // interrupted while waiting
            this.streaming.set('');
            this.pushSystem(`Respuesta recibida (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

            const sane = sanitizeLlmReply(reply, new Set(GESTURE_MAP.keys()));
            for (const w of sane.warnings) console.warn('[llm-sanitizer]', w);
            if (sane.corrected || sane.removed) {
                this.pushSystem(`Sanitizado: ${sane.corrected} etiqueta(s) corregida(s), ${sane.removed} eliminada(s)`);
            }

            let finalText = sane.text;
            const truncated = truncateAtSentence(finalText, 250);
            if (truncated !== null) {
                finalText = truncated;
                this.pushSystem('Respuesta truncada (límite de longitud)');
            }

            this.push({ role: 'assistant', content: finalText, at: Date.now(), meta: `${label} · ${cfg.model}` });
            this.setState('speaking');
            await this.tts.speak(finalText, opts);
            if (gen !== this.gen) return; // interrupted while speaking
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
            this.stt.start(opts.lang, t => this.onFinalTranscript(t));
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

    private push(m: ConvMessage): void {
        this.messages.update(list => [...list, m]);
    }

    private pushSystem(content: string): void {
        this.push({ role: 'system', kind: 'info', content, at: Date.now() });
    }
}
