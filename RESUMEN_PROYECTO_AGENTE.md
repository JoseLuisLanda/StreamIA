# Resumen del Proyecto (contexto para un agente de IA)

> Propósito: dar a un agente de IA (o a un desarrollador nuevo) el modelo mental
> completo del sistema para colaborar en **planeación, decisiones técnicas y tareas
> administrativas**. El foco actual del proyecto es: **soportar varios *tipos* de
> asistente bajo un mismo código, diferenciados solo por configuración.**
>
> Última revisión: 2026-06-27. Documentos hermanos más extensos: `AGENT_CONTEXT.md`
> y `APP_CONTEXT_SUMMARY.md` (este resumen los consolida y añade el enfoque multi-asistente,
> costos y cuotas).

---

## 1. Qué es

Plataforma **web de avatares IA habladores (AR/VR + IA)**. La superficie principal
es el **"Text-Avatar"**: un avatar 3D que responde preguntas desde una base de
conocimiento por asistente (**RAG — retrieval-augmented generation**) y habla la
respuesta con **TTS + lip-sync + gestos** en tiempo real. El mismo stack de render
soporta además un modo **AR con face-tracking** por cámara.

Cada **asistente** es una persona de marca (p. ej. AlexIA, Pastor-IA/Christ-IAN,
JosIA, MarIA) con su propio avatar 3D, voz, prompt de persona y un **namespace RAG
aislado**. Idioma primario **español**, secundario **inglés**. Todo corre en web
(SPA Angular + Firebase); no hay app nativa.

Proyecto Firebase único: **`strimearia`** (Auth, Firestore, Storage, Cloud Functions).

---

## 2. El objetivo actual: multi-asistente bajo un mismo código

Esto **ya está parcialmente implementado** y es la base sobre la que trabajaremos.
La diferenciación entre asistentes NO se hace con código por asistente, sino con un
documento de configuración `assistants/{id}` que el mismo código interpreta en runtime.

El "tipo" de un asistente emerge de combinar campos de `AssistantConfig`
(`src/app/lib/rag/rag.models.ts`):

- **Conocimiento:** `knowledgeMode` = `rag_only` (solo chunks recuperados) | `hybrid`
  (chunks si superan umbral, si no usa entrenamiento, marcado) | `training_only`
  (sin recuperación). `relevanceThreshold` ajusta el umbral del modo híbrido.
- **Comportamiento de catálogo:** `categoryExplore` (true para catálogos tipo Grabovoi:
  una petición general lista los nombres de la categoría y pregunta cuál; una específica
  devuelve el código verbatim). Esta es la palanca clave para "tipos" de asistente distintos.
- **Persona / tono:** `systemPrompt` (lo lee chatRag server-side; el cliente no puede
  manipularlo). No relaja el contrato grounded/body-only.
- **Modelos LLM:** `llmProfileId` + overrides por etapa `summaryProfileId` / `detailProfileId`
  (resumen y detalle pueden usar modelos distintos).
- **Contenido conversacional:** flags `useCustomResponses` (greetings, infoAcknowledgements,
  farewells, suggestedPrompts, capabilities) que eligen subcolección propia vs. defaults globales.
- **Intent:** `greetingKeywords`, `farewellKeywords`, `queryVerbs` (se fusionan con los globales).
- **Capacidades:** `capabilities.answer` (respuesta pre-escrita, sin chatRag) o `promptTemplate`.
- **Presentación:** `name`, `role`, `description`, `avatarId`, `voice`, `language`,
  `thumbnail`, `topicTag`, gestos `leadGestureId`/`tailGestureId`, `allowAvatarSwitch`,
  `enabled` (visible en el selector público), `activationCommand` (wake phrase).
- **Versionado:** `schemaVersion` (migraciones ordenadas en `lib/rag/assistant-schema.ts`,
  versión actual **4**). Al leer un doc se aplican las migraciones más nuevas que su versión.

