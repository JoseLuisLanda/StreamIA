import { Injectable, NgZone, inject, signal, WritableSignal } from '@angular/core';

/**
 * VERSIÓN MEJORADA: Microphone speech-to-text via the browser Web Speech API.
 * 
 * CAMBIOS:
 * - Auto-reintentos después de error "no-speech" (3 intentos con backoff exponencial)
 * - Reinicio automático en onend() si wantListening=true
 * - Persistencia de contexto de lenguaje para reintentos
 * - Logging mejorado para debugging
 * - Timer de silencio proactivo (12 segundos)
 */
@Injectable({ providedIn: 'root' })
export class SpeechRecognitionServiceImproved {
    public readonly isSupported: boolean;
    public listening: WritableSignal<boolean> = signal(false);
    public interim: WritableSignal<string> = signal('');
    public error: WritableSignal<string | null> = signal(null);

    private ngZone = inject(NgZone);
    private recognition: any = null;
    private onFinal: ((text: string) => void) | null = null;
    
    /** guards against the API auto-restarting after we intentionally stop */
    private wantListening = false;
    
    /** NEW: persiste lenguaje para reintentos */
    private lastLang: 'es' | 'en' = 'es';
    
    /** NEW: contador de reintentos con falloff exponencial */
    private retryCount = 0;
    private readonly maxRetries = 3;
    
    /** NEW: timer para detectar silencio prolongado */
    private silenceTimeoutId: any = null;

    constructor() {
        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        this.isSupported = !!Ctor;
    }

    /** Start listening. onFinal fires once per final transcript segment. */
    start(lang: 'es' | 'en', onFinal: (text: string) => void): void {
        if (!this.isSupported || this.listening()) return;
        
        this.error.set(null);
        this.interim.set('');
        this.onFinal = onFinal;
        this.wantListening = true;
        
        // NEW: persiste lenguaje y resetea reintentos
        this.lastLang = lang;
        this.retryCount = 0;

        console.log('[SpeechRecognition] iniciando escucha', { 
            lang, 
            wantListening: this.wantListening 
        });

        this.createAndStartRecognition(lang);
    }

    /** NEW: método privado que encapsula la creación y setup de la API */
    private createAndStartRecognition(lang: 'es' | 'en'): void {
        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new Ctor();
        
        rec.lang = lang === 'es' ? 'es-MX' : 'en-US';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        // Setup de eventos consolidado
        this.setupRecognitionEvents(rec, lang);

        this.recognition = rec;
        this.listening.set(true);
        
        try { 
            rec.start();
            console.log('[SpeechRecognition] rec.start() ejecutado exitosamente');
        } catch (e) {
            this.listening.set(false);
            this.error.set('No se pudo iniciar el micrófono.');
            console.error('[SpeechRecognition] error al iniciar:', e);
        }
    }

    /** NEW: centraliza el setup de todos los event handlers */
    private setupRecognitionEvents(rec: any, lang: 'es' | 'en'): void {
        rec.onresult = (ev: any) => this.ngZone.run(() => {
            // NEW: resetear timer de silencio cuando hay input
            if (this.silenceTimeoutId) clearTimeout(this.silenceTimeoutId);
            
            // NEW: reiniciar timer de silencio
            this.silenceTimeoutId = setTimeout(() => {
                if (this.listening()) {
                    console.warn('[SpeechRecognition] silencio prolongado (>12s), reintentando...');
                    if (this.recognition) {
                        try { this.recognition.abort(); } catch { }
                    }
                }
            }, 12000);

            let interim = '';
            let finalText = '';
            
            console.log('[SpeechRecognition] onresult event', {
                resultIndex: ev.resultIndex,
                resultsCount: ev.results.length,
                isFinal: ev.results[ev.results.length - 1]?.isFinal || false,
                retryCount: this.retryCount
            });

            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const r = ev.results[i];
                if (r.isFinal) finalText += r[0].transcript;
                else interim += r[0].transcript;
            }
            
            if (interim) {
                this.interim.set(interim);
                console.log('[SpeechRecognition] interim transcript:', interim);
            }
            
            if (finalText.trim()) {
                this.interim.set('');
                console.log('[SpeechRecognition] final transcript:', finalText.trim());
                this.retryCount = 0; // NEW: resetear reintentos al recibir texto final
                this.onFinal?.(finalText.trim());
            }
        });

