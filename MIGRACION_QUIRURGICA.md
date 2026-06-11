# Migración Quirúrgica: Aplicar Cambios Mínimos al Archivo Actual

Si prefieres NO reemplazar el archivo completo sino solo parchear las partes críticas, sigue esta guía paso a paso.

---

## Paso 0: Backup

```bash
# PowerShell
Copy-Item src\app\services\speech-recognition.service.ts `
  src\app\services\speech-recognition.service.ts.backup
```

---

## Paso 1: Agregar Propiedades Privadas

**Ubicación**: Después de `private wantListening = false;` (línea 24)

**BUSCA**:
```typescript
    /** guards against the API auto-restarting after we intentionally stop */
    private wantListening = false;

    constructor() {
```

**REEMPLAZA CON**:
```typescript
    /** guards against the API auto-restarting after we intentionally stop */
    private wantListening = false;

    // ========= NUEVAS PROPIEDADES PARA REINTENTOS =========
    /** Persiste el idioma para reintentos automáticos */
    private lastLang: 'es' | 'en' = 'es';
    
    /** Contador de reintentos con backoff exponencial */
    private retryCount = 0;
    private readonly maxRetries = 3;
    
    /** Timer para detectar silencio prolongado (> 12 segundos) */
    private silenceTimeoutId: any = null;
    // =======================================================

    constructor() {
```

✅ **Verificación**: Guardar archivo y no debe haber errores de compilación.

---

## Paso 2: Actualizar Método `start()`

**Ubicación**: Método `start()` (línea ~29)

**BUSCA**:
```typescript
    start(lang: 'es' | 'en', onFinal: (text: string) => void): void {
        if (!this.isSupported || this.listening()) return;
        this.error.set(null);
        this.interim.set('');
        this.onFinal = onFinal;
        this.wantListening = true;

        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new Ctor();
        rec.lang = lang === 'es' ? 'es-MX' : 'en-US';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

        rec.onresult = (ev: any) => this.ngZone.run(() => {
```

**REEMPLAZA CON**:
```typescript
    start(lang: 'es' | 'en', onFinal: (text: string) => void): void {
        if (!this.isSupported || this.listening()) return;
        this.error.set(null);
        this.interim.set('');
        this.onFinal = onFinal;
        this.wantListening = true;

        // ✨ NUEVO: Persiste lenguaje y resetea reintentos
        this.lastLang = lang;
        this.retryCount = 0;

        console.log('[SpeechRecognition] iniciando escucha', { 
            lang, 
            wantListening: this.wantListening 
        });

        // ✨ NUEVO: Delega creación a método privado
        this.createAndStartRecognition(lang);
    }

    /** ✨ NUEVO MÉTODO: Encapsula creación y configuración de la API */
    private createAndStartRecognition(lang: 'es' | 'en'): void {
        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        const rec = new Ctor();
        
        rec.lang = lang === 'es' ? 'es-MX' : 'en-US';
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;

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

    /** ✨ NUEVO MÉTODO: Centraliza setup de todos los event handlers */
    private setupRecognitionEvents(rec: any, lang: 'es' | 'en'): void {
        rec.onresult = (ev: any) => this.ngZone.run(() => {
            // ✨ NUEVO: Resetear timer de silencio cuando hay input
            if (this.silenceTimeoutId) clearTimeout(this.silenceTimeoutId);
            
            // ✨ NUEVO: Reiniciar timer de silencio
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
                this.retryCount = 0; // ✨ NUEVO: Resetear reintentos al éxito
                this.onFinal?.(finalText.trim());
            }
        });
```

✅ **Verificación**: El archivo se vuelve más largo (método `start()` ahora delega). Sin errores de compilación.

---

## Paso 3: Actualizar `rec.onerror` - Caso "no-speech"

**Ubicación**: Dentro de `setupRecognitionEvents()`, en `rec.onerror`

**BUSCA**:
```typescript
        rec.onerror = (ev: any) => this.ngZone.run(() => {
            if (ev.error !== 'aborted') console.warn('[SpeechRecognition] onerror', ev);
            switch (ev.error) {
                case 'not-allowed':
                case 'service-not-allowed':
                    this.error.set('Permiso de micrófono denegado. Habilítalo en el navegador.');
                    this.wantListening = false;
                    break;
                case 'no-speech':
                    this.error.set('No se detectó voz. Intenta de nuevo.');
                    break;
                case 'aborted':
                    break; // intentional stop
                case 'network':
                    this.error.set('El servicio de reconocimiento no está disponible (red).');
                    break;
                default:
                    this.error.set('Error de reconocimiento: ' + ev.error);
            }
        });
```

**REEMPLAZA CON**:
```typescript
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
                    // ✨ NUEVO: Reintentos automáticos 3 veces con backoff
                    if (this.wantListening && this.retryCount < this.maxRetries) {
                        this.retryCount++;
                        const delayMs = 300 + this.retryCount * 200; // 500ms, 700ms, 900ms
                        
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
                
                case 'aborted':
                    console.log('[SpeechRecognition] aborted (parada intencional)');
                    break;
                
                case 'network':
                    this.error.set('El servicio de reconocimiento no está disponible (red).');
                    console.warn('[SpeechRecognition] error de red, posible reintento en onend');
                    break;

                default:
                    this.error.set('Error de reconocimiento: ' + ev.error);
                    console.error('[SpeechRecognition] error desconocido:', ev.error);
            }
        });
```

✅ **Verificación**: Sin errores de compilación. El switch es más largo pero más robusto.

---

## Paso 4: Actualizar `rec.onend()`

**Ubicación**: Dentro de `setupRecognitionEvents()`, después de `rec.onerror`

**BUSCA**:
```typescript
        rec.onend = () => this.ngZone.run(() => {
            this.listening.set(false);
            this.interim.set('');
            this.recognition = null;
        });
```

**REEMPLAZA CON**:
```typescript
        rec.onend = () => this.ngZone.run(() => {
            // ✨ NUEVO: Limpiar timer de silencio
            if (this.silenceTimeoutId) clearTimeout(this.silenceTimeoutId);

            console.log('[SpeechRecognition] onend evento', {
                wantListening: this.wantListening,
                wasListening: this.listening(),
                retryCount: this.retryCount,
                language: lang
            });

            // ✨ NUEVO: Reinicia automáticamente si el usuario QUIERE escuchar
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
```

✅ **Verificación**: Sin errores de compilación.

---

## Paso 5: Actualizar Método `stop()`

**Ubicación**: Método `stop()` (casi al final del archivo)

**BUSCA**:
```typescript
    stop(): void {
        this.wantListening = false;
        if (this.recognition) {
            try { this.recognition.abort(); } catch { /* already stopped */ }
            this.recognition = null;
        }
        this.listening.set(false);
        this.interim.set('');
    }
```

**REEMPLAZA CON**:
```typescript
    stop(): void {
        console.log('[SpeechRecognition] deteniendo escucha');
        
        this.wantListening = false;
        this.retryCount = 0; // ✨ NUEVO: Resetear reintentos

        // ✨ NUEVO: Limpiar timer de silencio
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
        this.error.set(null); // ✨ NUEVO: Limpiar error también
    }
```

✅ **Verificación**: Sin errores de compilación. Archivo completo.

---

## Paso 6: Verificar que el Archivo está Completo

**Estructura esperada final**:

```typescript
import { Injectable, NgZone, inject, signal, WritableSignal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SpeechRecognitionService {
    // Propiedades públicas
    public readonly isSupported: boolean;
    public listening: WritableSignal<boolean> = signal(false);
    public interim: WritableSignal<string> = signal('');
    public error: WritableSignal<string | null> = signal(null);

    // Propiedades privadas
    private ngZone = inject(NgZone);
    private recognition: any = null;
    private onFinal: ((text: string) => void) | null = null;
    private wantListening = false;
    
    // ✨ NUEVAS PROPIEDADES
    private lastLang: 'es' | 'en' = 'es';
    private retryCount = 0;
    private readonly maxRetries = 3;
    private silenceTimeoutId: any = null;

    constructor() { /* ... */ }

    /** Método público */
    start(lang: 'es' | 'en', onFinal: (text: string) => void): void { /* ... */ }

    /** ✨ NUEVO MÉTODO PRIVADO */
    private createAndStartRecognition(lang: 'es' | 'en'): void { /* ... */ }

    /** ✨ NUEVO MÉTODO PRIVADO */
    private setupRecognitionEvents(rec: any, lang: 'es' | 'en'): void { /* ... */ }

    /** Método público */
    stop(): void { /* ... */ }
}
```

---

## Paso 7: Compilar y Probar

```bash
# Terminal
ng serve
```

**Esperado**:
```
✅ Compiled successfully
```

**Si hay errores**:
```bash
# Limpiar caché
rm -r node_modules/.angular/cache

# Reintentar
ng serve
```

---

## Paso 8: Prueba de Regresión

Antes de hacer commit, verifica que NO rompiste nada:

### Test 1: Funcionalidad Normal
```
1. Presiona 🎤 Hablar
2. Habla: "Hola"
3. Verifica transcripción en console
```

**Esperado**:
```
[SpeechRecognition] iniciando escucha { lang: 'es' }
[SpeechRecognition] onresult event { ... }
[SpeechRecognition] final transcript: "Hola"
✅ Funciona como antes
```

---

### Test 2: Pausa Larga (NUEVO COMPORTAMIENTO)
```
1. Presiona 🎤 Hablar
2. Habla: "Primera"
3. Silencio > 8 segundos
4. Habla: "Segunda"
```

**Esperado NUEVO** (antes fallaba):
```
[SpeechRecognition] final transcript: "Primera"
[SpeechRecognition] onerror { error: 'no-speech' }
[SpeechRecognition] no-speech detectado, reintentando... { attempt: 1 }
[SpeechRecognition] ejecutando reintento # 1
[SpeechRecognition] rec.start() ejecutado exitosamente
[SpeechRecognition] final transcript: "Segunda"
✅ Ambas frases capturadas!
```

---

### Test 3: Stop Manual (Regresión)
```
1. Presiona 🎤 Hablar
2. Presiona nuevamente (o espera a que TTS termine si autoListen)
```

**Esperado**:
```
[SpeechRecognition] deteniendo escucha
[SpeechRecognition] abort() ejecutado
✅ Para correctamente
```

---

## Checklist de Implementación

- [ ] Agregar propiedades privadas (4 líneas)
- [ ] Actualizar `start()` (3 cambios)
- [ ] Crear `createAndStartRecognition()` (nuevo método)
- [ ] Crear `setupRecognitionEvents()` (nuevo método)
- [ ] Actualizar `onerror` con reintentos "no-speech"
- [ ] Actualizar `onend()` con auto-reinicio
- [ ] Actualizar `stop()` con limpieza
- [ ] Compilar sin errores ✅
- [ ] Test 1: Funcionalidad normal ✅
- [ ] Test 2: Pausa larga ✅
- [ ] Test 3: Stop manual ✅
- [ ] Revisar console logs durante pruebas ✅
- [ ] Git commit con mensaje claro:
  ```
  fix(stt): Add auto-retry for "no-speech" errors and silence timeout
  
  - Auto-retry up to 3 times on "no-speech" error with exponential backoff
  - Auto-restart on onend() if user still wants to listen
  - Proper silence timeout detection (12 seconds)
  - Improved logging for debugging
  - Fixes #X (conversational gaps causing premature disconnect)
  ```

---

## Rollback (si es necesario)

```bash
# Si algo falla
cp src\app\services\speech-recognition.service.ts.backup `
   src\app\services\speech-recognition.service.ts

ng serve
```

---

## Próximas Mejoras (Opcional)

1. Agregar métrica de confianza en transcripción
2. Visualizar nivel de volumen detectado
3. Guardar historial de transcritos fallidos para análisis
4. Aumentar `maxRetries` a 5 para casos de red inestable
5. Hacer configurable el delay de reintentos (no hard-coded)

---

## Soporte

Si encuentras problemas:
1. Abre F12 → Console
2. Busca logs con `[SpeechRecognition]`
3. Verifica que `lastLang`, `retryCount`, `silenceTimeoutId` existen
4. Ejecuta `window.getSttLogs?.()` si lo agregaste (ver guía anterior)
5. Comparte los logs en tu issue/PR