**Implicación para planeación:** añadir un nuevo "tipo" de asistente debería significar
(a) extender `AssistantConfig` con flags/campos nuevos, (b) bumpear `ASSISTANT_SCHEMA_VERSION`
y agregar un `MigrationStep`, (c) honrar el nuevo campo en chatRag/intent/contenido, y
(d) exponerlo en el Assistant Manager. Evitar ramas de código por-asistente: todo debe
quedar dirigido por config.

---

## 3. Stack tecnológico

**Frontend**
- **Angular 21** — componentes standalone, **signals/computed/effect**, **zoneless**
  (`provideZonelessChangeDetection`), templates/estilos inline, rutas lazy. Tema oscuro/violeta.
- **Three.js 0.182** — avatares `.glb` (estilo ReadyPlayer Me, blendshapes **ARKit-52**),
  `GLTFLoader`, driven por morph targets (no por cámara en modo Text-Avatar).
- **@mediapipe/tasks-vision** — FaceLandmarker/pose para el modo AR.
- **TTS:** **Piper** en navegador vía `@diffusionstudio/vits-web` (onnxruntime-web WASM)
  dentro de un **Web Worker**; ES primario, EN secundario. Voces cacheadas en OPFS.
  Fallback **Web Speech API**. WASM **mono-hilo** a propósito (sin COOP/COEP, que rompería
  Storage media).
- **STT:** Web Speech API (Chrome/Edge), con auto-retry ante el timeout implícito (~8s).
- **RxJS 7.8** (router); estado de app por signals. TypeScript 5.9. Vitest.
- **SDK Firebase JS v12 modular** (NO usar `@angular/fire`, es placeholder `0.0.0`).

**Backend / nube**
- **Firebase** (`strimearia`): Auth, Firestore, Storage, **Cloud Functions** (firebase-functions
  **v2**, Node 20, TypeScript, CommonJS).
- **Vertex AI** — embeddings `text-embedding-004` (**768 dims**) + **vector search**
  Firestore (`findNearest`, COSINE). La dimensión debe coincidir en ingesta, query e índice.
- **LLM pluggable** por perfiles: `gemini-api`, `openai`, `deepseek` (y referencias a
  ollama/anthropic en docs previos — verificar contra `functions/src/lib/llm.ts`).
  Claves en **Secret Manager**, nunca en cliente ni Firestore legible.
- **Caches cliente:** IndexedDB para avatares y contenido conversacional (read-through),
  capa en memoria encima.

**Build:** builder estándar `@angular/build:application`. Postinstall
`scripts/patch-vits-web.mjs` parchea Piper para que bundlee en navegador/worker.

---

## 4. Módulos / estructura

**Páginas (rutas, `src/app/app.routes.ts`)**

Públicas / usuario:
- `/`, `/home` — landing · `/login` · `/profile`
- `/assistants` — selector de asistentes (auth-guard) → lanza `/text-avatar?assistant=ID`
- `/text-avatar` — experiencia RAG principal (voz + texto)
- `/live`, `/ar`, `/ar-viewer`, `/ar-face-tracking` — modos AR/3D
- `/gesture-studio` — autoría de gestos

Admin (`adminGuard`, honra `enforceAdminRole`):
- `/admin` — Hub central
- `/rag-admin` — gestor de base de conocimiento (namespaces, PDFs, chunks, media)
- `/assistant-manager` — crear/editar asistentes (avatar, voz, namespace, gestos, LLM, contenido)
- `/avatar-manager` — inventario de avatares (subida GLB, visor Three.js, reporte de rig)
- `/llm-admin` — perfiles LLM globales (proveedores, modelos, claves vía Secret Manager)
- `/llm-responses` — respuestas conversacionales globales + por asistente
- `/role-admin` — gestión de roles (otorgar/revocar admin)
- **`/costos`** — modelo de costos de la plataforma (proyección por consultas/mes; ver §7)
- **`/cuotas`** — cuotas de consultas por cuenta (asignar/usar/resetear; ver §7)

