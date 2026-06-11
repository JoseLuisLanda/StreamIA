# Guía de Implementación de Solución STT

## Paso 1: Validar el Análisis

Abre la consola de desarrollador (F12 → Console) mientras usas el micrófono:

### Test 1: Timeout Normal
```
1. Presiona 🎤 Hablar
2. Habla algo
3. Silencio completo por ~10 segundos
```

**Observa en console**:
```
[SpeechRecognition] iniciando escucha { lang: 'es', wantListening: true }
[SpeechRecognition] rec.start() ejecutado exitosamente
[SpeechRecognition] onresult event { ... isFinal: true }
[SpeechRecognition] final transcript: "tu texto aquí"
[SpeechRecognition] onerror { error: 'no-speech', wantListening: true, retryCount: 0 }
❌ [SpeechRecognition] no-speech máx reintentos alcanzado
```

**Resultado esperado**: Error "No se detectó voz" → Usuario debe reintentar manualmente

---

### Test 2: Pausa Natural
```
1. Presiona 🎤 Hablar
2. Habla: "Hola mundo"
3. Pausa 5 segundos
4. Habla: "¿Cómo estás?"
```

**Observa en console**:
```
[SpeechRecognition] final transcript: "Hola mundo"
[SpeechRecognition] final transcript: "¿Cómo estás?"
✅ Ambas frases se capturan
```

**Si falla**: Hay problema con pausa > 8 segundos

---

## Paso 2: Reemplazar el Servicio

### Opción A: Reemplazo Completo (RECOMENDADO)

Reemplaza el contenido completo de:
```
src/app/services/speech-recognition.service.ts
```

Con el contenido de:
```
SPEECH_RECOGNITION_SERVICE_MEJORADO.ts
```

**Cambios principales**:
- Agregar propiedades: `lastLang`, `retryCount`, `silenceTimeoutId`
- Nuevo método: `createAndStartRecognition(lang)`
- Nuevo método: `setupRecognitionEvents(rec, lang)`
- Mejorar `onerror` con reintentos automáticos
- Mejorar `onend` con reinicio automático
- Agregar logging detallado

---

### Opción B: Merge Manual (si quieres ser selectivo)

**Cambios necesarios mínimos** en el archivo actual:

**1. Agregar propiedades privadas** (después de `private wantListening = false;`):
```typescript
private lastLang: 'es' | 'en' = 'es';
private retryCount = 0;
private readonly maxRetries = 3;
private silenceTimeoutId: any = null;
```

**2. En `start()`, persiste lenguaje y resetea reintentos** (antes de `this.wantListening = true;`):
```typescript
this.lastLang = lang;
this.retryCount = 0;
```

**3. En `onerror`, reemplaza el caso `'no-speech'`**:
```typescript
case 'no-speech':
    if (this.wantListening && this.retryCount < this.maxRetries) {
        this.retryCount++;
        const delayMs = 300 + this.retryCount * 200;
        
        console.log('[SpeechRecognition] no-speech detectado, reintentando...', {
            attempt: this.retryCount,
            delayMs,
            language: lang
        });

        this.error.set(`Sin voz detectada (reintentando ${this.retryCount}/${this.maxRetries})...`);

        setTimeout(() => {
            if (this.wantListening && !this.listening()) {
                console.log('[SpeechRecognition] ejecutando reintento #', this.retryCount);
                // Aquí necesitas reiniciar, así que extrae la lógica de `start()` a un método privado
                this.restartRecognition();
            }
        }, delayMs);
    } else {
        this.error.set('No se detectó voz. Intenta de nuevo.');
    }
    break;
```

**4. En `onend()`, reemplaza completamente** (para reiniciar si `wantListening=true`):
```typescript
rec.onend = () => this.ngZone.run(() => {
    console.log('[SpeechRecognition] onend evento', {
        wantListening: this.wantListening,
        wasListening: this.listening(),
        retryCount: this.retryCount
    });

    if (this.wantListening && this.retryCount < this.maxRetries) {
        setTimeout(() => {
            if (this.wantListening && !this.listening()) {
                console.log('[SpeechRecognition] reiniciando después de onend...');
                this.restartRecognition();
            }
        }, 200);
    } else {
        this.listening.set(false);
        this.interim.set('');
        this.recognition = null;
    }
});
```

**5. En `stop()`, resetea reintentos y limpia timer** (después de `this.wantListening = false;`):
```typescript
this.retryCount = 0;
if (this.silenceTimeoutId) {
    clearTimeout(this.silenceTimeoutId);
    this.silenceTimeoutId = null;
}
```

