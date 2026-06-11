import { Injectable, NgZone, inject, signal, WritableSignal } from '@angular/core';

/** Set localStorage 'textAvatar.debugSTT' = '1' to re-enable verbose console logs. */
const DEBUG = () => localStorage.getItem('textAvatar.debugSTT') === '1';
const dlog = (...a: unknown[]) => { if (DEBUG()) console.log('[SpeechRecognition]', ...a); };

/**
 * Microphone speech-to-text via the browser Web Speech API (SpeechRecognition).
 * Local-first: no keys (Chrome/Edge route audio through their own speech
 * service; Firefox desktop unsupported -> isSupported=false).
 *
 * continuous=true keeps listening across short pauses; finalization happens by:
 *  - the engine emitting isFinal (long pause), or
 *  - finish(): graceful rec.stop() that FLUSHES the pending result
 *    (unlike abort(), which discards it - this was the bug that froze the
 *    pipeline at the interim stage), or
 *  - the silence watchdog: no new results for SILENCE_MS while interim text
 *    exists -> finish() automatically (hands-free turn taking).
 * If the engine ends without ever emitting isFinal, the last interim text is
 * delivered as the final transcript.
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

    private lastInterim = '';
    private deliveredFinal = false;
    private finishing = false;
    private silenceTimer: any = null;
    /** ms without new results (while interim text exists) before auto-finalizing */
    public silenceMs = 1800;

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
        this.lastInterim = '';
        this.deliveredFinal = false;
        this.finishing = false;

        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new Ctor();
        rec.lang = lang === 'es' ? 'es-MX' : 'en-US';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onresult = (ev: any) => this.ngZone.run(() => {
            let interim = '';
            let finalText = '';
            for (let i = 0; i < ev.results.length; i++) {
                const r = ev.results[i];
                if (r.isFinal) finalText += r[0].transcript + ' ';
                else interim += r[0].transcript;
            }
            dlog('onresult', { interim, finalText });
            this.armSilenceWatchdog();
            if (finalText.trim()) {
                this.deliverFinal((finalText + ' ' + interim).trim());
                return;
            }
            if (interim) {
                this.lastInterim = interim;
                this.interim.set(interim);
            }
        });

        rec.onerror = (ev: any) => this.ngZone.run(() => {
            if (ev.error !== 'aborted') dlog('onerror', ev.error);
            switch (ev.error) {
                case 'not-allowed':
                case 'service-not-allowed':
                    this.error.set('Permiso de micrófono denegado. Habilítalo en el navegador.');
                    break;
                case 'no-speech':
                    this.error.set('No se detectó voz. Intenta de nuevo.');
                    break;
                case 'aborted':
                    break; // intentional
                case 'network':
                    this.error.set('El servicio de reconocimiento no está disponible (red).');
                    break;
                default:
                    this.error.set('Error de reconocimiento: ' + ev.error);
            }
        });

        rec.onend = () => this.ngZone.run(() => {
            dlog('onend', { finishing: this.finishing, delivered: this.deliveredFinal, lastInterim: this.lastInterim });
            // engine ended without a final result: salvage the interim text
            if (!this.deliveredFinal && this.lastInterim.trim() && this.finishing) {
                this.deliverFinal(this.lastInterim.trim());
            }
            this.clearWatchdog();
            this.listening.set(false);
            this.interim.set('');
            this.recognition = null;
        });

        this.recognition = rec;
        this.listening.set(true);
        try { rec.start(); dlog('started, lang=', rec.lang); } catch {
            this.listening.set(false);
            this.error.set('No se pudo iniciar el micrófono.');
        }
    }

    /**
     * Graceful finish: stops the engine but lets it FLUSH the pending final
     * result (or salvages the interim). Use this when the user taps the mic
     * to end their turn.
     */
    finish(): void {
        if (!this.recognition) return;
        this.finishing = true;
        this.clearWatchdog();
        try { this.recognition.stop(); } catch { /* already stopped */ }
        // safety net: if the engine never calls onend, salvage after 700 ms
        setTimeout(() => this.ngZone.run(() => {
            if (!this.deliveredFinal && this.lastInterim.trim()) {
                this.deliverFinal(this.lastInterim.trim());
            }
        }), 700);
    }

    /** Hard stop: discards anything pending (interruptions, echo prevention). */
    stop(): void {
        this.clearWatchdog();
        this.onFinal = null; // never deliver after a hard stop
        if (this.recognition) {
            try { this.recognition.abort(); } catch { /* already stopped */ }
            this.recognition = null;
        }
        this.listening.set(false);
        this.interim.set('');
        this.lastInterim = '';
    }

    // ----------------------------------------------------------------- internals

    private deliverFinal(text: string): void {
        if (this.deliveredFinal || !text) return;
        this.deliveredFinal = true;
        this.clearWatchdog();
        this.interim.set('');
        dlog('FINAL:', text);
        const cb = this.onFinal;
        this.onFinal = null;
        cb?.(text);
    }

    private armSilenceWatchdog(): void {
        this.clearWatchdog();
        this.silenceTimer = setTimeout(() => this.ngZone.run(() => {
            if (this.lastInterim.trim() && !this.deliveredFinal) {
                dlog('silence watchdog -> finish()');
                this.finish();
            }
        }), this.silenceMs);
    }

    private clearWatchdog(): void {
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    }
}
