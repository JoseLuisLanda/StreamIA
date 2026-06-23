import { Injectable, NgZone, inject, signal, WritableSignal } from '@angular/core';

/** Set localStorage 'textAvatar.debugSTT' = '1' to re-enable verbose console logs. */
const DEBUG = () => localStorage.getItem('textAvatar.debugSTT') === '1';
const dlog = (...a: unknown[]) => { if (DEBUG()) console.log('[SpeechRecognition]', ...a); };

/**
 * Microphone speech-to-text via the browser Web Speech API (SpeechRecognition).
 * Local-first: no keys (Chrome/Edge route audio through their own speech
 * service; Firefox desktop unsupported -> isSupported=false).
 *
 * MOBILE handling: mobile Chrome (Android) ENDS recognition on its own after a
 * couple seconds regardless of `continuous`, capturing only the first phrase.
 * Fixes:
 *  - continuous=true + interimResults=true (do not cut off after the first word).
 *  - AUTO-RESTART on `onend` while the mic is still "active" (the user has not
 *    toggled it off), so the user can speak as long as they want. Each restart is
 *    a fresh recognition session, so the final transcript is ACCUMULATED across
 *    sessions (`finalAccum`) and only delivered on finish()/idle/tap-off.
 *  - IDLE backstop (idleTimeoutMs, default 8000): if NO speech is detected for the
 *    window, auto-stop so it never listens forever. RESET on every result /
 *    speechstart so an actively-speaking user is never cut off.
 *  - onerror: fatal errors (not-allowed / network) stop cleanly with the UI off;
 *    transient ones (no-speech / aborted) let the auto-restart logic continue.
 *
 * The `listening` signal stays TRUE across auto-restarts and only flips false on a
 * real stop (tap-off, idle timeout, hard stop, or fatal error) so the mic UI
 * always reflects the true state.
 */
@Injectable({ providedIn: 'root' })
export class SpeechRecognitionService {
    public readonly isSupported: boolean;
    public listening: WritableSignal<boolean> = signal(false);
    public interim: WritableSignal<string> = signal('');
    public error: WritableSignal<string | null> = signal(null);

    private ngZone = inject(NgZone);
    private recognition: any = null;
    private onFinal: ((text: string) => void) | null = null;
    private lang: 'es' | 'en' = 'es';

    /** user wants the mic ON -> drives auto-restart (source of truth for restarts). */
    private active = false;
    /** final transcript accumulated ACROSS auto-restart sessions. */
    private finalAccum = '';
    /** latest interim of the CURRENT session (reset each restart). */
    private lastInterim = '';
    private deliveredFinal = false;

    private idleTimer: any = null;
    private restartTimer: any = null;

    /** Idle backstop: ms with NO speech before auto-stopping. Configurable. */
    public idleTimeoutMs = 8000;

    constructor() {
        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        this.isSupported = !!Ctor;
    }

    /** Start listening. onFinal fires exactly once per listening session. */
    start(lang: 'es' | 'en', onFinal: (text: string) => void): void {
        if (!this.isSupported || this.listening()) return;
        this.error.set(null);
        this.interim.set('');
        this.onFinal = onFinal;
        this.lang = lang;
        this.finalAccum = '';
        this.lastInterim = '';
        this.deliveredFinal = false;
        this.active = true;
        this.listening.set(true);
        this.armIdle();
        this.createAndStart();
    }

    /** (Re)create a recognition session and start it. Used on first start AND on
     *  each auto-restart. Keeps `active`/`finalAccum` so the turn continues. */
    private createAndStart(): void {
        if (!this.active) return;
        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new Ctor();
        rec.lang = this.lang === 'es' ? 'es-MX' : 'en-US';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onspeechstart = () => this.ngZone.run(() => this.armIdle());

        rec.onresult = (ev: any) => this.ngZone.run(() => {
            this.armIdle(); // speech detected -> never cut off an active speaker
            let interim = '';
            let sessionFinal = '';
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const r = ev.results[i];
                if (r.isFinal) sessionFinal += r[0].transcript + ' ';
                else interim += r[0].transcript;
            }
            if (sessionFinal.trim()) this.finalAccum = (this.finalAccum + ' ' + sessionFinal).trim();
            this.lastInterim = interim;
            // Show the full building transcript (accumulated finals + current interim).
            const shown = (this.finalAccum + ' ' + interim).trim();
            this.interim.set(shown);
            dlog('onresult', { sessionFinal, interim, accum: this.finalAccum });
        });