**6. Agregar método privado** (para evitar duplicar lógica de creación):
```typescript
private restartRecognition(): void {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new Ctor();
    rec.lang = this.lastLang === 'es' ? 'es-MX' : 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Reasigna los event handlers aquí...
    rec.onresult = (ev: any) => { /* ... */ };
    rec.onerror = (ev: any) => { /* ... */ };
    rec.onend = () => { /* ... */ };

    this.recognition = rec;
    this.listening.set(true);
    try { rec.start(); } catch {
        this.listening.set(false);
        this.error.set('No se pudo iniciar el micrófono.');
    }
}
```

---

## Paso 3: Prueba Inmediata

### Test 1: Verifica que no hay errores de compilación
```bash
# Terminal
ng serve
```

Deberías ver:
```
✅ Compiled successfully
```

Si hay errores, verifica que la clase importa correctamente en `text-avatar.component.ts`.

---

### Test 2: Prueba Básica
```
1. Abre la aplicación en Chrome/Edge
2. Presiona 🎤 Hablar
3. Habla: "Hola"
4. Abre F12 → Console
5. Verifica logs
```

**Esperado en console**:
```
[SpeechRecognition] iniciando escucha { lang: 'es', wantListening: true }
[SpeechRecognition] rec.start() ejecutado exitosamente
[SpeechRecognition] onresult event { ... isFinal: true }
[SpeechRecognition] final transcript: "Hola"
```

---

### Test 3: Pausa Larga (CRÍTICO)
```
1. Presiona 🎤 Hablar
2. Habla: "Primera parte"
3. Pausa COMPLETA > 8 segundos
4. Observa el botón
5. Habla: "Segunda parte"
```

**Esperado ANTES de la solución**:
```
❌ Error "No se detectó voz"
❌ Botón vuelve a "🎤 Hablar"
❌ Usuario debe presionar nuevamente
```

**Esperado DESPUÉS de la solución**:
```
✅ Error: "Sin voz detectada (reintentando 1/3)..."
✅ Botón sigue en "🔴 Escuchando..."
✅ Se reinicia automáticamente
✅ Usuario puede seguir hablando
```

Verifica en console:
```
[SpeechRecognition] no-speech detectado, reintentando...
[SpeechRecognition] ejecutando reintento # 1
[SpeechRecognition] rec.start() ejecutado exitosamente
[SpeechRecognition] final transcript: "Segunda parte"
✅ Funciona!
```

---

### Test 4: Modo Conversación Continua
```
1. Presiona ☑️ Conversación continua
2. Presiona 🎤 Hablar
3. Habla: "¿Hola cómo estás?"
4. Espera respuesta LLM y TTS
5. Verifica que reinicia automáticamente
```

**Esperado**:
```
✅ "Escuchando..." se reinicia después de que termina el avatar de hablar
✅ Puedes hacer 2-3 preguntas sin presionar el botón
✅ En F12 → Console ves los reintentos automáticos
```

---

## Paso 4: Debugging Avanzado

Si aún hay problemas, abre F12 → Console y ejecuta este script para monitoreo en tiempo real:

```javascript
// Monitoreo STT en tiempo real
const sttLogs = [];
const originalLog = console.log;
const originalWarn = console.warn;

console.log = function(...args) {
    if (args[0]?.includes?.('[SpeechRecognition]')) {
        sttLogs.push({ type: 'log', time: new Date().toISOString(), msg: args });
    }
    originalLog.apply(console, args);
};

console.warn = function(...args) {
    if (args[0]?.includes?.('[SpeechRecognition]')) {
        sttLogs.push({ type: 'warn', time: new Date().toISOString(), msg: args });
    }
    originalWarn.apply(console, args);
};

// Ver logs recolectados
window.getSttLogs = () => {
    console.table(sttLogs.map(l => ({ 
        time: l.time, 
        type: l.type, 
        msg: JSON.stringify(l.msg) 
    })));
};

console.log('✅ STT Monitoring activo. Usa: window.getSttLogs()');
```

Luego ejecuta `window.getSttLogs()` para ver tabla completa.

---

## Paso 5: Validar Flujo Completo

### Flujo Manual (sin LLM)
```
1. Escribe texto en el textarea
2. Presiona "▶️ Speak"
3. Avatar habla
4. Verifica lipsync correcto
```

**Nota**: Esto no usa STT, solo para validar que TTS funciona.

---

### Flujo Conversación (con LLM y STT)
```
1. Presiona 🎤 Hablar
2. Habla: "¿Hola qué tal?"
3. Verifica en F12:
   - [STT] Final transcript received: "¿Hola qué tal?"
   - [LLM] Enviando transcript a proveedor
   - [LLM] Reply received
4. Avatar responde
5. Verifica que se reinicia automáticamente si autoListen=true
```

