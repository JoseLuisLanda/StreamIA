# Análisis Detallado: Flujo STT y Problemas de "No-Speech" Falso

**Fecha**: 2026-06-11  
**Componente Principal Afectado**: SpeechRecognitionService  
**Síntoma**: Micrófono detecta sonido correctamente, pero después de ~8 segundos llega error "no se detectó voz" aunque el usuario está hablando.

---

## 1. DIAGRAMA DEL FLUJO STT ACTUAL

```
TextAvatarComponent
  ├─ micToggle()
  │  └─ stt.start(lang, callback)
  │
SpeechRecognitionService
  ├─ rec.start()
  ├─ rec.onresult() → interim/final transcript
  ├─ rec.onerror() → **PROBLEMA: "no-speech"**
  ├─ rec.onend() → **PROBLEMA: no reinicia**
  └─ wantListening (guarda estado intención)

TextAvatarComponent.onTranscript(transcript)
  ├─ stt.stop() (apaga mientras piensa/habla)
  ├─ LlmService.sendChat(transcript)
  ├─ TtsLipsyncService.speak(reply)
  └─ autoListen? → reinicia stt.start() (eventualmente)
```

---

## 2. PROBLEMAS IDENTIFICADOS

### Problema #1: Error "no-speech" no disparara Reintentos ⚠️ **CRÍTICO**