**Cliente (`src/app/`)**
- `services/` — `rag-avatar.service` (llama chatRag, normaliza summary/detail/media),
  `rag-admin.service`, `conversation.service` (máquina de estados del turno),
  `tts-lipsync.service`, `gesture-player.service`, `avatar.service` (resolución central +
  cache 2 capas mem→IndexedDB→Storage), `avatar-manager.service`, `avatar-catalog.service`,
  `assistant-config.service`, `conversation-content.service`, `llm.service`,
  `image-optimization.service`, `speech-recognition.service`, `auth.service`,
  `admin.service`, `cost.service`, `quota.service`, `firebase-client.ts`.
- `lib/` — `rag/` (modelos + config + esquema/migración de asistente), `intent/` (router de
  intención), `lipsync/` (mapa de visemas, timeline, text-to-visemes), `performance/`
  (compilador de performance, split progresivo, cache de planes), `gestures/`, `motion/`,
  `conversation-content/`, `llm/`, `llm-admin/`, `avatars/`, `conversation/`, `config/`.
- `components/` — `avatar-tts` (motor de render+TTS reutilizable), `ar-mask`, `avatar-picker`,
  `avatar-viewer`, `media-gallery`, `media-overlay`, `video-preview`.
- `workers/` — `piper.worker.ts`.
- `environments/` — `ragApiBase`, `ragChatPath`, `ragMediaBucket`, `functionsRegion`, `enforceAdminRole`.

**Backend (`functions/src/`)** — exports en `index.ts`:
- `ingestDocument` — callable: PDF (Storage) → extraer (`pdf-parse`) → chunk → embed →
  `rag/{ns}/chunks/{id}` con `FieldValue.vector(...)`; reingesta borra chunks viejos.
- `api` — Express HTTP, monta `POST /chatRag` (solo autenticados): resuelve namespace,
  `findNearest`, resuelve perfil LLM, genera **summary + detail** con gestos inline + media + sources.
- `setLlmApiKey`, `testLlmConnection` — vía legacy de clave única.
- Perfiles LLM: `saveLlmProfile`, `deleteLlmProfile`, `setLlmProfileKey`, `setActiveLlmKey`,
  `deleteLlmProfileKey`, `setSystemDefaultProfile`, `testLlmProfile`, `migrateLegacyLlmConfig`.
- Roles: `bootstrapFirstAdmin`, `setUserRole`, `listUsers`.
- Contenido: `generateResponses`. Migración: `backfillAssistants`, `migrateDeepseekAliases`.
- Modelos: `listProviderModels`. Namespaces: `listNamespaces`, `createNamespace`, `deleteNamespace`.
- **Costos:** `getPricing`, `updatePricingRate`, `projectAssistantCost`.
- **Cuotas:** `allocateQuota`, `getQuota`, `resetQuotaPeriod`.
- Compartido: `lib/embeddings.ts` (`embedText`, mismo modelo/dims que el índice).

---

## 5. Experiencia Text-Avatar (núcleo)

Avatar 3D a pantalla completa con overlays glassmorphism: barra superior flotante
(nombre del asistente, estado, toggles admin), **panel de chat** derecho (burbujas con
revelado karaoke sincronizado a la voz), **panel de media relacionada** izquierdo
(historial scrollable, un carrusel por respuesta con media), **cluster inferior**
(pill de estado, controles circulares Stop↔Repeat / mic / mute, chips de prompts sugeridos,
input de mensaje), **"Ver más"** (overlay de detalle solo-texto con avatar en PiP),
**Studio admin** (editor de respuestas + modo directo) y **Ajustes** (LLM, voz, avatar, RAG, historial).

`ConversationService` es la fuente de verdad: máquina de estados
`idle → listening → sending → waiting_llm → speaking → idle`, con token de generación
cancelable. El canvas 3D **nunca se recrea** (solo resize vía ResizeObserver); el GLB,
contexto WebGL y estado persisten entre cambios de layout y swaps de avatar.