        rec.onerror = (ev: any) => this.ngZone.run(() => {
            if (ev.error !== 'aborted') dlog('onerror', ev.error);
            switch (ev.error) {
                case 'not-allowed':
                case 'service-not-allowed':
                    this.error.set('Permiso de microfono denegado. Habilitalo en el navegador.');
                    this.hardOff();            // fatal -> stop, UI off, no restart
                    break;
                case 'network':
                    this.error.set('El servicio de reconocimiento no esta disponible (red).');
                    this.hardOff();            // can't recover by restarting
                    break;
                case 'no-speech':
                case 'aborted':
                    break;                     // transient -> onend decides restart/stop
                default:
                    this.error.set('Error de reconocimiento: ' + ev.error);
                    break;                     // let onend handle it
            }
        });

        rec.onend = () => this.ngZone.run(() => {
            dlog('onend', { active: this.active, accum: this.finalAccum, lastInterim: this.lastInterim });
            // Mobile ends the session on its own. If the user still wants the mic on,
            // RESTART (a fresh session) to keep listening. Guard: only while active.
            if (this.active) {
                this.recognition = null;
                if (this.restartTimer) clearTimeout(this.restartTimer);
                this.restartTimer = setTimeout(() => this.ngZone.run(() => {
                    this.restartTimer = null;
                    if (this.active) this.createAndStart(); // re-check: user may have toggled off
                }), 250); // small gap avoids tight restart loops / "already started"
                return;
            }
            // Not active -> a real stop is in progress; cleanup handled by finish()/stop().
            this.recognition = null;
        });

        this.recognition = rec;
        try { rec.start(); dlog('session started, lang=', rec.lang); } catch {
            // "already started" or transient -> drop; onend/idle will recover.
        }
    }

    /**
     * Graceful finish: the user ended their turn (tapped the mic). Stop restarting,
     * stop the engine, and DELIVER the accumulated transcript (+ pending interim).
     */
    finish(): void {
        if (!this.active && !this.recognition) return;
        this.active = false;
        this.clearIdle();
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        try { this.recognition?.stop(); } catch { /* already stopped */ }
        this.recognition = null;
        const text = (this.finalAccum + ' ' + this.lastInterim).trim();
        this.listening.set(false);
        this.interim.set('');
        this.deliverFinal(text);
    }

    /** Hard stop: discards anything pending (interruptions, echo prevention). */
    stop(): void {
        this.active = false;
        this.clearIdle();
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        this.onFinal = null; // never deliver after a hard stop
        if (this.recognition) {
            try { this.recognition.abort(); } catch { /* already stopped */ }
            this.recognition = null;
        }
        this.listening.set(false);
        this.interim.set('');
        this.lastInterim = '';
        this.finalAccum = '';
    }

    // ----------------------------------------------------------------- internals

    /** Fatal-error path: stop cleanly so the mic UI is never stuck "on". */
    private hardOff(): void {
        this.active = false;
        this.clearIdle();
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
        try { this.recognition?.abort(); } catch { /* already stopped */ }
        this.recognition = null;
        this.listening.set(false);
        this.interim.set('');
    }

    private deliverFinal(text: string): void {
        if (this.deliveredFinal) return;
        this.deliveredFinal = true;
        const cb = this.onFinal;
        this.onFinal = null;
        if (text) { dlog('FINAL:', text); cb?.(text); }
    }

    /** Idle backstop: no speech for idleTimeoutMs -> auto-stop (deliver if any text). */
    private armIdle(): void {
        this.clearIdle();
        this.idleTimer = setTimeout(() => this.ngZone.run(() => {
            dlog('idle timeout -> auto-stop');
            if ((this.finalAccum + ' ' + this.lastInterim).trim()) {
                this.finish();   // spoke then went silent -> deliver what we have
            } else {
                this.error.set('No se detecto voz. Intenta de nuevo.');
                this.stop();     // never spoke -> just stop, UI off
            }
        }), this.idleTimeoutMs);
    }

    private clearIdle(): void {
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }
}