        rec.onerror = (ev: any) => this.ngZone.run(() => {
            console.warn('[SpeechRecognition] onerror', {
                error: ev.error,
                wantListening: this.wantListening,
                retryCount: this.retryCount,
                maxRetries: this.maxRetries
            });

            if (ev.error !== 'aborted') {
                console.warn('[SpeechRecognition] error event:', ev);
            }

            switch (ev.error) {
                case 'not-allowed':
                case 'service-not-allowed':
                    this.error.set('Permiso de micrófono denegado. Habilítalo en el navegador.');
                    this.wantListening = false;
                    break;

                case 'no-speech':
                    // NEW: reintentar automáticamente 3 veces con backoff
                    if (this.wantListening && this.retryCount < this.maxRetries) {
                        this.retryCount++;
                        const delayMs = 300 + this.retryCount * 200; // backoff: 500ms, 700ms, 900ms
                        
                        console.log('[SpeechRecognition] no-speech detectado, reintentando...', {
                            attempt: this.retryCount,
                            delayMs,
                            language: lang
                        });

                        this.error.set(`Sin voz detectada (reintentando ${this.retryCount}/${this.maxRetries})...`);

                        setTimeout(() => {
                            if (this.wantListening && !this.listening()) {
                                console.log('[SpeechRecognition] ejecutando reintento #', this.retryCount);
                                this.createAndStartRecognition(this.lastLang);
                            }
                        }, delayMs);
                    } else {
                        // Máximo de reintentos alcanzado
                        this.error.set('No se detectó voz. Intenta de nuevo.');
                        console.error('[SpeechRecognition] no-speech máx reintentos alcanzado', {
                            attemptsUsed: this.retryCount,
                            wantListening: this.wantListening
                        });
                    }
                    break;

                case 'network':
                    this.error.set('El servicio de reconocimiento no está disponible (red).');
                    console.warn('[SpeechRecognition] error de red, posible reintento en onend');
                    break;

                case 'aborted':
                    console.log('[SpeechRecognition] aborted (parada intencional)');
                    break;

                default:
                    this.error.set('Error de reconocimiento: ' + ev.error);
                    console.error('[SpeechRecognition] error desconocido:', ev.error);
            }
        });

        rec.onend = () => this.ngZone.run(() => {
            // NEW: limpiar timer de silencio
            if (this.silenceTimeoutId) clearTimeout(this.silenceTimeoutId);

            console.log('[SpeechRecognition] onend evento', {
                wantListening: this.wantListening,
                wasListening: this.listening(),
                retryCount: this.retryCount,
                language: lang
            });

            // NEW: reiniciar si el usuario QUIERE seguir escuchando (no fue un stop() intencional)
            if (this.wantListening && this.retryCount < this.maxRetries) {
                const delayMs = 200;
                console.log('[SpeechRecognition] API se cerró pero wantListening=true, reiniciando en', delayMs, 'ms');
                
                setTimeout(() => {
                    if (this.wantListening && !this.listening()) {
                        console.log('[SpeechRecognition] reiniciando después de onend...');
                        this.createAndStartRecognition(this.lastLang);
                    }
                }, delayMs);
            } else {
                // Parada intencional o máximo de reintentos
                this.listening.set(false);
                this.interim.set('');
                this.recognition = null;
                console.log('[SpeechRecognition] escucha detenida (intencional o máx reintentos)');
            }
        });
    }

    stop(): void {
        console.log('[SpeechRecognition] deteniendo escucha');
        
        this.wantListening = false;
        this.retryCount = 0; // NEW: resetear reintentos
        
        // NEW: limpiar timer de silencio
        if (this.silenceTimeoutId) {
            clearTimeout(this.silenceTimeoutId);
            this.silenceTimeoutId = null;
        }

        if (this.recognition) {
            try { 
                this.recognition.abort(); 
                console.log('[SpeechRecognition] abort() ejecutado');
            } catch (e) {
                console.warn('[SpeechRecognition] error durante abort():', e);
            }
            this.recognition = null;
        }
        
        this.listening.set(false);
        this.interim.set('');
        this.error.set(null);
    }
}