**Flujo conversacional:** router de intención (saludo/despedida/capacidades responden al
instante sin RAG; consultas van al namespace; ambiguos caen a clasificación LLM one-shot) →
playback escalonado (gesto lead-in que cubre latencia → filler de info-ack → cuerpo con TTS +
gestos inline → gesto tail). **Summary + detail:** chatRag devuelve un `summary` corto hablado
+ un `detail` largo on-demand (reusa los mismos chunk ids, sin re-embed). Modos de respuesta:
`rag`, `detail`, `capabilities`, `suggestions`.

**Historial:** `users/{uid}/conversations/{id}` (un doc por visita, creado lazy al primer
mensaje real). Solo persiste con sesión iniciada; restauración on-demand desde Ajustes.

---

## 6. Modelo de datos (Firestore / Storage)

```
rag_namespaces/{ns}                  registro de namespaces (listable)
rag/{ns}/documents/{docId}           metadata PDF + estado/ conteo de chunks
rag/{ns}/chunks/{chunkId}            texto + embedding(VectorValue) + metadata
rag/{ns}/media/{mediaId}             metadata de media doc-scoped
assistants/{id}                      AssistantConfig (avatar, ragCollection, voz/idioma,
                                     gestos, intent, perfil LLM, knowledgeMode,
                                     categoryExplore, systemPrompt, flags, schemaVersion)
  assistants/{id}/{greetings|farewells|infoAcknowledgements|suggestedPrompts}/*  contenido propio
global_responses/...                 contenido global (greetings/farewells/info-acks/prompts)
config/*                             config LLM no-secreta, ragModels defaults
llm_profiles/{id}                    perfiles de proveedor/modelo (claves NO aquí)
avatars/{id}                         catálogo de avatares (glbPath, voz, thumbnail, conformance)
users/{uid}                          registro de usuario; users/{uid}/conversations/*  historial
admins/{uid}                         allowlist admin (solo escritura server-side)
Storage: rag-docs/{ns}/*.pdf , rag-media/{ns}/* , avatars/models/*
Secret Manager: claves LLM por perfil
Índice vectorial: collection-group chunks, campo embedding, dim 768, COSINE
```

---

## 7. Capa administrativa (costos y cuotas)

- **Costos (`/costos`, `cost.service`, `functions/costing.ts`):** panel del modelo de costos
  de la plataforma (aproximado). Calculadora de proyección con input "consultas/mes"; toda la
  matemática es server-side (`projectAssistantCost`); el recálculo mensual del slider reusa el
  costo unitario por consulta devuelto (sin round-trips extra). Cubre ingesta, por consulta,
  almacenamiento e infraestructura. Tarifas editables (`updatePricingRate`, `getPricing`).
- **Cuotas (`/cuotas`, `quota.service`, `functions/quotaAdmin.ts`):** panel de cuota de
  consultas por cuenta — ver asignación/usado/ledger de cualquier usuario; `allocateQuota`,
  `getQuota`, `resetQuotaPeriod`.

Estas dos áreas son la base para tareas administrativas (presupuesto, control de uso por
asistente/cliente) que el agente puede ayudar a planear y operar.

---

## 8. Seguridad / fase dev

- Flag único **`ENFORCE_ADMIN_ROLE`** (Functions) / **`enforceAdminRole`** (cliente):
  off = cualquier usuario autenticado usa admin; on = exige rol admin (claim `role=='admin'`
  o `admins/{uid}`). Debe estar `true` en producción.
- Reglas (`firestore.rules`, `storage.rules`) actualmente **permisivas pero autenticadas**
  (nunca públicas); las reglas admin-scoped de producción están preservadas en comentarios.
