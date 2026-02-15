# 🎤 Integración de Lipsync con Text-to-Speech

## Resumen Ejecutivo

Este documento describe la estrategia para integrar sincronización de labios (lipsync) animada por voz en avatares Ready Player Me. El objetivo es simular interacción consciente en tiempo real, permitiendo que los avatares "hablen" a partir de texto con sincronización precisa entre audio y movimiento facial.

---

## 📋 Estado Actual del Sistema

### Tecnologías Implementadas

#### ✅ Avatares Ready Player Me
- **Formato**: GLB/GLTF con parámetro `?morphTargets=ARKit&textureAtlas=1024`
- **52 ARKit Blendshapes disponibles** en meshes:
  - `Wolf3D_Head` - Cabeza principal
  - `Wolf3D_Teeth` - Dientes
  - `Wolf3D_Beard` - Barba (opcional)
  - `Wolf3D_Avatar` - Mesh general

#### ✅ MediaPipe Face Tracking
- **468 landmarks faciales** en 3D
- **52 blendshapes ARKit** detectados en tiempo real
- **Latencia**: ~25-35ms (excelente para lipsync)
- **GPU acceleration** activa

#### ✅ Arquitectura Angular con Signals
- Servicios reactivos con `WritableSignal`
- Renderizado Three.js fuera de `NgZone` (60fps sin change detection)
- Aplicación directa de blendshapes a `morphTargetInfluences`

### Blendshapes de Boca Disponibles

Los siguientes blendshapes ARKit están disponibles para lipsync:

- `jawOpen` - Apertura de mandíbula
- `mouthClose` - Cierre de boca
- `mouthFunnel` - Boca en embudo (sonido "O")
- `mouthPucker` - Boca fruncida (beso)
- `mouthSmileLeft` / `mouthSmileRight` - Sonrisa
- `mouthFrownLeft` / `mouthFrownRight` - Ceño
- `mouthLeft` / `mouthRight` - Movimiento lateral
- `mouthUpperUpLeft` / `mouthUpperUpRight` - Labio superior arriba
- `mouthLowerDownLeft` / `mouthLowerDownRight` - Labio inferior abajo
- `mouthStretchLeft` / `mouthStretchRight` - Estiramiento
- `mouthRollLower` / `mouthRollUpper` - Roll de labios
- `mouthShrugLower` / `mouthShrugUpper` - Encogimiento
- `mouthDimpleLeft` / `mouthDimpleRight` - Hoyuelos
- `mouthPressLeft` / `mouthPressRight` - Presión de labios

---

## 🎯 Opciones de Text-to-Speech

### Opción 1: Azure Cognitive Services (⭐ RECOMENDADA)

#### Ventajas
- ✅ **Visemes automáticos nativos** (22 IDs mapeados a fonemas IPA)
- ✅ **Blend shapes ARKit** en formato JSON @ 60 FPS
- ✅ **Evento `VisemeReceived`** con timestamps precisos
- ✅ **SDK TypeScript oficial**: `microsoft-cognitiveservices-speech-sdk`
- ✅ **Latencia optimizada** para streaming real-time
- ✅ **Español**: múltiples voces regionales (es-MX, es-ES, es-AR, etc.)

#### Pricing
- **Free Tier**: 500k caracteres/mes (Neural voices)
- **Pay-as-you-go**: $15 / 1M caracteres (Neural)
- **Neural HD**: $48 / 1M caracteres

#### Integración
```typescript
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

const synthesizer = new sdk.SpeechSynthesizer(config);

synthesizer.visemeReceived = (s, e) => {
  // e.VisemeId: 0-21
  // e.AudioOffset: timestamp en ticks
  // e.Animation: blend shapes JSON @ 60 FPS
  const blendshapes = mapVisemeToARKit(e.VisemeId);
  applyToAvatar(blendshapes, e.AudioOffset);
};

synthesizer.speakTextAsync(text);
```

#### Mapeo de Visemes Azure → ARKit

| Viseme ID | Fonema | ARKit Blendshapes |
|-----------|--------|-------------------|
| 0 | Silencio | `{}` |
| 1 | AA/AH | `{jawOpen: 0.7}` |
| 6 | IY/IH | `{mouthSmileLeft: 0.5, mouthSmileRight: 0.5}` |
| 7 | UW | `{mouthPucker: 0.6, mouthFunnel: 0.4}` |
| 13 | F/V | `{mouthUpperUpLeft: 0.6, mouthUpperUpRight: 0.6}` |
| 19 | OW | `{mouthFunnel: 0.7, jawOpen: 0.3}` |