**Ubicación**: [speech-recognition.service.ts](speech-recognition.service.ts#L65-L70)

```typescript
rec.onerror = (ev: any) => this.ngZone.run(() => {
    if (ev.error !== 'aborted') console.warn('[SpeechRecognition] onerror', ev);
    switch (ev.error) {
        // ...
        case 'no-speech':
            this.error.set('No se detectó voz. Intenta de nuevo.');
            break;  // ← SIN HACER NADA MÁS
```

**Causa Raíz**: La Web Speech API tiene un timeout implícito de ~8 segundos sin detectar sonido. Cuando dispara `"no-speech"`:
- Solo establece `error.set()`
- NO establece `wantListening = false`
- NO reinicia la escucha automáticamente
- El usuario debe hacer clic en "🎤 Hablar" nuevamente manualmente

**Impacto**: 
- Usuario habla con pausas naturales > 8 segundos → pierde la conexión
- Experiencia UX frustante en conversaciones naturales
- Con `autoListen=true`, hay retraso porque espera a que `onTranscript()` termine para reintentar

---

### Problema #2: `onend()` no Reinicia Automáticamente ⚠️ **CRÍTICO**

**Ubicación**: [speech-recognition.service.ts](speech-recognition.service.ts#L79-L84)

```typescript
rec.onend = () => this.ngZone.run(() => {
    this.listening.set(false);
    this.interim.set('');
    this.recognition = null;
    // ← NO COMPRUEBA si wantListening=true para reintentar
});
```

**Escenario problemático**:
1. Usuario presiona micrófono → `wantListening = true`
2. API dispara `onend()` (por timeout sin voz, reconexión de red, etc.)
3. `recognition` se asigna a `null`
4. Usuario no sabe que la escucha se detuvo
5. No hay reintento automático

**Impacto**: 
- Desconexiones silenciosas sin retroalimentación al usuario
- En modo continuo (`continuous=true`), el usuario espera que siga escuchando

---

### Problema #3: Falta de Auto-recuperación después de Error ⚠️ **ALTO**

**Ubicación**: [speech-recognition.service.ts](speech-recognition.service.ts#L60-L80)

No hay ningún mecanismo para:
- Reintentar automáticamente después de `"no-speech"`
- Restaurar el reconocimiento si se perdió la conexión
- Detectar cuándo la API se cerró involuntariamente

**Comparación con Mejores Prácticas**:
```typescript
// ❌ ACTUAL (no reintenta)
case 'no-speech':
    this.error.set('No se detectó voz. Intenta de nuevo.');
    break;

// ✅ DEBERÍA ser
case 'no-speech':
    if (this.wantListening) {
        console.warn('[SpeechRecognition] no-speech, reiniciando...');
        setTimeout(() => {
            if (this.wantListening && !this.recognition) {
                this.start(this.lastLang, this.onFinal);
            }
        }, 500); // reintento con backoff
    } else {
        this.error.set('No se detectó voz. Intenta de nuevo.');
    }
    break;
```

---

### Problema #4: Timeout Implícito de la Web Speech API ⚠️ **ALTO**

**Hecho de la API**: 
- La Web Speech API tiene un timeout de ~5-10 segundos sin detectar sonido
- `continuous=true` **no deshabilita** este timeout
- Algunos navegadores (Chrome) lo resetean en `onresult`, otros no

**Configuración actual**:
```typescript
rec.continuous = true;        // no previene timeout
rec.interimResults = true;
rec.maxAlternatives = 1;
// ← FALTAN configuraciones de timeout/silencio
```

**Problema**: 
- Usuario tiene micrófono activo pero hay silencio natural → timeout tras ~8 segundos
- No hay configuración de "máximo silencio" adaptativa
- Error "no-speech" es muy genérico

---

### Problema #5: Pérdida de Contexto de Lenguaje ⚠️ **MEDIO**

**Ubicación**: [speech-recognition.service.ts](speech-recognition.service.ts#L24)

```typescript
start(lang: 'es' | 'en', onFinal: (text: string) => void): void {
    // ...
    const rec = new Ctor();
    rec.lang = lang === 'es' ? 'es-MX' : 'en-US';
    // ← El lenguaje se crea en cada start(), pero no se persiste para reintentos
```

**Problema si se reimplementa auto-reintentos**:
- Si implementamos reintentos en `onerror()`, perdemos la referencia al `lang` original
- Deberíamos guardar `this.lastLang` para poder reintentar con el mismo idioma

---

### Problema #6: Manejo de Estados Incompleto ⚠️ **MEDIO**

**Estado actual de `wantListening` vs `listening()`**:

| Situación | `wantListening` | `listening()` | Realidad |
|-----------|-----------------|---------------|----------|
| Usuario presiona mic | `true` | `true` | Correcto |
| API dispara "no-speech" | `true` | `false` | ❌ Inconsistente: usuario no sabe por qué se detuvo |
| Usuario presiona stop | `false` | `false` | Correcto |
| API se desconecta involuntariamente | `true` | `false` | ❌ Inconsistente: no hay reintento |

---

### Problema #7: Sin Logging/Debug de Eventos ⚠️ **MEDIO**

**Ubicación**: [speech-recognition.service.ts](speech-recognition.service.ts#L1-L100)

Logging actual:
```typescript
console.log('[SpeechRecognition] onresult event', ev);  // ✅ Bien
console.log('[SpeechRecognition] interim transcript:', interim);  // ✅ Bien
if (ev.error !== 'aborted') console.warn('[SpeechRecognition] onerror', ev);  // ✅ Bien pero sin detalles
// ← FALTA: logging en onend(), inicio de reintento, cambios de estado
```

**Problema**: 
- Difícil debuguear por qué falla el STT sin logs detallados
- No hay forma de saber si la API se está reiniciando internamente

---

## 3. FLUJO EN TextAvatarComponent (Interacción)

**Ubicación**: [text-avatar.component.ts](text-avatar.component.ts#L280-L350)

```typescript
micToggle() {
    if (this.stt.listening()) { 
        this.stt.stop(); 
        return; 
    }
    if (this.tts.state() !== 'idle') this.tts.stop();  // ✅ Previene que avatar se escuche a sí mismo
    this.convError.set(null);
    this.stt.start(this.lang, t => this.onTranscript(t));  // ← Callback registrado
}

private async onTranscript(transcript: string) {
    this.stt.stop();  // ← Para STT INMEDIATAMENTE
    // ... LLM processing ...
    // Espera a que TTS termine ...
    if (this.autoListen && this.tts.state() === 'idle') {
        this.stt.start(this.lang, t => this.onTranscript(t));  // ← Reinicia STT
    }
}
```

**Problemas en esta integración**:
1. Si `SpeechRecognitionService` dispara "no-speech", el componente NO sabe
2. El usuario debe presionar nuevamente para reintentar
3. No hay retroalimentación clara: "¿Por qué se detuvo el micrófono?"
4. Reintento en `onTranscript` es LENTO (espera a TTS completa)

---

## 4. FLUJO EN LlmService (No es la causa)

**Ubicación**: [llm.service.ts](llm.service.ts#L1-L150)

```typescript
async sendChat(userText: string, onDelta?: ...): Promise<string> {
    this.busy.set(true);
    try {
        let reply: string;
        switch (s.provider) {
            case 'ollama': reply = await this.chatOllama(...); break;
            case 'openai': reply = await this.chatOpenAiCompatible(...); break;
            // ... otros providers
        }
        // ... procesa respuesta
    } finally {
        this.busy.set(false);
    }
}
```

**Análisis**: ✅ El LlmService NO es la causa del error "no-speech"
- Opera DESPUÉS de que STT completa
- Si STT falla, nunca llega aquí
- Los timeouts de red de LLM son independientes

---

## 5. CAUSA RAÍZ CONFIRMADA

```
Usuario presiona 🎤 Hablar
  ↓
stt.start('es', callback) ✅
  ↓
rec.onresult() captura interim ✅
  ↓
[Silencio natural > 8 segundos]
  ↓
rec.onerror('no-speech') ❌
  → error.set('No se detectó voz')
  → wantListening SIGUE true (no lo cambia)
  ↓
rec.onend() ❌
  → listening.set(false)
  → recognition = null
  → NO REINICIA (debería porque wantListening=true)
  ↓
Usuario ve: "No se detectó voz. Intenta de nuevo."
Usuario debe presionar 🎤 nuevamente ❌
```

**Por qué sucede**:
1. La Web Speech API tiene timeout de ~8 segundos sin sonido
2. SpeechRecognitionService no compensa con reintentos
3. `continuous=true` es un mito: no previene este timeout
4. Los reintentos deben implementarse en la aplicación, no en la API

---

## 6. RECOMENDACIONES DETALLADAS

### Recomendación 1: Auto-Reintentar en Error "no-speech" 🔴 CRÍTICO

**Archivo a modificar**: [speech-recognition.service.ts](speech-recognition.service.ts)

```typescript
// Agregar propiedades privadas
private lastLang: 'es' | 'en' = 'es';
private retryCount = 0;
private maxRetries = 3;

// Modificar start()
start(lang: 'es' | 'en', onFinal: (text: string) => void): void {
    if (!this.isSupported || this.listening()) return;
    this.lastLang = lang;  // ← GUARDAR idioma
    this.retryCount = 0;   // ← RESETEAR reintentos
    this.error.set(null);
    this.interim.set('');
    this.onFinal = onFinal;
    this.wantListening = true;
    // ... resto igual
}

// Modificar onerror()
rec.onerror = (ev: any) => this.ngZone.run(() => {
    if (ev.error !== 'aborted') console.warn('[SpeechRecognition] onerror', ev);
    switch (ev.error) {
        case 'no-speech':
            console.warn('[SpeechRecognition] no-speech error, reintentando...', {
                attempt: this.retryCount + 1,
                maxRetries: this.maxRetries,
                wantListening: this.wantListening
            });
            
            if (this.wantListening && this.retryCount < this.maxRetries) {
                this.retryCount++;
                setTimeout(() => {
                    if (this.wantListening && !this.listening()) {
                        console.log(`[SpeechRecognition] reiniciando intento ${this.retryCount}...`);
                        this.recognition = null;
                        const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
                        const rec = new Ctor();
                        rec.lang = this.lastLang === 'es' ? 'es-MX' : 'en-US';
                        rec.continuous = true;
                        rec.interimResults = true;
                        rec.maxAlternatives = 1;
                        // ... (reasignar onresult, onerror, onend como en start())
                        this.recognition = rec;
                        try { rec.start(); } catch {
                            console.error('[SpeechRecognition] error reiniciando:', this.retryCount);
                        }
                    }
                }, 300 + this.retryCount * 200);  // backoff exponencial
            } else {
                this.error.set('No se detectó voz. Intenta de nuevo.');
                console.error('[SpeechRecognition] no-speech máx reintentos alcanzado');
            }
            break;
        // ... otros casos
    }
});

// Modificar onend()
rec.onend = () => this.ngZone.run(() => {
    console.log('[SpeechRecognition] onend', { 
        wantListening: this.wantListening, 
        listeningBefore: this.listening() 
    });
    
    if (this.wantListening && this.retryCount < this.maxRetries) {
        // La API se cerró pero el usuario quiere seguir escuchando
        console.log('[SpeechRecognition] reiniciando después de onend...');
        setTimeout(() => {
            if (this.wantListening && !this.listening()) {
                this.start(this.lastLang, this.onFinal!);
            }
        }, 200);
    } else {
        this.listening.set(false);
        this.interim.set('');
        this.recognition = null;
    }
});
```

---

### Recomendación 2: Mejorar Logging para Debugging 🟡 IMPORTANTE

```typescript
rec.onresult = (ev: any) => this.ngZone.run(() => {
    let interim = '';
    let finalText = '';
    console.log('[SpeechRecognition] onresult', {
        resultIndex: ev.resultIndex,
        resultsCount: ev.results.length,
        isFinal: ev.results[ev.results.length - 1]?.isFinal,
        retryCount: this.retryCount
    });
    // ... resto igual
});

rec.onend = () => this.ngZone.run(() => {
    console.log('[SpeechRecognition] onend', {
        wantListening: this.wantListening,
        listeningBefore: this.listening(),
        isStopped: !this.wantListening
    });
    // ...
});
```

---

### Recomendación 3: Agregar Manejo Explícito de Timeouts 🟡 IMPORTANTE

```typescript
// Agregar propiedad privada
private silenceTimeoutId: any = null;

start(lang: 'es' | 'en', onFinal: (text: string) => void): void {
    // ... código existente ...
    
    rec.onresult = (ev: any) => this.ngZone.run(() => {
        // Resetear timer de silencio cada vez que recibimos entrada
        if (this.silenceTimeoutId) clearTimeout(this.silenceTimeoutId);
        
        // Reiniciar timer: si no hay entrada en 12 segundos, avisar
        this.silenceTimeoutId = setTimeout(() => {
            if (this.listening()) {
                console.warn('[SpeechRecognition] silencio prolongado detectado, reiniciando...');
                this.recognition?.abort();
            }
        }, 12000);  // 12 segundos (más que el timeout implícito de 8s)
        
        // ... resto igual
    });
    
    rec.onend = () => this.ngZone.run(() => {
        if (this.silenceTimeoutId) clearTimeout(this.silenceTimeoutId);
        // ... resto igual
    });
}

stop(): void {
    this.wantListening = false;
    if (this.silenceTimeoutId) clearTimeout(this.silenceTimeoutId);
    // ... resto igual
}
```

---

### Recomendación 4: Mejorar UX del Componente 🟡 IMPORTANTE

**Ubicación**: [text-avatar.component.ts](text-avatar.component.ts#L40-L50)

Agregar indicador visual mejor:
```typescript
// Agregar signal nuevo
statusMessage = signal<string>('');

// En template
<div class="status" *ngIf="stt.listening()">
  🎤 Escuchando…
  <span *ngIf="stt.interim()">{{ stt.interim() }}</span>
</div>

<div class="warn" *ngIf="stt.error()">
  ⚠️ {{ stt.error() }}
  <span *ngIf="stt.listening()">Reintentando...</span>
</div>
```

---

### Recomendación 5: Refactorizar para Reutilizar Lógica ✅ OPCIONAL

Extraer la lógica `onresult/onerror/onend` a un método privado `setupRecognition()` para evitar duplicación cuando se reintenta:

```typescript
private setupRecognition(rec: any): void {
    rec.onresult = (ev: any) => { /* ... */ };
    rec.onerror = (ev: any) => { /* ... */ };
    rec.onend = () => { /* ... */ };
}
```

---

## 7. RESUMEN DE PROBLEMAS VS SOLUCIONES

| Problema | Severidad | Causa | Solución |
|----------|-----------|-------|----------|
| Error "no-speech" detiene escucha | 🔴 CRÍTICO | API timeout 8s + no reintentar | Auto-reintentar 3 veces con backoff |
| `onend()` no reinicia | 🔴 CRÍTICO | No comprueba `wantListening` | Reiniciar si `wantListening && retryCount < max` |
| Sin auto-recuperación | 🔴 CRÍTICO | Arquitectura no prevé reintentos | Implementar reintentos en `onerror` y `onend` |
| Timeout implícito no documentado | 🟡 ALTO | Web Speech API límite 8s | Agregar timer de silencio 12s |
| Contexto de lenguaje perdido | 🟡 MEDIO | `lang` no persistido para reintentos | Guardar `lastLang` en propiedad privada |
| Estados inconsistentes | 🟡 MEDIO | `wantListening` vs `listening()` | Sincronizar estados en todos los paths |
| Logging insuficiente | 🟡 MEDIO | No hay visibilidad de qué sucede | Agregar logs de transición de estado |
| UX confusa | 🟡 MEDIO | Usuario no sabe si reintentando | Mostrar estado "Reintentando..." |

---

## 8. PLAN DE IMPLEMENTACIÓN

### Fase 1: Crítico (1-2 horas)
1. Implementar auto-reintentos en `onerror('no-speech')`
2. Modificar `onend()` para reiniciar si `wantListening`
3. Guardar `lastLang` y `retryCount`

### Fase 2: Importante (30-60 min)
4. Mejorar logging en todos los eventos
5. Agregar timer de silencio para reinicio proactivo

### Fase 3: UX (30 min)
6. Actualizar mensaje de error a "Reintentando..." durante reintentos
7. Agregar logging en TextAvatarComponent

### Pruebas Recomendadas
- Hablar con pausas naturales > 8 segundos
- Silencio completo → esperar timeout
- Cancelar micrófono mientras reintenta
- Cambiar idioma mid-sesión

---

## Conclusión

El problema raíz es que **la Web Speech API tiene un timeout implícito de ~8 segundos sin detectar sonido**, y `continuous=true` **NO lo deshabilita**. El `SpeechRecognitionService` recibe correctamente el error `"no-speech"`, pero **no implementa reintentos automáticos**, dejando la carga al usuario.

La solución es implementar **reintentos automáticos con backoff exponencial** en los eventos `onerror` y `onend`, manteniendo estado en `wantListening`, `lastLang`, y `retryCount`.