- Historial de conversación siempre **owner-scoped**.
- Claves LLM/service-account solo en Secret Manager / env local; `serviceAccountKey.json`
  está git-ignored (rotar — estuvo en el historial).

---

## 9. Gotchas para un agente que trabaja aquí

1. **No se puede build/deploy en el sandbox:** `node_modules` se instaló en Windows (binarios
   esbuild/rollup de plataforma equivocada) y el registro está bloqueado. Correr `ng build` /
   `ng serve` / `firebase deploy` en la máquina del usuario. Antes de desplegar funciones:
   `cd functions && npm install && npm run build`.
2. **El mount de bash es stale / encoding raro:** `tsc`/`cat` pueden reportar errores de parseo
   falsos de todo el codebase. Confiar en Read/Grep (autoritativos).
3. **La escritura de archivos puede corromper no-ASCII** (bytes NUL / truncado en multi-byte).
   Escribir **código fuente solo-ASCII** (usar `->` no flechas, SVG inline no emoji). Verificar
   conteo de NUL con python tras escribir.
4. **Angular zoneless:** preferir signals/`computed()` sobre métodos planos para gating reactivo.
5. **La dimensión de embedding debe coincidir** (768 / `text-embedding-004`) en ingesta, query
   e índice. Si se cambia el modelo, actualizar `EMBED_DIMENSIONS` y recrear el índice.
6. **Secretos fuera de git/cliente.** Los callables nunca devuelven/loguean claves.
7. La colección es **`assistants/{id}`** (renombrada del viejo `deployments/{id}`).
8. **Diferenciar asistentes por config, no por código** (ver §2). Cualquier nuevo "tipo" debe
   pasar por `AssistantConfig` + migración de esquema + Assistant Manager.

---

## 10. Estado funcional

- Flujo Text-Avatar RAG (pantalla completa, panel de media, Stop/Repeat, summary+detail,
  Ver más, sync de contenido), gesture studio, catálogos de avatar/gestos, lip-sync/motion: **funcionando**.
- Suite admin (Hub, RAG, Assistant Manager, Avatar Manager, LLM admin, LLM responses, Role admin,
  Costos, Cuotas): **implementada y cableada**.
- `chatRag` + `ingestDocument` + demás callables: **implementados**; deploy/verificación desde
  la máquina del usuario.

---

## 11. Documentos de referencia en el repo

Contexto general: `AGENT_CONTEXT.md`, `APP_CONTEXT_SUMMARY.md`, `INDICE.md`, `RESUMEN_EJECUTIVO.md`.
Por característica: `RAG_AVATAR_README.md`, `RAG_ADMIN_README.md`, `FUNCTIONS_README.md`,
`ASSISTANT_MANAGER_README.md`, `ASSISTANTS_README.md`, `AVATAR_MANAGER_README.md`,
`AVATAR_SERVICE_README.md`, `AVATAR_CATALOG_README.md`, `LLM_PROVIDER_ADMIN_README.md`,
`LLM_PROFILES_README.md`, `LLM_RESPONSES_README.md`, `ROLE_ADMIN_README.md`,
`CONVERSATION_CONTENT_README.md`, `SUMMARY_DETAIL_README.md`, `DOC_MEDIA_README.md`,
`IMAGE_OPTIMIZATION_README.md`, `SCHEMA_MIGRATION_README.md`, `TEXT_AVATAR_INTENT_LOGIN_README.md`,
`INGESTION_SCALING.md`, `VOICE_PLAN.md`, `GESTURE_STUDIO_PLAN.md`, `lipsync.md`.
STT (referencia histórica): `ANALISIS_STT_COMPLETO.md`, `GUIA_IMPLEMENTACION_STT.md`,
`README_SOLUCION_STT.md`, `COMPARATIVA_CODIGO_ANTES_DESPUES.md`, `MIGRACION_QUIRURGICA.md`.

---

*Raíz del proyecto:* `rpm-face-tracking-angular` (Angular 21 + Firebase `strimearia`).
