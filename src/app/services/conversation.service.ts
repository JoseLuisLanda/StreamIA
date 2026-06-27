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
import { classifyIntentLocal, classifyQueryMode, Intent } from '../lib/intent/intent-router';
import { GESTURES_LEADIN_ENABLED, GESTURES_TAIL_ENABLED, GESTURES_THINKING_ENABLED } from '../lib/config/feature-flags';

/**
 * Conversation orchestrator: explicit state machine wiring
 * mic -> transcript -> LLM -> sanitizer -> TTS+gestures -> back to idle.
 * Single source of truth for the status pill, mic button, and chat panel.
 * Pure transition table lives in lib/conversation/conv-states.ts (unit tested).
 */
import { ConvState, canTransition, interruptTarget } from '../lib/conversation/conv-states';

export type { ConvState };
export { canTransition, interruptTarget };

/**
 * LAST-RESORT code fallbacks (small lists, randomly picked) used only when neither
 * custom nor global responses resolved to anything. Never a single fixed phrase.
 */
const CODE_GREETINGS: Record<'es' | 'en', string[]> = {
    es: ['¡Hola! Qué gusto verte por aquí 😄', '¡Hey! ¿En qué te ayudo hoy?', '¡Hola! ¿Cómo te puedo apoyar?'],
    en: ['Hi! Great to see you 😄', 'Hey! How can I help today?', 'Hello! What can I do for you?'],
};
const CODE_FAREWELLS: Record<'es' | 'en', string[]> = {
    es: ['¡Hasta pronto! Aquí estaré cuando me necesites', '¡Cuídate! Vuelve cuando quieras'],
    en: ['See you soon! I will be here when you need me', 'Take care! Come back anytime'],
};
/** Contextual latency fillers spoken at t=0 while the RAG response generates. */
const CODE_INFOACKS: Record<'es' | 'en', string[]> = {
    es: [
        'En cuanto a tu solicitud, déjame revisar lo que tengo...',
        'Un momento, estoy consultando mi base de conocimiento...',
        'Buena pregunta, déjame buscar la información...',
    ],
    en: [
        'About your request, let me check what I have...',
        'One moment, I am looking that up in my knowledge base...',
        'Good question — let me find the information...',
    ],
};

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
    /** RAG: full long-form detail shown on "Ver mas" (NOT spoken). Empty -> hide.
     *  With the two-stage flow this is filled lazily AFTER the user clicks "Ver mas". */
    detail?: string;
    /** RAG stage-1: true when a detail CAN be fetched on demand (chunks exist). */
    detailAvailable?: boolean;
    /** RAG stage-1: chunk ids (from sources) reused by the on-demand detail call. */
    sourceIds?: string[];
    /** RAG stage-1: the user question, reused by the on-demand detail call. */
    srcQuery?: string;
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

    /**
     * Monotonic count of assistant responses whose SPEECH HAS FINISHED (normal end
     * OR user-stopped mid-speech -- stopped content still exists to review). Drives
     * the chat unread badge: it increments on speech-finish, NOT on response arrival,
     * so a reply that is still being spoken is "live" and not yet counted as unread.
     */
    public deliveredCount: WritableSignal<number> = signal(0);
    /** Of the delivered responses, how many carried media (drives the media badge). */
    public deliveredMediaCount: WritableSignal<number> = signal(0);
    /** Ids already counted as delivered, so stop-then-finish never double-counts. */
    private deliveredIds = new Set<number>();

    /**
     * Monotonic pulse that increments ONLY when speech finishes NATURALLY (the avatar
     * spoke the whole reply), NOT on a user Stop/interrupt. The UI uses this to play the
     * "fly subtitle to history" animation on a clean finish (and skip it on Stop).
     */
    public speechCompleted: WritableSignal<number> = signal(0);
    private signalNaturalEnd(): void { this.speechCompleted.update((n) => n + 1); }

    /** Mark an assistant message delivered exactly once (idempotent). */
    private markDelivered(msg: ConvMessage | null | undefined): void {
        if (!msg || msg.role !== 'assistant' || this.deliveredIds.has(msg.id)) return;
        this.deliveredIds.add(msg.id);
        this.deliveredCount.update((n) => n + 1);
        if (msg.media?.length) this.deliveredMediaCount.update((n) => n + 1);
    }

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
     *  the Cloud Function via this fetcher instead of the client LLM. null = LLM.
     *  The optional `mode` selects the Function answer mode: undefined/'rag' =
     *  normal retrieval; 'capabilities' = fast metadata-only answer (no RAG). */
    public ragFetcher: ((q: string, mode?: 'rag' | 'capabilities' | 'textual_quote') => Promise<RagResponse>) | null = null;

    // ---- Intent router (greeting/farewell vs RAG query). Active only in RAG mode. ----
    /** Cached greeting phrases (random non-repeating pick). Falls back to greetingResponse. */
    public greetings: string[] = [];
    /** Cached farewell phrases (random non-repeating pick). */
    public farewells: string[] = [];
    /** Cached info-acknowledgement fillers spoken right before a RAG call. */
    public infoAcks: string[] = [];
    /** Resolved (custom-or-global) pre-written capabilities/purpose answer. When
     *  non-empty, the capabilities intent speaks it DIRECTLY with no chatRag call. */
    public capabilitiesAnswer = '';
    /** Legacy single greeting reply (fallback when `greetings` is empty). */
    public greetingResponse: string | null = null;
    /** Per-assistant extra greeting triggers, merged with the global defaults. */
    public greetingKeywords: string[] | undefined;
    /** Per-assistant extra farewell triggers, merged with the global defaults. */
    public farewellKeywords: string[] | undefined;
    /** Per-assistant extra capability triggers, merged with the global defaults. */
    public capabilityKeywords: string[] | undefined;
    /** Per-assistant extra query verbs, merged with the global defaults. */
    public queryVerbs: string[] | undefined;
    /** Optional lightweight LLM fallback used ONLY when local classification is
     *  ambiguous. Returns 'greeting' | 'query'. null => ambiguous defaults to query. */
    public intentClassifier: ((q: string) => Promise<'greeting' | 'query'>) | null = null;

    /** Last-served index per phrase category, for non-repeating random picks. */
    private lastPick: Record<string, number> = {};

    /** Random pick that avoids repeating the previous one for this category. */
    private pickNonRepeating(key: string, pool: string[]): string {
        const list = pool.filter((s) => (s ?? '').trim());
        if (!list.length) return '';
        if (list.length === 1) return list[0];
        let idx = Math.floor(Math.random() * list.length);
        if (idx === this.lastPick[key]) idx = (idx + 1) % list.length;
        this.lastPick[key] = idx;
        return list[idx];
    }

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
     * Pause / resume the CURRENT speech in place (used by the detail "Ver mas"
     * playback). Unlike interrupt(), this does NOT bump the generation token or
     * stop the pipeline -- it suspends/resumes the audio clock, so audio, avatar
     * visemes and the karaoke highlight freeze and continue together. No-op when
     * nothing is speaking / not paused.
     */
    pauseSpeech(): void { this.tts.pauseSpeech(); }
    resumeSpeech(): void { this.tts.resumeSpeech(); }

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
        if (this.ragFetcher) void this.dispatchRag(text, opts);
        else void this.runTurn(text, opts);
    }

    /**
     * RAG-mode intent routing (phase one). Fast LOCAL classification first:
     *  - greeting  -> speak the per-assistant instant reply, NO RAG call.
     *  - query     -> hit the assistant's RAG namespace (runRagTurn).
     *  - ambiguous -> optional lightweight LLM classifier; default to query
     *                 (never silently drop a possible information request).
     */
    private async dispatchRag(text: string, opts: ConvTtsOpts): Promise<void> {
        const fetcher = this.ragFetcher;
        if (!fetcher) { void this.runTurn(text, opts); return; }

        let intent: Intent = classifyIntentLocal(text, {
            greetingKeywords: this.greetingKeywords,
            farewellKeywords: this.farewellKeywords,
            capabilityKeywords: this.capabilityKeywords,
            queryVerbs: this.queryVerbs,
        });
        if (intent === 'ambiguous') {
            intent = this.intentClassifier ? await this.intentClassifier(text) : 'query';
        }

        // Greeting / farewell -> instant local reply (random non-repeating), NO RAG.
        if (intent === 'greeting') {
            await this.speakInstant(text, this.pickGreeting(opts), 'saludo', opts);
            return;
        }
        if (intent === 'farewell') {
            await this.speakInstant(text, this.pickFarewell(opts), 'despedida', opts);
            return;
        }
        // Capabilities/purpose. Resolution order:
        //  (a) a pre-written answer (custom-or-global) -> speak directly, NO chatRag.
        //  (b) else -> chatRag capabilities mode (metadata-only; server may use a
        //      custom prompt template). RAG retrieval is never used in either path.
        if (intent === 'capabilities') {
            const answer = (this.capabilitiesAnswer || '').trim();
            if (answer) {
                await this.speakInstant(text, answer, 'capacidades', opts);
            } else {
                await this.runRagTurn(text, (q) => fetcher(q, 'capabilities'), opts);
            }
            return;
        }
        // Info query -> sub-classify: a LITERAL-scripture request ('textual_quote')
        // serves the verbatim passage by reference; everything else is interpretive
        // (the normal two-stage summary + on-demand detail).
        const qmode = classifyQueryMode(text);
        if (qmode === 'textual_quote') {
            await this.runRagTurn(text, (q) => fetcher(q, 'textual_quote'), opts);
            return;
        }
        await this.runRagTurn(text, fetcher, opts);
    }

    /** Force a chip-tapped suggested prompt straight to the RAG/info path. */
    sendSuggestedPrompt(prompt: string, opts: ConvTtsOpts): void {
        const fetcher = this.ragFetcher;
        const trimmed = (prompt ?? '').trim();
        if (!trimmed || !fetcher) return;
        this.lastOpts = opts;
        this.interruptInternals();
        if (this.state() !== 'idle') this.setState(interruptTarget(this.state()));
        void this.runRagTurn(trimmed, fetcher, opts);
    }

    private pickGreeting(opts: ConvTtsOpts): string {
        // Defensive: resolved greetings (custom-or-global) -> else a small RANDOM
        // code list. No single fixed phrase, so picks are always varied.
        const pool = this.greetings.length ? this.greetings : CODE_GREETINGS[opts.lang === 'en' ? 'en' : 'es'];
        return this.pickNonRepeating('greetings', pool);
    }
    private pickFarewell(opts: ConvTtsOpts): string {
        const pool = this.farewells.length ? this.farewells : CODE_FAREWELLS[opts.lang === 'en' ? 'en' : 'es'];
        return this.pickNonRepeating('farewells', pool);
    }
    /**
     * Contextual latency filler spoken at t=0 while a RAG query generates. Uses
     * the per-assistant infoAcknowledgements; falls back to a built-in contextual
     * list so there is ALWAYS something to say (never dead silence).
     */
    private pickInfoAck(opts?: ConvTtsOpts): string {
        const pool = this.infoAcks.length ? this.infoAcks : (opts ? CODE_INFOACKS[opts.lang === 'en' ? 'en' : 'es'] : []);
        return this.pickNonRepeating('infoAcks', pool);
    }


    /**
     * Instant local turn (greeting or farewell): echoes the user message, then
     * speaks `reply` through the same lead/body/tail + lipsync pipeline as a real
     * answer — but WITHOUT any RAG/Function round-trip.
     */
    private async speakInstant(query: string, reply: string, meta: string, opts: ConvTtsOpts): Promise<void> {
        this.stt.stop();
        const gen = ++this.gen;

        this.push({ role: 'user', content: query, at: Date.now() });

        const leadId = this.liveLeadGesture();
        const tailId = this.liveTailGesture();
        const msg = this.push({
            role: 'assistant', content: reply, at: Date.now(),
            meta, replayable: true,
            leadGesture: leadId || undefined, tailGesture: tailId || undefined,
        });

        this.setState('speaking');
        this.speakingMsgId.set(msg.id);
        if (opts.provider === 'piper') this.revealingMsgId.set(msg.id);

        try {
            if (leadId) this.gLead(leadId, undefined, undefined, true);
            await this.tts.speak(reply, { ...opts, singlePass: !!leadId });
            if (this.tts.lastPerformance) this.plans.set(msg.id, this.tts.lastPerformance);
            if (gen !== this.gen) return;
            this.speakingMsgId.set(null);
            this.revealingMsgId.set(null);
            this.markDelivered(msg); // speech finished -> now counts toward the chat badge
            this.signalNaturalEnd(); // natural finish -> UI flies the subtitle to history
            if (tailId) this.gTail(tailId, undefined, undefined, true);
            this.afterSpeaking(opts);
        } catch (e: any) {
            if (gen !== this.gen) return;
            this.fail(e?.message ?? String(e));
            if (gen === this.gen) this.setState('idle');
        }
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
            this.gLead(leadId, undefined, undefined, true);
        } else if (this.tts.waitingAnimsEnabled()) {
            this.gThinking('thinking', 1, 'slow');
        }

        const t0 = performance.now();
        let keepAlive: any = null;
        try {
            // Start the RAG call in the BACKGROUND immediately. Track completion so
            // we can keep the avatar moving until it returns.
            let pending = true;
            const fetchPromise = fetcher(query).finally(() => { pending = false; });

            // Speak a contextual filler at t=0 (overlaps the fetch); the lead-in
            // gesture (above) already runs in parallel. The filler's TTS finishes
            // BEFORE the answer is synthesized, so answer encoding never competes
            // with the filler's animation/lipsync.
            const ack = this.pickInfoAck(opts);
            if (ack) {
                this.setState('speaking');
                this.speakingMsgId.set(null);
                try { await this.tts.speak(ack, { ...opts, singlePass: true }); } catch { /* filler best-effort */ }
                if (gen !== this.gen) return;
                this.setState('waiting_llm');
            }

            // After the filler, keep gentle motion alive while generation finishes
            // so there is no silent/frozen gap (falls back to gesture-only if the
            // filler was empty). Stops as soon as the response arrives.
            if (pending && this.tts.waitingAnimsEnabled()) {
                keepAlive = setInterval(() => {
                    if (gen === this.gen && pending) this.gThinking('thinking', 1, 'slow');
                }, 2600);
            }

            const payload = await fetchPromise;
            if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
            if (gen !== this.gen) return; // interrupted while waiting
            const tReplyReceived = performance.now();
            this.pushSystem(`Respuesta recibida (${((tReplyReceived - t0) / 1000).toFixed(1)} s)`);

            // gestureCommands carries inline tags; fall back to plain body if absent.
            const spoken = (payload.gestureCommands || payload.body || '').trim();
            const sane = sanitizeLlmReply(spoken, new Set(GESTURE_MAP.keys()));
            for (const w of sane.warnings) console.warn('[rag-sanitizer]', w);
            const finalText = sane.text;

            // Two-stage detail: stage-1 returns NO detail. If one is already inline
            // (e.g. capabilities mode), keep it; otherwise mark detail as fetchable
            // and stash the chunk ids + question for the on-demand stage-2 call.
            const inlineDetail = ((payload as any).detail || '').trim();
            const srcIds = (payload.sources || []).map((s: any) => s?.id).filter((x: any): x is string => !!x);
            // Detail is fetchable when the backend says so (RAG OR training/general-knowledge
            // expansion -> training turns have no sources) or, for older backends, when we
            // have chunk ids to reuse. Empty sourceIds => stage-2 expands from general knowledge.
            const backendDetailAvailable = (payload as any).detailAvailable === true;
            const assistantMsg = this.push({
                role: 'assistant', content: finalText, at: Date.now(),
                meta: 'RAG', replayable: true, media: payload.media,
                detail: inlineDetail || undefined,
                detailAvailable: !inlineDetail && (backendDetailAvailable || srcIds.length > 0),
                sourceIds: srcIds.length ? srcIds : undefined,
                srcQuery: query,
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
            this.markDelivered(assistantMsg); // speech finished -> counts toward chat + media badges
            this.signalNaturalEnd(); // natural finish -> UI flies the subtitle to history

            const tailId = this.liveTailGesture();
            if (tailId) this.gTail(tailId, undefined, undefined, true);
            this.afterSpeaking(opts);
        } catch (e: any) {
            if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
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
            // singlePass ONLY when a lead-in gesture covers the synth latency: then
            // pre-compiling the whole block as one plan is fine. With NO lead-in (e.g.
            // detail / "Ver mas" playback), force the PROGRESSIVE per-segment path so the
            // avatar starts speaking on the first sentence instead of waiting for the whole
            // (possibly very long) block to synthesize -- minimizes time-to-first-word.
            await this.tts.speak(trimmed, { ...opts, singlePass: !!lead });
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

    /**
     * Full session reset for LEAVING the page or SWITCHING assistant. Goes beyond
     * clear(): first interruptInternals() stops TTS + STT and bumps the generation
     * token so any in-flight turn (summary/detail/suggestions) becomes a no-op when
     * it resolves; then it wipes the transcript/streaming/plans AND zeroes the badge
     * counters (deliveredCount / deliveredMediaCount / speechCompleted) plus the
     * dedupe set and non-repeat picker, so nothing from the previous assistant or
     * session carries over. Ends in the idle state. Does NOT touch the 3D
     * canvas/scene (audio stop != scene teardown).
     */
    resetSession(): void {
        this.interruptInternals();   // gen++, tts.stop(), stt.stop(); clears streaming/speaking/revealing
        this.messages.set([]);
        this.streaming.set('');
        this.llm.clearConversation();
        this.plans.clear();
        this.speakingMsgId.set(null);
        this.revealingMsgId.set(null);
        this.deliveredCount.set(0);
        this.deliveredMediaCount.set(0);
        this.speechCompleted.set(0);
        this.deliveredIds.clear();
        this.lastPick = {};
        this.setState('idle');
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
            this.gLead(leadId, undefined, undefined, true);
        } else if (this.tts.waitingAnimsEnabled()) {
            this.gThinking('thinking', 1, 'slow'); // waiting gesture: killed at audio start
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
            this.markDelivered(assistantMsg); // speech finished -> counts toward the chat badge
            this.signalNaturalEnd(); // natural finish -> UI flies the subtitle to history

            // Tail gesture (motion-only) plays after body speech completes
            const tailId = this.liveTailGesture();
            if (tailId) this.gTail(tailId, undefined, undefined, true);

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

    /**
     * Gesture triggers guarded by their INDEPENDENT sub-flags (debug bypass):
     *   gLead -> GESTURES_LEADIN_ENABLED, gTail -> GESTURES_TAIL_ENABLED,
     *   gThinking -> GESTURES_THINKING_ENABLED.
     * When a flag is off, that gesture is skipped entirely (no cold-path work).
     */
    private gLead(...args: Parameters<GesturePlayerService['trigger']>): void {
        if (GESTURES_LEADIN_ENABLED) this.gestures.trigger(...args);
    }
    private gTail(...args: Parameters<GesturePlayerService['trigger']>): void {
        if (GESTURES_TAIL_ENABLED) this.gestures.trigger(...args);
    }
    private gThinking(...args: Parameters<GesturePlayerService['triggerTransient']>): void {
        if (GESTURES_THINKING_ENABLED) this.gestures.triggerTransient(...args);
    }

    private interruptInternals(): void {
        this.gen++;            // any in-flight turn becomes a no-op
        // Stop-before-finish: the partially-spoken response still exists to review,
        // so it counts as unread (idempotent: a later normal finish won't double-count).
        const spId = this.speakingMsgId();
        if (spId != null) this.markDelivered(this.messages().find((m) => m.id === spId));
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