*(Mapeo completo disponible en documentación de Azure)*

---

### Opción 2: ElevenLabs + Rhubarb Lip Sync

#### Ventajas
- ✅ **Calidad de voz ★★★★★** (mejor del mercado)
- ✅ **Streaming real-time** excelente
- ✅ **Voice cloning** disponible
- ✅ **Español** con calidad ultra-natural

#### Desventajas
- ⚠️ **NO provee visemes** directamente
- ⚠️ **Requiere pipeline 2 pasos**: TTS → Audio → Rhubarb → Visemes

#### Pricing
- **Free**: 10k caracteres/mes
- **Creator**: $22/mes (100k caracteres)
- **Pro**: $99/mes (500k caracteres)

#### Pipeline de Integración
```bash
# 1. Generar audio con ElevenLabs
curl -X POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id} \
  -H "Content-Type: application/json" \
  -d '{"text": "Hola mundo", "model_id": "eleven_multilingual_v2"}' \
  --output audio.mp3

# 2. Procesar con Rhubarb Lip Sync
rhubarb -f json audio.mp3 -o visemes.json

# 3. Cargar JSON en frontend y sincronizar
```

**Rhubarb Lip Sync**:
- Offline phoneme extraction desde audio
- Genera mouth shapes: A, B, C, D, E, F, G, H, X (9 poses)
- Gratuito y open source
- Requiere post-procesamiento

---

### Opción 3: AWS Polly

#### Ventajas
- ✅ **Speech Marks** con viseme IDs y timestamps
- ✅ **Free tier generoso**: 1M caracteres/mes (Neural)
- ✅ **Múltiples tipos de voces** (Standard, Neural, Generative)

#### Desventajas
- ⚠️ **Formato de visemes diferente** a ARKit (requiere mapeo manual)
- ⚠️ **Streaming limitado**
- ⚠️ **Configuración AWS** más compleja

#### Pricing
- **Free Tier** (12 meses): 1M caracteres/mes (Neural)
- **Pay-as-you-go**: $16 / 1M caracteres (Neural)

---

## 🏗️ Arquitectura de Implementación

### 1. Nuevo Servicio: `tts-lipsync.service.ts`

```typescript
@Injectable({ providedIn: 'root' })
export class TTSLipsyncService {
  private audioContext: AudioContext;
  private currentSource: AudioBufferSourceNode | null = null;
  private visemeTimeline: LipsyncFrame[] = [];

  // Stream de visemes con timestamps
  speak(text: string): Observable<AudioPlaybackState> {
    // 1. Call Azure TTS API
    // 2. Receive audio + visemes
    // 3. Schedule visemes based on audio.currentTime
    // 4. Emit events to FaceTrackingService
  }

  // Mapeo de viseme ID → ARKit blendshapes
  mapVisemeToARKit(visemeId: number): Record<string, number> {
    const mapping = {
      0: {}, // Silence
      1: { jawOpen: 0.7 }, // AA
      6: { mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }, // IY
      // ... resto del mapeo
    };
    return mapping[visemeId] || {};
  }

  // Interpolación suave entre visemes
  interpolateVisemes(
    current: Record<string, number>,
    next: Record<string, number>,
    progress: number
  ): Record<string, number> {
    // Linear interpolation para transiciones suaves
  }
}

interface LipsyncFrame {
  time: number; // Timestamp en ms
  visemeId: number;
  blendshapes: Record<string, number>;
}
```

### 2. Extensión de `face-tracking.service.ts`

```typescript
export class FaceTrackingService {
  // Señales existentes
  blendshapes: WritableSignal<any[]> = signal([]);
  rotation: WritableSignal<any> = signal(null);
  landmarks: WritableSignal<any[]> = signal([]);
  isTracking: WritableSignal<boolean> = signal(false);

  // 🆕 Nuevas señales para audio-driven
  audioBlendshapes: WritableSignal<any[]> = signal([]);
  isAudioDriven: WritableSignal<boolean> = signal(false);
  audioText: WritableSignal<string> = signal('');

  setAudioBlendshapes(blendshapes: any[]) {
    this.audioBlendshapes.set(blendshapes);
  }

  enableAudioMode(enabled: boolean) {
    this.isAudioDriven.set(enabled);
  }
}
```

### 3. Modificación de `avatar-viewer.component.ts`