---

## Paso 6: Validar Casos Edge

### Case 1: Micrófono Bloqueado
```
1. Rechaza el permiso de micrófono
2. Verifica error: "Permiso de micrófono denegado"
3. Verificar que wantListening se pone false
```

**En console esperado**:
```
[SpeechRecognition] onerror { error: 'not-allowed', wantListening: false }
```

---

### Case 2: Cambiar Idioma Mid-Escucha
```
1. Presiona 🎤 Hablar (en Español)
2. Después 0.5s, cambia idioma a English
3. Presiona Stop/Hablar nuevamente
```

**Esperado**: Usar el idioma new sin errores

---

### Case 3: Silencio Completo > 12s
```
1. Presiona 🎤 Hablar
2. No digas NADA por 15 segundos
3. Observa si se reinicia automáticamente
```

**Con el timer de silencio**:
```
[SpeechRecognition] silencio prolongado (>12s), reintentando...
```

---

## Paso 7: Verificar Logs Clave

Después de implementar, verifica estos logs específicos en diferentes escenarios:

| Escenario | Log Esperado | Significa |
|-----------|--------------|-----------|
| Inicio | `iniciando escucha { lang: 'es' }` | ✅ Start correcto |
| Hablar | `interim transcript: "..."` | ✅ Input capturado |
| Finalizar frase | `final transcript: "..."` | ✅ Frase detectada |
| Error no-speech | `no-speech detectado, reintentando... { attempt: 1 }` | ✅ Auto-reintentos activos |
| Reinicio tras error | `ejecutando reintento # 1` | ✅ Reintento en progreso |
| API se cierra | `onend evento { wantListening: true }` | ✅ Reiniciará automáticamente |
| Parada intencional | `deteniendo escucha` + `wantListening: false` | ✅ Stop correcto |

---

## Troubleshooting Rápido

### Problema: "No se detectó voz" sin reintentos
**Causa**: No aplicaste los cambios correctamente
**Solución**: 
- Verifica que `lastLang` y `retryCount` están definidas
- Verifica que `onerror` tiene el bloque `if (this.wantListening && this.retryCount < this.maxRetries)`
- Limpia caché: Ctrl+Shift+Delete → Clear all time

---

### Problema: Se reinicia infinitamente
**Causa**: `wantListening` no se pone false después de stop
**Solución**: 
- Verifica `stop()` establece `this.wantListening = false;`
- Verifica `maxRetries = 3` para limitar reintentos

---

### Problema: Idioma incorrecto en reintentos
**Causa**: `lastLang` no se persiste correctamente
**Solución**: 
- Verifica `this.lastLang = lang;` en `start()`
- Verifica que los reintentos usan `this.lastLang`

---

### Problema: Timer de silencio interrumpe conversación
**Causa**: 12 segundos es muy poco para conversaciones largas
**Solución**: 
- Ajusta en `setupRecognitionEvents` → `12000` a valor mayor (ej: `20000` para 20s)
- O desactiva si tienes tiempo: comentar el bloque `silenceTimeoutId = setTimeout(...)`

---

## Checklist Final

- [ ] Copié `SPEECH_RECOGNITION_SERVICE_MEJORADO.ts` o apliqué cambios manuales
- [ ] No hay errores de compilación en `ng serve`
- [ ] Console muestra `[SpeechRecognition]` logs
- [ ] Test 1: Conversación simple funciona
- [ ] Test 2: Pausa > 8s se reinicia automáticamente
- [ ] Test 3: Error "not-allowed" se maneja correctamente
- [ ] Test 4: autoListen se reinicia después de TTS
- [ ] Modo conversación continua funciona

---

## Próximos Pasos (Opcional)

1. **Agregar métrica de confianza**: Mostrar % confianza de transcripción
2. **Agregar visual de silencio**: Indicador de volumen/sonido detectado
3. **Historial de transcritos**: Guardar intentos fallidos para debugging
4. **Fallback manual**: Si reintentos agotan, ofrecer opción de regresar a escritura manual
5. **Análisis de performance**: Medir latencia STT vs LLM vs TTS

---

## Recursos Útiles

- [MDN Web Speech API Docs](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API)
- [Web Speech API Events](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)
- Limitaciones conocidas:
  - Chrome: timeout ~8s sin sonido
  - Firefox: no soporta Web Speech API
  - Safari: soporte limitado
  - Mobile: requiere HTTPS en algunos browsers