```typescript
private applyFaceTracking(parts: Record<string, any>) {
  const isAudioDriven = this.trackService.isAudioDriven();
  
  if (isAudioDriven) {
    // Modo audio: solo blendshapes de audio para boca
    const audioBlendshapes = this.trackService.audioBlendshapes();
    const faceBlendshapes = this.trackService.blendshapes();
    
    // Filtrar blendshapes de boca del face tracking
    const nonMouthBlendshapes = faceBlendshapes.filter(bs => 
      !bs.categoryName.startsWith('mouth') && 
      !bs.categoryName.startsWith('jaw')
    );
    
    // Merge: ojos/cejas del tracker + boca del audio
    const mergedBlendshapes = [...nonMouthBlendshapes, ...audioBlendshapes];
    
    this.applyBlendshapesToMeshes(mergedBlendshapes);
  } else {
    // Modo normal: face tracking completo
    const blendshapes = this.trackService.blendshapes();
    this.applyBlendshapesToMeshes(blendshapes);
  }
  
  // Mantener rotación de cabeza siempre del tracker
  const rotation = this.trackService.rotation();
  if (rotation && parts['Head']) {
    parts['Head'].rotation.set(rotation.x, rotation.y, rotation.z);
  }
}
```

### 4. UI de Control en `live.component.html`

```html
<div class="tts-control-panel">
  <h3>🎤 Text-to-Speech</h3>
  
  <textarea 
    [(ngModel)]="ttsText" 
    placeholder="Escribe el texto que el avatar dirá..."
    rows="3">
  </textarea>
  
  <select [(ngModel)]="selectedVoice">
    <option value="es-MX-DaliaNeural">Dalia (MX - Mujer)</option>
    <option value="es-MX-JorgeNeural">Jorge (MX - Hombre)</option>
    <option value="es-ES-ElviraNeural">Elvira (ES - Mujer)</option>
  </select>
  
  <button (click)="speakText()" [disabled]="isSpeaking">
    {{ isSpeaking ? '🔊 Hablando...' : '▶️ Hablar' }}
  </button>
  
  <button (click)="stopSpeech()" [disabled]="!isSpeaking">
    ⏹️ Detener
  </button>
  
  <div class="debug-viseme" *ngIf="currentViseme">
    Viseme actual: {{ currentViseme }}
  </div>
</div>
```

### 5. Componente TypeScript `live.component.ts`

```typescript
export class LiveComponent {
  ttsText = '';
  selectedVoice = 'es-MX-DaliaNeural';
  isSpeaking = false;
  currentViseme = '';
  
  private ttsService = inject(TTSLipsyncService);
  private trackService = inject(FaceTrackingService);

  speakText() {
    if (!this.ttsText.trim()) return;
    
    this.isSpeaking = true;
    this.trackService.enableAudioMode(true);
    
    this.ttsService.speak(this.ttsText, this.selectedVoice).subscribe({
      next: (state) => {
        this.currentViseme = state.currentViseme;
        this.trackService.setAudioBlendshapes(state.blendshapes);
      },
      complete: () => {
        this.isSpeaking = false;
        this.trackService.enableAudioMode(false);
        this.currentViseme = '';
      },
      error: (err) => {
        console.error('TTS error:', err);
        this.isSpeaking = false;
        this.trackService.enableAudioMode(false);
      }
    });
  }

  stopSpeech() {
    this.ttsService.stop();
    this.isSpeaking = false;
    this.trackService.enableAudioMode(false);
  }
}
```

---

## ⚙️ Calibración de Visemes

### Pesos Recomendados

Para evitar animaciones exageradas, usar pesos calibrados (0.5-0.8) en lugar de máximo (1.0):

```typescript
const VISEME_WEIGHTS = {
  jawOpen: 0.7,        // Apertura mandíbula
  mouthFunnel: 0.6,    // Boca en O
  mouthPucker: 0.65,   // Beso
  mouthSmile: 0.5,     // Sonrisa
  mouthStretch: 0.7,   // Estiramiento
  mouthUpperUp: 0.6,   // Labio superior
  mouthLowerDown: 0.6, // Labio inferior
};
```

### Interpolación entre Visemes

Para evitar "snapping" entre poses, implementar interpolación:

```typescript
function interpolateVisemes(
  current: Record<string, number>,
  next: Record<string, number>,
  progress: number // 0.0 a 1.0
): Record<string, number> {
  const result: Record<string, number> = {};
  
  // Combinar todas las keys
  const allKeys = new Set([
    ...Object.keys(current),
    ...Object.keys(next)
  ]);
  
  allKeys.forEach(key => {
    const currentVal = current[key] || 0;
    const nextVal = next[key] || 0;
    result[key] = currentVal + (nextVal - currentVal) * progress;
  });
  
  return result;
}
```

---

## 📊 Timeline de Sincronización

### Flujo de Ejecución

```
1. Usuario ingresa texto
   ↓
2. Llamada a Azure TTS API (~200-500ms)
   ↓
3. Recepción de audio + visemes
   ↓
4. Web Audio API playback inicia (t=0)
   ↓
5. RAF loop monitorea audio.currentTime
   ↓
6. Aplicar viseme según timestamp (±5ms precision)
   ↓
7. Interpolación con siguiente viseme (-16ms anticipación)
   ↓
8. Render frame (16.67ms @ 60fps)
   ↓
9. Finaliza audio → reset audioMode
```

### Latencia Total Estimada

| Etapa | Tiempo |
|-------|--------|
| API Request (Azure) | ~200-500ms |
| Audio decode | ~10-20ms |
| Visual application | <5ms |
| **Total inicial** | **~215-525ms** |
| **Audio→Visual sync** | **<10ms** ✅ |

La latencia inicial es aceptable para interacción (usuario escribe y espera). La sincronización audio-visual es **imperceptible** (<10ms).

---

## 🎯 Checklist de Implementación

### Fase 1: Setup Básico
- [ ] Instalar `microsoft-cognitiveservices-speech-sdk`
- [ ] Crear cuenta Azure y obtener Speech API key
- [ ] Crear `tts-lipsync.service.ts` con método `speak()`
- [ ] Extender `FaceTrackingService` con signals audio

### Fase 2: Integración
- [ ] Modificar `avatar-viewer.component.ts` para hybrid mode
- [ ] Modificar `ar-mask.component.ts` para hybrid mode
- [ ] Crear UI de control TTS en `live.component.html`
- [ ] Implementar mapeo viseme → ARKit

### Fase 3: Refinamiento
- [ ] Calibrar pesos de blendshapes
- [ ] Implementar interpolación suave
- [ ] Agregar manejo de errores
- [ ] Optimizar latencia con pre-load

### Fase 4: Testing
- [ ] Probar con frases cortas/largas
- [ ] Verificar sincronización en diferentes velocidades
- [ ] Probar con múltiples voces
- [ ] Validar en móvil y desktop

---

## 🚀 Alternativas Futuras

### Streaming Real-time
Implementar streaming de audio para reducir latencia inicial:
- Azure soporta `SpeechSynthesisOutputFormat` con chunking
- Iniciar playback antes de recibir audio completo
- Latencia reducida a ~50-100ms

### Voice Cloning
Usar ElevenLabs para crear voz personalizada:
- Upload 1-2 minutos de audio de voz objetivo
- Generar voice model en <1 hora
- Integrar con pipeline Rhubarb

### Speech Recognition Bidireccional
Combinar TTS con STT (Speech-to-Text) para diálogo:
- Usuario habla → Azure STT → Procesar respuesta → TTS avatar
- Crear conversaciones interactivas con IA

---

## 📚 Referencias

### Documentación Oficial
- [Azure Speech SDK for JavaScript](https://learn.microsoft.com/en-us/javascript/api/microsoft-cognitiveservices-speech-sdk/)
- [Azure Speech Visemes](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-speech-synthesis-viseme)
- [ARKit Blend Shapes](https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation)
- [Ready Player Me Avatar API](https://docs.readyplayer.me/ready-player-me/api-reference/avatars)

### Recursos Adicionales
- [Rhubarb Lip Sync](https://github.com/DanielSWolf/rhubarb-lip-sync)
- [ElevenLabs API Docs](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)

---

## 📝 Notas de Implementación

### Consideraciones de Performance
- **RAF loop adicional**: El lip sync agrega un loop de timing pero no afecta renderizado Three.js
- **Memory management**: Liberar AudioBuffer después de playback
- **Cache de visemes**: Considerar cachear audio+visemes para frases repetidas

### Edge Cases
- **Sin internet**: Implementar fallback a silencio con cierre de boca
- **API timeout**: Timeout de 10s en request, mostrar error
- **Cambio de avatar durante speech**: Pausar audio, resetear estado

### Compatibilidad
- **Navegadores**: Chrome, Edge, Firefox (Web Audio API universal)
- **Móvil**: iOS Safari y Android Chrome soportados
- **Hardware**: GPU requerida para MediaPipe (ya implementado)

---

**Documento creado**: 15 de febrero de 2026  
**Autor**: Sistema de documentación técnica  
**Versión**: 1.0
